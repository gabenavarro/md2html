/**
 * Single-file HTML template for md2html reports.
 *
 * Theme: light/dark via `html.dark`. Shiki outputs --shiki-light/--shiki-dark
 * CSS variables that switch with the theme. Mermaid re-renders on toggle.
 * XY iframes swap src between a light and a dark standalone file.
 */

export function template({ title, description, theme, tocHtml, bodyHtml, metaHtml, date, katexCss, css }) {
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
<title>${title}</title>
<script>
(function () {
  try {
    var t = localStorage.getItem("md2html-theme");
    if (!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.classList.add(t);
  } catch (e) {}
})();
</script>
<style id="md2html-katex">
${katexCss}
</style>
<style id="md2html-css">
${css}
</style>
</head>
<body>
<header class="report-header">
  <div class="report-title-wrap">
    <h1>${title}</h1>
    ${metaHtml ? `<div class="report-meta">${metaHtml}</div>` : ""}
  </div>
  <button id="theme-toggle" class="theme-toggle" aria-label="Toggle theme" title="Toggle light/dark">◐</button>
</header>
<div class="report-layout">
  ${tocHtml ? `<nav class="toc" aria-label="Table of contents"><div class="toc-title">Contents</div>${tocHtml}</nav>` : ""}
  <main class="report-body">
${bodyHtml}
  </main>
</div>
<footer class="report-footer">
  <span>${title}</span>
  <span class="footer-date">${date}</span>
</footer>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.esm.min.mjs";

var THEME_KEY = "md2html-theme";

function currentTheme() {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    theme: currentTheme() === "dark" ? "dark" : "default",
    themeVariables: { fontFamily: "ui-sans-serif, system-ui, sans-serif" },
    securityLevel: "loose",
    flowchart: { htmlLabels: true },
  });
  return mermaid.run({ querySelector: ".mermaid" });
}

async function rethemeMermaid() {
  var els = Array.from(document.querySelectorAll(".mermaid"));
  if (!els.length) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: currentTheme() === "dark" ? "dark" : "default",
    securityLevel: "loose",
  });
  var pending = [];
  for (var el of els) {
    var src = el.getAttribute("data-src");
    if (!src) continue;
    el.removeAttribute("data-processed");
    el.removeAttribute("data-mermaid-id");
    el.removeAttribute("aria-roledescription");
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    var svg = el.querySelector("svg");
    if (svg) svg.remove();
    el.innerHTML = src;
    pending.push(mermaid.parse(src));
  }
  await Promise.all(pending);
  await mermaid.run({ querySelector: ".mermaid" });
}

var iframes = Array.from(document.querySelectorAll("iframe.xy-iframe"));

function syncXY() {
  var t = currentTheme();
  for (var f of iframes) {
    var target = t === "dark" ? f.closest(".xy-frame").getAttribute("data-dark")
                              : f.closest(".xy-frame").getAttribute("data-light");
    if (target && f.getAttribute("src") !== target) f.setAttribute("src", target);
  }
}

function setTheme(t) {
  document.documentElement.classList.toggle("dark", t === "dark");
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  rethemeMermaid();
  syncXY();
}

var btn = document.getElementById("theme-toggle");
if (btn) btn.addEventListener("click", function () {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
});

initMermaid();
syncXY();
</script>
</body>
</html>
`;
}
