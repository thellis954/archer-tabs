import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, EMPTY, URL_KIND, PROMPT } from "../extension/src/classify.js";

// [input, expected kind, expected resolved url (url verdicts only)]
const CASES = [
  // --- nothing ---
  ["", EMPTY],
  ["   ", EMPTY],

  // --- explicit scheme ---
  ["https://example.com", URL_KIND, "https://example.com"],
  ["http://example.com/a?b=c#d", URL_KIND, "http://example.com/a?b=c#d"],
  ["HTTPS://EXAMPLE.COM", URL_KIND, "HTTPS://EXAMPLE.COM"],

  // --- schemes that must never reach location.href ---
  ["javascript:alert(1)", PROMPT],
  ["data:text/html,<script>alert(1)</script>", PROMPT],
  ["file:///etc/passwd", PROMPT],
  ["chrome://settings", PROMPT],
  ["mailto:a@b.com", PROMPT],

  // --- the bugs that motivated this rewrite ---
  ["vue.js tutorial", PROMPT],
  ["node.js", PROMPT],
  ["3.5 vs 4 pricing", PROMPT],
  ["e.g. what is RAG", PROMPT],
  ["index.js", PROMPT],
  ["what is 2.5 + 2.5", PROMPT],

  // --- plain http hosts ---
  ["localhost", URL_KIND, "http://localhost"],
  ["localhost:3000", URL_KIND, "http://localhost:3000"],
  ["localhost:3000/api/health", URL_KIND, "http://localhost:3000/api/health"],
  ["127.0.0.1", URL_KIND, "http://127.0.0.1"],
  ["192.168.1.1:8080", URL_KIND, "http://192.168.1.1:8080"],
  ["[::1]:3000", URL_KIND, "http://[::1]:3000"],

  // --- real domains ---
  ["example.com", URL_KIND, "https://example.com"],
  ["claude.ai", URL_KIND, "https://claude.ai"],
  ["chatgpt.com/c/abc", URL_KIND, "https://chatgpt.com/c/abc"],
  ["sub.domain.co.uk", URL_KIND, "https://sub.domain.co.uk"],
  ["EXAMPLE.COM", URL_KIND, "https://EXAMPLE.COM"],
  ["example.com.", URL_KIND, "https://example.com."],
  ["example.com/path?q=1#frag", URL_KIND, "https://example.com/path?q=1#frag"],

  // --- not domains ---
  ["notatld.zzzz", PROMPT],
  ["hello", PROMPT],
  ["hello world", PROMPT],
  [".com", PROMPT],
  ["example.", PROMPT],
  ["-bad.com", PROMPT],
  ["bad-.com", PROMPT],
  ["999.999.999.999", PROMPT],
  ["1.2.3", PROMPT],

  // --- userinfo phishing shape ---
  ["google.com@evil.com", PROMPT],
  ["user:pw@example.com", PROMPT],

  // --- single label with port stays a query; type a scheme to force it ---
  ["myserver:8080", PROMPT],

  // --- whitespace trimmed, not treated as content ---
  ["  example.com  ", URL_KIND, "https://example.com"],
];

for (const [input, kind, url] of CASES) {
  test(`${JSON.stringify(input)} → ${kind}${url ? ` (${url})` : ""}`, () => {
    const got = classify(input);
    assert.equal(got.kind, kind);
    if (url !== undefined) assert.equal(got.url, url);
    if (kind === PROMPT) assert.equal(got.text, input.trim());
  });
}

test("force=prompt overrides a valid domain", () => {
  const got = classify("example.com", PROMPT);
  assert.equal(got.kind, PROMPT);
  assert.equal(got.text, "example.com");
});

test("force=url promotes a bare word to https", () => {
  assert.deepEqual(classify("intranet", URL_KIND), {
    kind: URL_KIND,
    url: "https://intranet",
  });
});

test("force=url keeps localhost on http", () => {
  assert.equal(classify("localhost:3000", URL_KIND).url, "http://localhost:3000");
});

test("force=url does not smuggle a javascript: URL through", () => {
  // The override is a user gesture, but it still must not produce a scheme
  // that executes in this origin.
  const got = classify("javascript:alert(1)", URL_KIND);
  assert.ok(!/^javascript:/i.test(got.url), `got ${got.url}`);
});

test("null and undefined are empty, not crashes", () => {
  assert.equal(classify(null).kind, EMPTY);
  assert.equal(classify(undefined).kind, EMPTY);
});
