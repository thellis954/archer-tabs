// archertabs.app
//
// The point of this file: the site does not describe the classifier, it runs
// it. `route` and `classify` below are imported from /vendor/, which
// tools/lint.js pins byte-for-byte to extension/src/ - the modules Chrome
// actually loads. If the extension's behaviour changes and the site's does not,
// `npm run lint` fails. There is no second implementation to drift.
//
// No scroll listeners anywhere. IntersectionObserver drives the scrollytelling
// and the reveals, so nothing runs per frame.

import { route, placeholderFor, NAVIGATE, SEARCH, ASK, ANSWER, NONE } from "./vendor/router.js";
import { classify, URL_KIND, PROMPT, EMPTY } from "./vendor/classify.js";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------- the demo -- */
/* Types a string, shows what the extension would do with it, and on submit
   actually does the part a web page is allowed to do. */

const demoInput = $("demoInput");
const demoMode = $("demoMode");
const demoSend = $("demoSend");
const demoVerdict = $("demoVerdict");
const demoTag = $("demoTag");
const demoWhat = $("demoWhat");

const DESTINATION = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  perplexity: "Perplexity",
};

/** What the extension would do, in words, plus whether this page can do it. */
function describe(raw, mode) {
  // canAnswer mirrors "an API key is set" in the extension. It is true here on
  // purpose: with it false, router.js correctly degrades Answer mode to Auto,
  // so picking "Answer here" in this demo would report that the question goes
  // to your default search engine. That is the right behaviour in a browser
  // with no key and the wrong thing to show someone asking what the mode does.
  const verdict = route(raw, { mode, canAnswer: true });

  switch (verdict.action) {
    case NONE:
      return { state: "idle", tag: "Waiting", what: "Type anything. The verdict updates as you go.", open: null };

    // `what` is unused for this branch: paintDemo builds it as DOM so the
    // resolved URL lands in a textContent, never in a markup string.
    case NAVIGATE:
      return { state: "url", tag: "Go", what: "", open: verdict.url };

    case ASK:
      return {
        state: "prompt",
        tag: "Ask",
        what: `Opens ${DESTINATION[mode]} with the question already in the composer.`,
        open: verdict.url,
      };

    case ANSWER:
      return {
        state: "prompt",
        tag: "Ask",
        what: "Answered on the new tab itself, streamed from your own API key.",
        open: null,
      };

    case SEARCH:
    default:
      return {
        state: "prompt",
        tag: "Ask",
        what: "Handed to whatever you set as Chrome's default search engine.",
        open: null,
      };
  }
}

let pendingOpen = null;

function paintDemo() {
  const mode = demoMode.value;

  // The extension rewrites its placeholder to name the destination you picked,
  // so the box tells you where the next Enter goes. Same function, same result.
  demoInput.placeholder = placeholderFor(mode, true);

  const out = describe(demoInput.value, mode);

  demoVerdict.dataset.state = out.state;
  demoTag.textContent = out.tag;

  // The only string interpolated into markup is one this file built; the user's
  // input goes through textContent below. Keeps the extension's rule (never
  // turn untrusted text into an element) on the site too.
  demoWhat.textContent = "";
  if (out.open && out.state === "url") {
    demoWhat.append("Opens ");
    const b = document.createElement("b");
    b.textContent = out.open;
    demoWhat.append(b, ". Nothing is searched.");
  } else {
    demoWhat.textContent = out.what;
  }

  pendingOpen = out.open;
  demoSend.disabled = !pendingOpen;
  demoSend.setAttribute(
    "aria-label",
    pendingOpen ? `Open ${pendingOpen}` : "Nothing to open from this page",
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

/* -------------------------------------------------------- the decision --- */
/* Six rules, one sticky specimen. Whichever rule is nearest the middle of the
   viewport owns the specimen. */

const specimen = $("specimen");
const rules = [...document.querySelectorAll(".rule")];

if (specimen && rules.length) {
  let current = null;

  const show = (rule) => {
    if (rule === current) return;
    current = rule;

    for (const r of rules) r.classList.toggle("active", r === rule);

    const paint = () => {
      $("specimenText").textContent = rule.dataset.specimen;
      $("specimenNo").textContent = rule.querySelector(".ruleNo").textContent.trim();
      $("specimenRule").textContent = rule.dataset.rule;
      $("specimenNote").textContent = rule.dataset.note;
      specimen.dataset.verdict = rule.dataset.verdict;
      $("specimenBadge").textContent = rule.dataset.verdict === "url" ? "Go" : "Ask";
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      paint();
      return;
    }
    // Fade the three changing strings out, swap, fade back. The badge and the
    // rule number flip immediately so the state never reads as half-applied.
    specimen.classList.add("swapping");
    setTimeout(() => {
      paint();
      specimen.classList.remove("swapping");
    }, 180);
  };

  // A band across the middle of the viewport: the rule intersecting it wins.
  const seen = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) seen.add(e.target);
        else seen.delete(e.target);
      }
      if (!seen.size) return;
      // Topmost of the intersecting rules, so scrolling up and down agree.
      const top = [...seen].sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )[0];
      show(top);
    },
    { rootMargin: "-42% 0px -42% 0px", threshold: 0 },
  );

  for (const r of rules) io.observe(r);
  show(rules[0]);
}

