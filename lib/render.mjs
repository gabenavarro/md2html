/**
 * md2html core renderer.
 * Markdown in -> self-contained report out (HTML + optional XY siblings).
 *
 * Features:
 *  - YAML frontmatter (title, description, theme, toc, date, author, meta)
 *  - GFM tables, strikethrough, task lists, alerts
 *  - Shiki syntax highlighting with light/dark CSS-variable output
 *  - KaTeX math (block + inline), fonts inlined as data: URIs
 *  - Mermaid diagrams (CDN, theme-aware re-render on toggle)
 *  - XY charts: source extracted to xy-src/, rendered via scripts/xy-export.py
 *    into light+dark standalone HTML in xy-out/; iframe src swaps on toggle
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative, basename, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import GitHubSlugger from "github-slugger";

import { template } from "./template.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KATEX_DIR = join(__dirname, "..", "node_modules", "katex");

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline every KaTeX font referenced by the stylesheet as a data: URI. */
function katexCssInline() {
  let css = readFileSync(join(KATEX_DIR, "dist", "katex.min.css"), "utf8");
  const fontDir = join(KATEX_DIR, "dist", "fonts");
  const files = readdirSync(fontDir);
  for (const f of files) {
    const data = Buffer.from(readFileSync(join(fontDir, f))).toString("base64");
    const mime = f.endsWith(".woff2") ? "font/woff2" : f.endsWith(".woff") ? "font/woff" : "font/ttf";
    css = css.replace(new RegExp(`(url\\()[^)]*${f}\\)`, "g"), `$1data:${mime};base64,${data})`);
  }
  return css;
}

/**
 * Shiki highlighter as a rehype plugin. Replaces each <pre><code> with the
 * Shiki output, which carries --shiki-light/--shiki-dark CSS variables so a
 * single stylesheet can switch themes.
 */
let _shikiPromise;
async function getShiki() {
  if (!_shikiPromise) {
    const { createHighlighter } = await import("shiki");
    _shikiPromise = createHighlighter({
      themes: ["github-light-default", "github-dark-default"],
      langs: [
        "js", "ts", "jsx", "tsx", "python", "bash", "json", "jsonc", "yaml",
        "toml", "html", "css", "md", "sql", "diff", "rust", "go", "java", "c",
        "cpp", "ruby", "php", "swift", "kotlin", "r", "dockerfile", "ini",
        "plaintext", "text",
      ],
    });
  }
  return _shikiPromise;
}

async function shikiPlugin() {
  const highlighter = await getShiki();
  const walk = (node) => {
    if (node.type !== "element" || node.tagName !== "pre" || node.children.length !== 1) return node;
    const code = node.children[0];
    if (code.type !== "element" || code.tagName !== "code") return node;
    const cls = (code.properties?.className || []).join(" ");
    const m = cls.match(/language-(\w+)/);
    const requested = m ? m[1] : "text";
    if (requested === "mermaid") return node; // rendered later by the mermaid runtime
    const lang = highlighter.getLoadedLanguages().includes(requested)
      ? requested
      : "plaintext";
    const raw = code.children.map((c) => (c.value ?? "")).join("");
    const hast = highlighter.codeToHast(raw, {
      lang,
      themes: { light: "github-light-default", dark: "github-dark-default" },
    });
    return hast ?? node;
  };
  const recurse = (node) => {
    if (node.children) node.children = node.children.map(recurse);
    return walk(node);
  };
  return (processor) => (tree) => {
    tree.children = tree.children.map(recurse);
  };
}

/**
 * Assign id attributes to h2/h3 headings so TOC anchors resolve.
 * Takes the same GitHubSlugger instance the TOC uses, in the same
 * document order, so heading ids and TOC slugs match by construction.
 * Headings with an existing id (raw HTML) are left untouched.
 */
function headingIdsPlugin(slugger) {
  const textOf = (node) =>
    node.type === "text" ? node.value : (node.children || []).map(textOf).join("");
  const walk = (node) => {
    if (node.type === "element" && ["h2", "h3"].includes(node.tagName)) {
      if (!node.properties?.id) {
        const text = textOf(node).trim();
        if (text) node.properties = { ...(node.properties || {}), id: slugger.slug(text) };
      }
    }
    (node.children || []).forEach(walk);
  };
  return () => (tree) => tree.children.forEach(walk);
}

const nodeText = (node) =>
  node.type === "text" ? node.value : (node.children || []).map(nodeText).join("");

