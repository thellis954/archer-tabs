// Re-encodes a PNG as WebP, preserving alpha.
//
// The Blender renders in web/assets/ come out around 1MB each, which is a lot
// for an ambient image sitting behind the hero. There is no cwebp, pngquant or
// PIL in this repo's world (it installs nothing), but Chromium ships a WebP
// encoder and playwright is already a dependency of the other tools, so the
// conversion runs through a canvas.
//
// Requires playwright on the module path:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
//
// Usage: node tools/towebp.mjs <in.png> <out.webp> [quality 0-1] [maxWidth px]

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const [, , inPath, outPath, q, w] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node tools/towebp.mjs <in.png> <out.webp> [quality] [maxWidth]");
  process.exit(2);
}
const quality = Number(q ?? 0.86);
const maxWidth = w ? Number(w) : 0;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not found — see the header of this file");
  process.exit(2);
}

const src = resolve(inPath);
const dataUri = `data:image/png;base64,${readFileSync(src).toString("base64")}`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();

const encoded = await page.evaluate(
  async ([uri, quality, maxWidth]) => {
    const img = new Image();
    img.src = uri;
    await img.decode();

    const scale = maxWidth && img.naturalWidth > maxWidth ? maxWidth / img.naturalWidth : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);

    // No fill first: the source is transparent and WebP keeps the alpha.
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const out = canvas.toDataURL("image/webp", quality);
    if (!out.startsWith("data:image/webp")) throw new Error("no webp encoder");
    return out.slice(out.indexOf(",") + 1);
  },
  [dataUri, quality, maxWidth],
);

await browser.close();

const dst = resolve(outPath);
writeFileSync(dst, Buffer.from(encoded, "base64"));
console.log(
  `${inPath} ${(statSync(src).size / 1024).toFixed(0)}K -> ` +
    `${outPath} ${(statSync(dst).size / 1024).toFixed(0)}K`,
);
