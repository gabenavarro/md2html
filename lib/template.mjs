/**
 * Single-file HTML template for md2html reports.
 *
 * Classic (non-module) scripts only, so the report works from file:// and
 * offline: the Mermaid bundle is inlined by the renderer, KaTeX fonts are
 * data: URIs, and everything else is plain inline CSS/JS.
 *
 * Theme: light/dark via `html.dark`. Shiki outputs --shiki-light/--shiki-dark
 * CSS variables that switch with the theme. Mermaid re-renders on toggle.
 * XY iframes swap src between a light and a dark standalone file.
 */


export function template({ title, description, theme, tocHtml, bodyHtml, metaHtml, date, katexCss, css, mermaidInline = "" }) {
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
    var forced = document.documentElement.getAttribute("data-theme");
    var t = localStorage.getItem("md2html-theme");
    if (!t) {
      t = (forced && forced !== "auto")
        ? forced
        : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }
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
  ${date ? `<span class="footer-date">${date}</span>` : ""}
${mermaidInline ? `<script id="md2html-mermaid-bundle">\n${mermaidInline}\n</script>` : ""}
<script>
(function () {
  var THEME_KEY = "md2html-theme";
  var mermaid = window.mermaid;

  function currentTheme() {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }

  function initOpts() {
    return {
      startOnLoad: false,
      theme: currentTheme() === "dark" ? "dark" : "default",
      themeVariables: { fontFamily: "ui-sans-serif, system-ui, sans-serif" },
      securityLevel: "loose",
      flowchart: { htmlLabels: true },
    };
  }

  function initMermaid() {
    if (!mermaid) return;
    // Mermaid v12 run() reads diagram source from innerHTML, not data-src —
    // seed it from the canonical data-src attribute before rendering.
    Array.from(document.querySelectorAll(".mermaid")).forEach(function (el) {
      var src = el.getAttribute("data-src");
      if (src && !el.innerHTML.trim()) el.innerHTML = src;
    });
    mermaid.initialize(initOpts());
    return mermaid.run({ querySelector: ".mermaid" });
  }

  function rethemeMermaid() {
    if (!mermaid) return;
    var els = Array.from(document.querySelectorAll(".mermaid"));
    if (!els.length) return;
    mermaid.initialize(initOpts());
    var pending = [];
    els.forEach(function (el) {
      var src = el.getAttribute("data-src");
      if (!src) return;
      el.removeAttribute("data-processed");
      el.removeAttribute("data-mermaid-id");
      el.removeAttribute("aria-roledescription");
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
      var svg = el.querySelector("svg");
      if (svg) svg.remove();
      el.innerHTML = src;
      pending.push(mermaid.parse(src));
    });
    Promise.all(pending).then(function () {
      return mermaid.run({ querySelector: ".mermaid" });
    });
  }

  var iframes = Array.from(document.querySelectorAll("iframe.xy-iframe"));
  function syncXY() {
    var t = currentTheme();
    iframes.forEach(function (f) {
      var frame = f.closest(".xy-frame");
      if (!frame) return;
      var target = t === "dark" ? frame.getAttribute("data-dark") : frame.getAttribute("data-light");
      if (target && f.getAttribute("src") !== target) f.setAttribute("src", target);
    });
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
})();
</script>
</body>
</html>
`;
}
