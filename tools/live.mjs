// A *headed* Chromium with the extension loaded, on a real X display, that can
// be driven from a script and photographed whole — browser chrome included.
//
// Why this exists: everything else in tools/ and test/ drives headless Chromium,
// and headless cannot show you three things that turned out to matter.
//
//   1. The browser chrome. The extension's icon in the toolbar, its entry in
//      chrome://extensions, the tab favicon. The icons in this repo shipped
//      blank for the project's whole life; no headless check could have caught
//      that, because headless never draws a toolbar.
//   2. Native dialogs. `chrome.permissions.request()` opens one, and headless
//      never resolves the promise — which is why every granted-permission test
//      needs a fixture that skips the consent step. Here the dialog is real and
//      can be clicked.
//   3. The real new tab. `chrome://newtab` going through `chrome_url_overrides`,
//      with Chrome's own attribution footer and pre-render behaviour, rather
//      than the extension page loaded by URL.
//
// Requires (installed with apt): Xvfb, openbox, xwd, ImageMagick, xdotool.
//
//   npm run live                  -- open it and photograph the new tab
//   npm run live -- --url chrome://extensions --shot ext
//   npm run live -- --keep        -- leave the browser running to drive further
//
// The screen is captured with `xwd` on the X root window, so what lands in
// shots/live-*.png is the whole screen exactly as a person would see it.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");
const OUT = join(ROOT, "shots");
const PROFILE = "/tmp/archer-live-profile";

const DISPLAY = process.env.ARCHER_DISPLAY ?? ":99";
const SCREEN = process.env.ARCHER_SCREEN ?? "1600x1000x24";
const DEBUG_PORT = 9222;

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? true);
};
const has = (name) => args.includes(`--${name}`);

const url = flag("url", "chrome://newtab");
const name = flag("shot", "newtab");
const keep = has("keep");

// --- the display -----------------------------------------------------------------

const running = (pattern) => {
  try {
    execFileSync("pgrep", ["-f", pattern], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

/**
 * Detached and stdio-ignored, or the parent never exits — and always carrying
 * DISPLAY, since a headed browser with no display simply does not start.
 */
const background = (cmd, argv) =>
  spawn(cmd, argv, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DISPLAY },
  }).unref();

if (!running(`Xvfb ${DISPLAY}`)) {
  background("Xvfb", [DISPLAY, "-screen", "0", SCREEN, "-ac", "+extension", "RANDR"]);
  await wait(1500);
  console.log(`Xvfb on ${DISPLAY} (${SCREEN})`);
}

// A window manager is not optional: without one Chrome's own dialogs open
// undecorated and unfocusable, which is most of the point of running headed.
if (!running("openbox")) {
  background("openbox", []);
  await wait(1000);
  console.log("openbox");
}

// --- the browser -------------------------------------------------------------------

const CHROME =
  process.env.ARCHER_CHROME ??
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(
    (p) => existsSync(p),
  );

if (!CHROME) {
  console.error("no chromium found — set ARCHER_CHROME");
  process.exit(2);
}

if (!running("archer-live-profile")) {
  mkdirSync(PROFILE, { recursive: true });
  background(CHROME, [
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--window-size=1560,960",
    "--window-position=0,0",
    "about:blank",
  ]);
  // The extension has to finish loading before the new tab override takes
  // effect — a tab opened too early gets Chrome's own new tab instead.
  await waitForPort(DEBUG_PORT);
  await wait(3000);
  console.log("chromium (headed)");
}

// --- drive it ------------------------------------------------------------------------

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not found — see the header of test/e2e.mjs");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const context = browser.contexts()[0];
const page = await context.newPage();

await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {
  // chrome:// URLs reject a scripted navigation; type it in the omnibox instead.
  keyboard(["ctrl+l"]);
  type(url);
  keyboard(["Return"]);
});
await wait(3000);

mkdirSync(OUT, { recursive: true });

// The whole screen, not the viewport: the toolbar and the tab strip are the
// reason to be here.
const shot = join(OUT, `live-${name}.png`);
execFileSync("bash", ["-lc", `DISPLAY=${DISPLAY} xwd -root -silent > /tmp/live.xwd && convert /tmp/live.xwd '${shot}'`]);
console.log(shot);

if (!keep) {
  await browser.close();
  // Not through `bash -lc`: the wrapper shell's own command line contains the
  // pattern, so pkill matches the shell and kills this script's parent.
  try {
    execFileSync("pkill", ["-f", "archer-live-profile"], { stdio: "ignore" });
  } catch {
    /* nothing matched, which is the good case */
  }
} else {
  browser.close();
  console.log(`still running — CDP on ${DEBUG_PORT}, display ${DISPLAY}`);
}

// --- helpers ---------------------------------------------------------------------------

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Chrome opens the debugging port once it is genuinely up. Poll for it. */
async function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await wait(400);
  }
  throw new Error(`chromium never opened its debugging port on ${port} — is DISPLAY ${DISPLAY} up?`);
}

function keyboard(keys) {
  for (const key of keys) execFileSync("xdotool", ["key", "--clearmodifiers", key], { env: { ...process.env, DISPLAY } });
}

function type(text) {
  execFileSync("xdotool", ["type", "--delay", "40", text], { env: { ...process.env, DISPLAY } });
}