/**
 * Make an inline SVG respond to the light/dark theme by rewriting its
 * presentation colors to CSS variables defined in editorial.css. Figures are
 * rendered at build time with a fixed palette; this re-maps the dominant
 * colors so the *same* SVG re-themes on toggle. Explicit palette colors stay
 * (accent stays accent); ink/muted/line/become theme-driven.
 */
const FIG_COLOR_MAP = [
  ["#2c2c30", "var(--ink)"], ["#6b6b72", "var(--muted)"],
  ["#e7e7ea", "var(--line)"], ["#fdfcfb", "var(--bg)"],
  ["#ef6a4d", "var(--coral)"], ["#2fb7a4", "var(--teal)"],
  ["#f08a3c", "var(--orange)"], ["#9b7ede", "var(--purple)"],
  ["#ef5a52", "var(--red)"], ["#4f46e5", "var(--blue)"],
  ["#059669", "var(--green)"],
];
function svgThemeVars(svg) {
  for (const [hex, varname] of FIG_COLOR_MAP) {
    svg = svg.split(`fill="${hex}"`).join(`fill="${varname}"`)
      .split(`stroke="${hex}"`).join(`stroke="${varname}"`)
      .split(`fill:${hex};`).join(`fill:${varname};`)
      .split(`stroke:${hex};`).join(`stroke:${varname};`)
      .split(`stop-color:${hex};`).join(`stop-color:${varname};`);
  }
  return svg;
}

/** ```svg fence -> inline dual-theme <figure> (SVG passed through verbatim). */
function inlineSvgFencePlugin() {
  return () => (tree) => {
    for (const node of tree.children) {
      if (node.type !== "element" || node.tagName !== "pre") continue;
      const code = node.children.find((c) => c.type === "element" && c.tagName === "code");
      if (!code) continue;
      const cls = (code.properties?.className || []).join(" ");
      if (!/language-svg/.test(cls)) continue;
      let svg = decodeEntities(nodeText(code)).trim();
      svg = svgThemeVars(svg);
      node.type = "element";
      node.tagName = "figure";
      node.properties = { className: ["figure", "figure-svg"] };
      node.children = [{ type: "raw", value: svg }];
    }
  };
}

/** fig:NAME placeholders -> inlined dual-theme SVG figure. */
function inlineFigsPlugin(figByHash) {
  return () => (tree) => {
    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i];
      if (node.type !== "element" || node.tagName !== "p") continue;
      const m = nodeText(node).match(/^fig:(fig-[\w-]+)$/);
      if (!m) continue;
      const light = figByHash[m[1]]?.light, dark = figByHash[m[1]]?.dark;
      if (!light || !dark) continue;
      const ls = svgThemeVars(readFileSync(light, "utf8").trim());
      const ds = svgThemeVars(readFileSync(dark, "utf8").trim());
      tree.children[i] = {
        type: "element", tagName: "figure",
        properties: { className: ["figure", "figure-dual"] },
        children: [
          { type: "element", tagName: "div", properties: { className: ["fig", "fig-light"] },
            children: [{ type: "raw", value: ls }] },
          { type: "element", tagName: "div", properties: { className: ["fig", "fig-dark"] },
            children: [{ type: "raw", value: ds }] },
        ],
      };
    }
  };
}

/** <!-- kicker: Name --> before an H2 -> <div class="kicker">NN · Name</div>. */
function kickerPlugin() {
  let n = 0;
  return () => (tree) => {
    const kids = tree.children;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      if (node.type === "comment") {
        const m = String(node.value).trim().match(/^kicker:\s*(.+)$/);
        if (m) {
          n += 1;
          kids.splice(i, 1, {
            type: "element", tagName: "div",
            properties: { className: ["kicker"] },
            children: [{ type: "text", value: `${String(n).padStart(2, "0")} · ${m[1].trim()}` }],
          });
          continue;
        }
        kids.splice(i, 1); i -= 1; // drop stray comments
        continue;
      }
      if (node.type === "element" && node.tagName === "h2" && node.children.length) {
        const first = node.children[0];
        if (first.type === "comment") {
          const m = String(first.value).trim().match(/^kicker:\s*(.+)$/);
          if (m) {
            n += 1;
            node.children.splice(0, 1, {
              type: "element", tagName: "div",
              properties: { className: ["kicker"] },
              children: [{ type: "text", value: `${String(n).padStart(2, "0")} · ${m[1].trim()}` }],
            });
          } else {
            node.children.splice(0, 1);
          }
        }
      }
    }
  };
}

