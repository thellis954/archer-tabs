// archertabs.app
//
// The demo in the hero is the real extension, not a mock-up: `route` below is
// imported from /vendor/, which tools/lint.js pins byte-for-byte to
// extension/src/ - the modules Chrome actually loads. If the extension's
// behaviour changes and the site's does not, `npm run lint` fails.
//
// What the reader is told, though, is written for a person rather than a
// programmer. No verdict names, no rule numbers, no talk of classifiers: just
// "Opens Netflix" or "Asks ChatGPT". The machinery is real; the vocabulary is
// deliberately not.
//
// No scroll listeners anywhere. IntersectionObserver drives the walkthrough.

import { route, placeholderFor, NAVIGATE, SEARCH, ASK, ANSWER, NONE } from "./vendor/router.js";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------- the demo -- */

const demoInput = $("demoInput");
const demoMode = $("demoMode");
const demoSend = $("demoSend");
const demoVerdict = $("demoVerdict");
const demoTag = $("demoTag");
const demoWhat = $("demoWhat");

const AI_NAME = { chatgpt: "ChatGPT", claude: "Claude", perplexity: "Perplexity" };

/**
 * The name a person would use for a site, from its address. "netflix.com" reads
 * as Netflix; "en.wikipedia.org" as Wikipedia. Cosmetic only, and it falls back
 * to the address itself whenever the guess would be worse than the truth.
 */
function siteName(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }

  // Leave anything that is not a plain dotted domain exactly as typed. An IP
  // address, a bracketed IPv6 literal and localhost have no friendly name to
  // give them, and inventing one ("Opens Localhost") reads as a bug.
  if (!/^[a-z0-9.-]+$/i.test(host) || /^\d+\./.test(host)) return rawUrl;

  const labels = host.replace(/^www\./i, "").split(".");
  if (labels.length < 2) return rawUrl;

  // The name is the label in front of the public suffix, so wikipedia.org and
  // en.wikipedia.org both read as Wikipedia. Where the suffix is itself two
  // levels (bbc.co.uk), step back one further.
  const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);
  const beforeSuffix = labels.length - 2;
  const i = SECOND_LEVEL.has(labels[beforeSuffix]) ? beforeSuffix - 1 : beforeSuffix;
  const name = labels[i];

  if (!name || name.length < 2) return rawUrl;

  // Capitalising the first letter gets "Netflix" right and "Youtube" wrong, and
  // a brand set in the wrong case is the kind of small thing that makes a page
  // look careless. Only the handful anyone is likely to type here; everything
  // else falls back to the plain capital, which is fine for one-word names.
  const CASED = {
    youtube: "YouTube", github: "GitHub", linkedin: "LinkedIn", tiktok: "TikTok",
    chatgpt: "ChatGPT", openai: "OpenAI", whatsapp: "WhatsApp", paypal: "PayPal",
    ebay: "eBay", imdb: "IMDb", bbc: "BBC", nytimes: "NYTimes", icloud: "iCloud",
    duckduckgo: "DuckDuckGo", stackoverflow: "Stack Overflow", ycombinator: "Hacker News",
  };
  const key = name.toLowerCase();
  return CASED[key] ?? name[0].toUpperCase() + name.slice(1);
}

/** What the extension would do, said the way a person would say it. */
function describe(raw, mode) {
  // canAnswer is true so that picking "Answer right here" demonstrates the
  // mode. With it false, router.js correctly degrades it to a plain search,
  // which is right in a browser with no key and useless as an explanation.
  const verdict = route(raw, { mode, canAnswer: true });

  switch (verdict.action) {
    case NONE:
      return { state: "idle", tag: "", what: "Go ahead, type in it. This one is live.", open: null };

    case NAVIGATE:
      return { state: "url", tag: `Opens ${siteName(verdict.url)}`, what: "", open: verdict.url };

    case ASK:
      return {
        state: "prompt",
        tag: `Asks ${AI_NAME[mode]}`,
        what: `Opens ${AI_NAME[mode]} with your question already typed in.`,
        open: verdict.url,
      };

    case ANSWER:
      return {
        state: "prompt",
        tag: "Answers here",
        what: "The answer appears on the new tab itself, without opening anything.",
        open: null,
      };

    case SEARCH:
    default:
      return {
        state: "prompt",
        tag: "Searches",
        what: "Goes to whichever search engine you normally use.",
        open: null,
      };
  }
}

