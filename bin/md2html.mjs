#!/usr/bin/env node
/**
 * md2html — render agent-authored Markdown reports into vibrant, self-contained HTML.
 *
 * Usage:
 *   md2html <report.md> [more.md ...]
 *   md2html <report.md> --out report.html
 *   md2html <dir>            # renders every *.md in a directory
 *
 * Options:
 *   --out <path>        output path (single input only)
 *   --theme <auto|light|dark>  force theme (default: auto -> prefers-color-scheme)
 *   --python <path>     python interpreter with `xy` installed (default: ./.venv/bin/python)
 *   --no-check          skip the build-time Mermaid syntax gate
 *   --open              open each rendered report in the default browser
 *
 * XY charts: fenced ```xy blocks are extracted to xy-src/, rendered via
 * scripts/xy-export.py into xy-out/ (light + dark standalone HTML), and
 * embedded as iframes whose src swaps with the active theme.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

import { render } from "../lib/render.mjs";

function usage(code = 1) {
  console.log(`md2html — Markdown reports -> self-contained HTML

Usage:
  md2html <report.md | dir> [more.md ...] [--out path] [--theme auto|light|dark] [--python path] [--no-check] [--open] [--version]`);
  process.exit(code);
}

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log(`md2html ${VERSION}`);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) usage(0);
if (args.length === 0) usage(1);
const inputs = [];
let out, theme, python; let noCheck = false, open = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") out = resolve(args[++i]);
  else if (a === "--theme") theme = args[++i];
  else if (a === "--python") python = args[++i];
  else if (a === "--no-check") noCheck = true;
  else if (a === "--open") open = true;
  else if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); usage(); }
  else inputs.push(resolve(a));
}

let files = [];
for (const p of inputs) {
  if (!existsSync(p)) {
    console.error(`md2html: not found: ${p}`);
    process.exit(1);
  }
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) {
      if (!f.endsWith(".md")) continue;
      if (f === "README.md") continue; // repo docs, not a report
      files.push(join(p, f));
    }
  } else {
    files.push(p);
  }
}
if (out && files.length > 1) {
  console.error("md2html: --out applies to a single input");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  try {
    const opts = {};
    if (theme) opts.theme = theme;
    if (python) opts.python = python;
    if (noCheck) opts.noCheck = true;
    if (out && files.length === 1) opts.outPath = out;
    const r = await render(f, opts);
    const xy = r.xy.length ? `  (+ ${r.xy.length} xy chart${r.xy.length > 1 ? "s" : ""})` : "";
    console.log(`${f} -> ${r.outPath}${xy}`);
  } catch (e) {
    failed++;
    console.error(`md2html: ${f}\n  ${e.message}`);
  }
}
function browserOpen(path) {
  try {
    const cmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch { /* non-fatal: render still succeeded */ }
}
if (open) {
  for (const f of files) {
    const htmlPath = out && files.length === 1 ? out : f.replace(/\.md$/, "") + ".html";
    if (existsSync(htmlPath)) browserOpen(htmlPath);
  }
}
process.exit(failed ? 1 : 0);