/** **Intuitively.** / **Technically.** paragraphs -> labeled panels. */
function levelPanelPlugin() {
  const wrap = (node, cls, label) => {
    let rest = node.children;
    let labelNode;
    if (rest[0] && rest[0].type === "element" && rest[0].tagName === "strong") {
      labelNode = rest[0];
      rest = rest.slice(1);
    } else {
      labelNode = { type: "element", tagName: "strong", properties: {}, children: [{ type: "text", value: label }] };
    }
    node.type = "element"; node.tagName = "div";
    node.properties = { className: ["lvl", cls] };
    node.children = [
      { type: "element", tagName: "div", properties: { className: ["lvl-label"] },
        children: [{ type: "text", value: label }] },
      { type: "element", tagName: "div", properties: { className: ["lvl-body"] }, children: rest },
    ];
  };
  return () => (tree) => {
    for (const node of tree.children) {
      if (node.type !== "element" || node.tagName !== "p") continue;
      const t = nodeText(node).trim();
      if (/^Intuitively[.:]\b/.test(t)) wrap(node, "lvl-intuitive", "Intuitively");
      else if (/^Technically[.:]\b/.test(t)) wrap(node, "lvl-technical", "Technically");
    }
  };
}

/**
 * Group top-level blocks into <section> elements, one per H2 (a kicker div
 * immediately before its H2 joins that section). Gives the editorial
 * section borders/padding without post-processing the HTML string.
 */
function sectionizePlugin() {
  return () => (tree) => {
    const kids = tree.children;
    const out = [];
    let cur = null;
    const flush = () => {
      if (cur) {
        out.push({ type: "element", tagName: "section", properties: { className: ["report-section"] }, children: cur });
        cur = null;
      }
    };
    for (let i = 0; i < kids.length; i++) {
      const isSectionStart =
        kids[i].type === "element" && kids[i].tagName === "h2";
      const kickerStart =
        kids[i].type === "element" &&
        (kids[i].properties?.className || []).includes("kicker") &&
        kids[i + 1]?.type === "element" &&
        kids[i + 1].tagName === "h2";
      if ((isSectionStart || kickerStart) && cur) flush();
      if (!cur) cur = [];
      cur.push(kids[i]);
      if (kickerStart) cur.push(kids[++i]);
    }
    flush();
    tree.children = out;
  };
}


/** Stable short hash of chart source so renders of the same code share files. */
function hashCode(code) {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) >>> 0;
  return "xy-" + h.toString(16);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Inline local images as data: URIs so the report stays self-contained
 * after being copied/moved (the .html is the portable artifact). Remote
 * URLs are left untouched; unreadable or oversized local files keep their
 * relative reference.
 */
