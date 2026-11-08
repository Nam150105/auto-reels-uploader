/**
 * Removes stale Vite build files from static/assets after `vite build`.
 *
 * vite.config.ts keeps `emptyOutDir: false` because static/ also holds hand-written pages
 * (login, privacy, terms, data-deletion, favicon). Without this step every build leaves the
 * previous app.*.js / index.*.css behind.
 *
 * Keeps every file referenced by static/index.html, plus files referenced from those files
 * (e.g. an image imported by the JS bundle). Use --dry-run to only print what would be removed.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATIC_DIR = path.join(ROOT, "static");
const ASSETS_DIR = path.join(STATIC_DIR, "assets");
const DRY_RUN = process.argv.includes("--dry-run");

if (!fs.existsSync(ASSETS_DIR)) {
  console.log("[prune-assets] static/assets does not exist, nothing to do.");
  process.exit(0);
}

const assetFiles = fs.readdirSync(ASSETS_DIR).filter((f) => fs.statSync(path.join(ASSETS_DIR, f)).isFile());
const indexHtml = fs.readFileSync(path.join(STATIC_DIR, "index.html"), "utf8");

const keep = new Set();
const queue = [];
const scan = (text) => {
  for (const name of assetFiles) {
    if (!keep.has(name) && text.includes(name)) {
      keep.add(name);
      if (/\.(js|css|html|svg|json)$/i.test(name)) queue.push(name);
    }
  }
};

scan(indexHtml);
if (keep.size === 0) {
  // Safety net: a broken build must never wipe the assets folder
  console.error("[prune-assets] static/index.html references no file in static/assets. Nothing removed.");
  process.exit(1);
}
while (queue.length) {
  scan(fs.readFileSync(path.join(ASSETS_DIR, queue.shift()), "utf8"));
}

const stale = assetFiles.filter((f) => !keep.has(f));
for (const name of stale) {
  if (!DRY_RUN) fs.unlinkSync(path.join(ASSETS_DIR, name));
}
console.log(
  `[prune-assets] kept ${keep.size} file(s), ${DRY_RUN ? "would remove" : "removed"} ${stale.length} stale file(s)` +
    (stale.length ? `: ${stale.join(", ")}` : ".")
);