let pendingOpen = null;

function paintDemo() {
  const mode = demoMode.value;

  // The extension renames its own placeholder to match the destination, so the
  // box always says where the next Enter goes. Same function, same result.
  demoInput.placeholder = placeholderFor(mode, true);

  const out = describe(demoInput.value, mode);

  demoVerdict.dataset.state = out.state;
  demoTag.textContent = out.tag;

  // Everything the reader typed reaches the page through textContent. The
  // extension has the same rule for the same reason, and lint enforces it here.
  demoWhat.textContent = "";
  if (out.state === "url" && out.open) {
    demoWhat.append("Goes straight to ");
    const b = document.createElement("b");
    b.textContent = out.open;
    demoWhat.append(b, ".");
  } else {
    demoWhat.textContent = out.what;
  }

  pendingOpen = out.open;
  demoSend.disabled = !pendingOpen;
  demoSend.setAttribute(
    "aria-label",
    pendingOpen ? `Open ${pendingOpen}` : "Pick a destination above to try this one",
  );
}

if (demoInput) {
  demoInput.addEventListener("input", paintDemo);
  demoMode.addEventListener("change", paintDemo);

  $("demoForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (pendingOpen) window.open(pendingOpen, "_blank", "noopener");
  });

  for (const b of $("demoTries").querySelectorAll("button")) {
    b.addEventListener("click", () => {
      demoInput.value = b.dataset.q;
      paintDemo();
      demoInput.focus();
    });
  }

  paintDemo();
}

/* -------------------------------------------------------- the walkthrough -- */
/* Four ordinary things to type, one sticky panel. Whichever scene is nearest
   the middle of the viewport owns the panel. */

const specimen = $("specimen");
const scenes = [...document.querySelectorAll(".scene")];

if (specimen && scenes.length) {
  let current = null;

  const show = (scene) => {
    if (scene === current) return;
    current = scene;

    for (const s of scenes) s.classList.toggle("active", s === scene);

    const paint = () => {
      $("specimenText").textContent = scene.dataset.specimen;
      $("specimenBadge").textContent = scene.dataset.badge;
      $("specimenNote").textContent = scene.dataset.note;
      specimen.dataset.verdict = scene.dataset.verdict;
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint();
      return;
    }
    specimen.classList.add("swapping");
    setTimeout(() => {
      paint();
      specimen.classList.remove("swapping");
    }, 180);
  };

  const seen = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) seen.add(e.target);
        else seen.delete(e.target);
      }
      if (!seen.size) return;
      const top = [...seen].sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )[0];
      show(top);
    },
    { rootMargin: "-42% 0px -42% 0px", threshold: 0 },
  );

  for (const s of scenes) io.observe(s);
  show(scenes[0]);
}

/* ---------------------------------------------------------- furnishings -- */

// Section reveals are CSS scroll-driven animations (animation-timeline: view(),
// see style.css). They used to be an observer that set opacity to 0 and waited,
// which stranded four whole sections when it never reported. The browser owns
// the scheduling now, and anything unsupported simply renders finished.

// The nav grows a hairline once the page has moved. A sentinel plus an observer,
// rather than reading scrollY on every frame.
const sentinel = document.createElement("div");
sentinel.setAttribute("aria-hidden", "true");
sentinel.style.cssText = "position:absolute;top:0;left:0;width:1px;height:1px;";
document.body.prepend(sentinel);
new IntersectionObserver(
  ([e]) => document.querySelector(".bar").classList.toggle("stuck", !e.isIntersecting),
  { threshold: 0 },
).observe(sentinel);
