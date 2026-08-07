import { classify, EMPTY, URL_KIND, PROMPT } from "./src/classify.js";

const form = document.getElementById("searchForm");
const input = document.getElementById("query");

// Enter is handled here rather than by form submit alone, because Cmd+Enter and
// Shift+Enter do not reliably raise a submit event across platforms.
input.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    input.value = "";
    return;
  }
  if (event.key !== "Enter") return;

  event.preventDefault();
  const force = event.metaKey || event.ctrlKey ? PROMPT : event.shiftKey ? URL_KIND : null;
  go(input.value, force);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  go(input.value, null);
});

function go(raw, force) {
  const verdict = classify(raw, force);
  if (verdict.kind === EMPTY) return;

  if (verdict.kind === URL_KIND) {
    window.location.assign(verdict.url);
    return;
  }
  runSearch(verdict.text);
}

/**
 * Hands the query to whatever the user set as their default search engine.
 *
 * Using chrome.search rather than a hardcoded endpoint is both the product
 * behavior we want — with OpenAI's "ChatGPT search" extension installed the
 * default engine *is* ChatGPT — and the only Web-Store-compliant way for a new
 * tab page to run a search. See docs/ROADMAP.md §0.5 and §2.2.
 */
function runSearch(text) {
  if (globalThis.chrome?.search?.query) {
    chrome.search.query({ text, disposition: "CURRENT_TAB" });
    return;
  }
  // Only reached when newtab.html is opened as a plain file for development,
  // where the chrome.* APIs do not exist. Never runs in the packed extension.
  window.location.assign("https://www.google.com/search?q=" + encodeURIComponent(text));
}
