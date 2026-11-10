// The extension's only background code, and it does one thing: tells a new
// profile from an updated one, which nothing on the new tab page can do.
// A fresh install is asked where questions should go; an update never is.
// It makes no network request and reads nothing but Archer's own storage.

import { recordInstall } from "./src/settings.js";

chrome.runtime.onInstalled.addListener(({ reason }) => {
  recordInstall(reason);
});
