// Decides whether what you typed is somewhere to go or something to ask.
//
// This is the whole product in one function, so it is pure, total, and tested:
// it takes a string and returns a verdict, touching no DOM and no chrome.* API.

import { IANA_TLDS } from "./tlds.js";

export const EMPTY = "empty";
export const URL_KIND = "url";
export const PROMPT = "prompt";

const HTTP_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOCALHOST = /^localhost(:\d{1,5})?([/?#]|$)/i;
const IPV6 = /^\[[0-9a-f:.]+\](:\d{1,5})?([/?#]|$)/i;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * @param {string} raw   what the user typed
 * @param {"url"|"prompt"|null} [force]  modifier-key override
 * @returns {{kind: string, url?: string, text?: string}}
 */
export function classify(raw, force = null) {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: EMPTY };

  if (force === PROMPT) return { kind: PROMPT, text: value };
  if (force === URL_KIND) return { kind: URL_KIND, url: toURL(value) };

  if (HTTP_SCHEME.test(value)) return { kind: URL_KIND, url: value };

  // A URL never contains whitespace. This one rule kills the largest class of
  // false positives ("vue.js tutorial", "3.5 vs 4 pricing").
  if (/\s/.test(value)) return { kind: PROMPT, text: value };

  // Must precede the scheme check below: "localhost:3000" is indistinguishable
  // from a scheme by shape, and the scheme rule would reject it.
  if (LOCALHOST.test(value) || IPV6.test(value)) {
    return { kind: URL_KIND, url: "http://" + value };
  }

  // Anything else carrying a scheme is not a promise we keep. javascript:,
  // data: and file: must never reach location.href — this page is a privileged
  // extension origin, so a javascript: URL would execute *here*.
  if (ANY_SCHEME.test(value)) return { kind: PROMPT, text: value };

  const authority = value.split(/[/?#]/, 1)[0];

  // "google.com@evil.com" is a valid URL whose host is evil.com. Refusing to
  // navigate to anything with userinfo closes that phishing shape; an address
  // that genuinely needs credentials can be typed with an explicit scheme.
  if (authority.includes("@")) return { kind: PROMPT, text: value };

  if (isIPv4(authority)) return { kind: URL_KIND, url: "http://" + value };

  const host = authority.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2) return { kind: PROMPT, text: value };
  if (!labels.every((l) => HOSTNAME_LABEL.test(l))) {
    return { kind: PROMPT, text: value };
  }
  if (!IANA_TLDS.has(labels[labels.length - 1].toLowerCase())) {
    return { kind: PROMPT, text: value };
  }

  return { kind: URL_KIND, url: "https://" + value };
}

/** Scheme-relative input gets https, except the plain-http special cases. */
function toURL(value) {
  if (HTTP_SCHEME.test(value)) return value;
  const authority = value.split(/[/?#]/, 1)[0];
  if (LOCALHOST.test(value) || IPV6.test(value) || isIPv4(authority)) {
    return "http://" + value;
  }
  return "https://" + value;
}

function isIPv4(authority) {
  const host = authority.replace(/:\d{1,5}$/, "");
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every(
    (p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === "0" || !p.startsWith("0")),
  );
}