function inlineImages(htmlBody, mdPath) {
  const base = dirname(mdPath);
  return htmlBody.replace(
    /(<img\b[^>]*\bsrc=")([^"]+)(")/g,
    (m, pre, src, post) => {
      if (/^(https?:|data:|\/\/)/i.test(src) || !/\.\w{2,5}$/.test(src.split(/[?#]/)[0])) return m;
      try {
        const abs = resolve(base, src);
        const buf = readFileSync(abs);
        if (buf.length > 8 * 1024 * 1024) return m;
        const mime = mimeFromExt(abs);
        return pre + `data:${mime};base64,${buf.toString("base64")}` + post;
      } catch {
        return m;
      }
    },
  );
}

function mimeFromExt(p) {
  const ext = extname(p).slice(1).toLowerCase();
  return (
    {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      svg: "image/svg+xml", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
    }[ext] ?? "application/octet-stream"
  );
}
/**
 * Build-time Mermaid syntax gate. Parses every ```mermaid block with
 * mermaid.parse (under a minimal jsdom DOM) and fails the render with the
 * parser's own line-precise error instead of shipping a report that shows
 * a syntax-error bomb.
 */
let _mermaidCtx;
async function validateMermaidBlocks(body) {
  const blocks = [...body.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return;
  if (!_mermaidCtx) {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/" });
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    _mermaidCtx = (await import("mermaid")).default;
  }
  for (let i = 0; i < blocks.length; i++) {
    const src = blocks[i][1];
    try {
      await _mermaidCtx.parse(src);
    } catch (e) {
      const detail = String(e.message || e).split("\n").find((l) => l.trim());
      throw new Error(`mermaid block ${i + 1} fails to parse: ${detail}\n  block source:\n${src.split("\n").map((l) => "    " + l).join("\n")}`);
    }
  }
}


export async function render(input, opts = {}) {
  const mdPath = input;
  const md = readFileSync(mdPath, "utf8");
  const fm = matter(md);
  const meta = {
    title: fm.data.title ?? "Report",
    description: fm.data.description ?? "",
    theme: fm.data.theme ?? opts.theme ?? "auto",
    toc: fm.data.toc !== false && fm.data.toc !== "false",
    date: fm.data.date ?? "",
    author: fm.data.author ?? "",
    kicker: fm.data.kicker ?? "",
    ...fm.data.meta,
  };
  const body = fm.content;

  // ---- TOC (from the parsed AST: fence-aware by construction) ------------
  if (meta.date instanceof Date) meta.date = meta.date.toISOString().slice(0, 10);
  const slugger = new GitHubSlugger();
  const toc = [];
  const mdTree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(body);
  const headingText = (node) =>
    node.type === "text" ? node.value : (node.children || []).map(headingText).join("");
  const collectHeadings = (node) => {
    if (node.type === "heading" && (node.depth === 2 || node.depth === 3)) {
      const text = headingText(node).trim();
      if (!text) return; // matches headingIdsPlugin (no empty-heading ids)
      toc.push({ depth: node.depth, text, slug: slugger.slug(text) });
    }
    if (node.children) node.children.forEach(collectHeadings);
  };
  collectHeadings(mdTree);
  const showToc = meta.toc && toc.length >= 3;
  const tocHtml = showToc
    ? toc.map((t) => `<a class="toc-${t.depth}" href="#${t.slug}">${esc(t.text)}</a>`).join("\n")
    : "";

  // ---- Figure extraction (```fig -> dual-theme inline SVG) ---------------
  const outDir = opts.outPath ? dirname(opts.outPath) : dirname(mdPath);
  const figDir = opts.figDir ?? join(outDir, "fig-out");
  const figSrcDir = opts.figSrcDir ?? join(outDir, "fig-src");
  const figEntries = []; // { name, light, dark }
  mkdirSync(figSrcDir, { recursive: true });
  mkdirSync(figDir, { recursive: true });
  if (!opts.noCheck) await validateMermaidBlocks(body);

  const extractFigs = (text) =>
    text.replace(/```fig\n([\s\S]*?)```/g, (_, src) => {
      const name = "fig-" + hashCode(src.trim());
      writeFileSync(join(figSrcDir, name + ".py"), src);
      figEntries.push({
        name,
        light: join(figDir, name + ".light.svg"),
        dark: join(figDir, name + ".dark.svg"),
      });
      return "<p><code>fig:" + name + "</code></p>";
    });

  const mdWithFigs = extractFigs(body);

  // ---- XY chart extraction (interactive, separate files) -----------------
  const xyDir = opts.xyDir ?? join(outDir, "xy-out");
  const xySrcDir = opts.xySrcDir ?? join(outDir, "xy-src");
  const xyEntries = []; // { name, light, dark }
  mkdirSync(xySrcDir, { recursive: true });
  mkdirSync(xyDir, { recursive: true });
  const extractXy = (body) =>
    body.replace(/```xy\n([\s\S]*?)```/g, (_, src) => {
      const name = hashCode(src.trim());
      const py = join(xySrcDir, name + ".py");
      const light = join(xyDir, name + ".html");
      const dark = join(xyDir, name + ".dark.html");
      writeFileSync(py, src);
      xyEntries.push({ name, light, dark });
      return " ```xy:" + name + "``` ";
    });

  const mdWithXy = extractXy(mdWithFigs);

  // ---- Static figures: render dual-theme SVGs before the markdown pass ----
  if (figEntries.length > 0) {
    const script = join(__dirname, "..", "scripts", "fig-export.py");
    const python = opts.python ?? findPython();
    const manifest = [
      ...figEntries.map((e) => ({ py: join(figSrcDir, e.name + ".py"), out: e.light, theme: "light" })),
      ...figEntries.map((e) => ({ py: join(figSrcDir, e.name + ".py"), out: e.dark, theme: "dark" })),
    ];
    try {
      execFileSync(python, [script, "--manifest", JSON.stringify(manifest)], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (e) {
      const stderr = String(e.stderr || "").trim().split("\n");
      const tail = stderr.slice(-12).join("\n");
      const names = figEntries.map((x) => `fig-src/${x.name}.py`).join(", ");
      throw new Error(`Figure render failed (${names})\n${tail || e.message}`);
    }
  }
  const figByHash = Object.fromEntries(figEntries.map((e) => [e.name, e]));

  // The hero owns the title: drop a leading body H1 to avoid duplication.
  const bodyMd = mdWithXy.replace(/^\s*#\s[^\n]*\n+/, "");

  // ---- Markdown -> HTML body ---------------------------------------------
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(inlineSvgFencePlugin())
    .use(inlineFigsPlugin(figByHash))
    .use(kickerPlugin())
    .use(levelPanelPlugin())
    .use(sectionizePlugin())
    .use(headingIdsPlugin(new GitHubSlugger()))
    .use(rehypeKatex, { output: "html" })
    .use(await shikiPlugin())
    .use(rehypeStringify, { allowDangerousHtml: true });

  let htmlBody = (await processor.process(bodyMd)).toString();
  htmlBody = inlineImages(htmlBody, mdPath);
  htmlBody = htmlBody.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_, code) => `<div class="diagram mermaid" data-src="${esc(decodeEntities(code))}"></div>`,
  );
  // GFM alerts: > [!NOTE] / [!WARNING] / [!TIP] / [!IMPORTANT] / [!CAVEAT]
  const ALERTS = {
    note: "Note", warning: "Warning", tip: "Tip",
    important: "Important", caveat: "Caveat",
  };
  for (const [key, label] of Object.entries(ALERTS)) {
    htmlBody = htmlBody.replace(
      new RegExp(
        `<blockquote>\\s*<p>\\[!${key.toUpperCase()}\\](\\s*)`,
      ),
      (_m, ws) =>
        `<blockquote class="alert alert-${key}"><p><strong>${label}</strong>${ws}`,
    );
  }
  htmlBody = htmlBody.replace(/<p><code>xy:(xy-[0-9a-f]+)<\/code><\/p>/g, (_m, name) => {
    const entry = xyEntries.find((e) => e.name === name);
    if (!entry) return "";
    const rel = (p) => encodeURI(relative(outDir, p).split("\\").join("/"));
    return `<div class="xy-frame" data-light="${rel(entry.light)}" data-dark="${rel(entry.dark)}">
  <iframe class="xy-iframe" src="${rel(entry.light)}" title="XY chart: ${esc(name)}" loading="lazy"></iframe>
  <a class="xy-export" href="${rel(entry.light)}" target="_blank" title="Open standalone interactive chart">open</a>
</div>`;
  });

  if (xyEntries.length > 0) {
    const script = join(__dirname, "..", "scripts", "xy-export.py");
    const python = opts.python ?? findPython();
    const manifest = [
      ...xyEntries.map((e) => ({ py: join(xySrcDir, e.name + ".py"), out: e.light, theme: "light" })),
      ...xyEntries.map((e) => ({ py: join(xySrcDir, e.name + ".py"), out: e.dark, theme: "dark" })),
    ];
    try {
      execFileSync(python, [script, "--manifest", JSON.stringify(manifest)], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (e) {
      const stderr = String(e.stderr || "").trim().split("\n");
      const tail = stderr.slice(-12).join("\n");
      const names = xyEntries.map((x) => `xy-src/${x.name}.py`).join(", ");
      throw new Error(`XY chart render failed (${names})\n${tail || e.message}`);
    }
  }
  const SKIP = new Set(["title", "description", "theme", "toc", "date", "kicker"]);
  const metaLines = Object.entries(meta)
    .filter(([k, v]) => !SKIP.has(k) && v !== "" && v !== undefined)
    .map(([k, v]) => `<span class="meta-${esc(k)}">${esc(String(v))}</span>`)
    .join("");
  const date = meta.date || ""; // no wall-clock fallback: reproducible render
  let mermaidInline = "";
  const mermaidBundle = join(__dirname, "..", "node_modules", "mermaid", "dist", "mermaid.min.js");
  if (existsSync(mermaidBundle)) mermaidInline = readFileSync(mermaidBundle, "utf8");

  // Hero lede: the first body paragraph before the first H2 (the document's
  // opening summary). Falls back to the frontmatter description.
  let lede = "";
  for (const node of mdTree.children) {
    if (node.type === "heading" && node.depth === 2) break;
    if (node.type === "paragraph") lede = headingText(node);
  }
  if (!lede) lede = meta.description || "";

  const doc = template({
    title: meta.title,
    description: meta.description,
    theme: meta.theme,
    tocHtml,
    bodyHtml: htmlBody,
    metaHtml: metaLines,
    date,
    kicker: meta.kicker,
    lede,
    katexCss: katexCssInline(),
    css: opts.css ?? readFileSync(join(__dirname, "..", "assets", "editorial.css"), "utf8"),
    mermaidInline,
  });

  const outPath = opts.outPath ?? mdPath.replace(/\.md$/, "") + ".html";
  if (opts.write !== false) writeFileSync(outPath, doc);

  return {
    html: doc,
    meta,
    toc,
    xy: xyEntries,
    srcPath: mdPath,
    outPath,
  };
}

function findPython() {
  const venv = join(__dirname, "..", ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return "python3";
}

export { decodeEntities };