/* ------------------------------------------------------------- the lab --- */
/* Same classifier, reader-driven, with the two modifier keys router.js accepts
   as `force`. */

const labInput = $("labInput");

if (labInput) {
  const labOut = $("labOut");
  const labBadge = $("labBadge");
  const labDest = $("labDest");
  const labWhy = $("labWhy");
  const forceButtons = [...document.querySelectorAll(".labForce button")];

  let force = "";

  /** The rule in classify.js that decided it. Kept in the order it applies. */
  function reason(raw, forced) {
    const value = String(raw ?? "").trim();
    if (!value) return "Nothing typed.";
    if (forced === "prompt") return "Cmd held. Treated as a question whatever it looks like.";
    if (forced === "url") return "Shift held. Treated as an address whatever it looks like.";

    if (/^https?:\/\//i.test(value)) return "It already carries an explicit http or https scheme.";
    if (/\s/.test(value)) return "It contains whitespace, and a URL never does.";
    if (/^localhost(:\d{1,5})?([/?#]|$)/i.test(value)) return "localhost is an address, so it opens over plain http.";
    if (/^\[[0-9a-f:.]+\](:\d{1,5})?([/?#]|$)/i.test(value)) return "A bracketed IPv6 literal is an address.";
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "It carries a scheme that is not http or https, which never navigates.";

    const authority = value.split(/[/?#]/, 1)[0];
    if (authority.includes("@")) return "Userinfo sits in front of the host, which is the phishing shape.";

    const host = authority.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
    const labels = host.split(".");
    if (labels.length < 2) return "There is no dot, so there is no host to go to.";
    if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(l))) {
      return "One of the labels is not a legal hostname label.";
    }

    const tld = labels[labels.length - 1].toLowerCase();
    return classify(value).kind === URL_KIND
      ? `The last label, .${tld}, is in the IANA registry of top-level domains.`
      : `The last label, .${tld}, is not a top-level domain.`;
  }

  function paintLab() {
    const raw = labInput.value;
    const verdict = classify(raw, force || null);

    labWhy.textContent = reason(raw, force);

    if (verdict.kind === EMPTY) {
      labOut.dataset.verdict = "prompt";
      labBadge.textContent = "Idle";
      labDest.textContent = "";
      return;
    }
    if (verdict.kind === URL_KIND) {
      labOut.dataset.verdict = "url";
      labBadge.textContent = "Go";
      labDest.textContent = verdict.url;
      return;
    }
    labOut.dataset.verdict = "prompt";
    labBadge.textContent = "Ask";
    labDest.textContent = verdict.text;
  }

  labInput.addEventListener("input", paintLab);

  for (const b of forceButtons) {
    b.addEventListener("click", () => {
      force = b.dataset.force;
      for (const other of forceButtons) other.classList.toggle("on", other === b);
      paintLab();
    });
  }

  for (const b of document.querySelectorAll(".labChips button")) {
    b.addEventListener("click", () => {
      labInput.value = b.dataset.q;
      paintLab();
    });
  }

  paintLab();
}

/* ---------------------------------------------------------- furnishings -- */

// Section reveals used to live here, as an IntersectionObserver that set
// opacity to 0 and waited. That is a trap: anything the observer never reports
// on stays invisible forever, and a full-page render caught it doing exactly
// that to four sections. They are CSS scroll-driven animations now
// (animation-timeline: view(), see style.css) so the browser owns the
// scheduling and unsupported browsers simply get the finished state.

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
