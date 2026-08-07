const form = document.getElementById("searchForm");
const input = document.getElementById("query");

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const value = input.value.trim();

  if (!value) return;

  // Looks like a URL
  if (looksLikeURL(value)) {

    let url = value;

    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    window.location.href = url;
    return;
  }

  // Otherwise perform a web search
  window.location.href =
    "https://www.google.com/search?q=" +
    encodeURIComponent(value);
});

function looksLikeURL(value) {

  if (/^https?:\/\//i.test(value)) {
    return true;
  }

  if (/^localhost(:\d+)?/i.test(value)) {
    return true;
  }

  return /^[^\s]+\.[^\s]+/.test(value);
}
