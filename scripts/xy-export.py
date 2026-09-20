#!/usr/bin/env python3
"""Render XY chart source blocks from md2html into standalone HTML.

Usage:
    xy-export.py <chart.py> <out.html> [--theme light|dark]
    xy-export.py --manifest '<json>'     # json: [{"py":…, "out":…, "theme":…}]

The manifest mode renders each entry. Chart source must define its chart in a
`chart`, `fig`, `figure`, or `c` (or any module-level variable exposing a
`to_html` method).

Output is a self-contained interactive XY HTML file (pan/zoom/selection).
md2html renders light + dark variants per chart and swaps the iframe src on
theme toggle.
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import sys
import tempfile
from pathlib import Path


def render_one(py_path: Path, out_path: Path, theme: str) -> dict:
    """Execute a chart source file and write standalone HTML."""
    src = py_path.read_text(encoding="utf-8")

    # Execute in an isolated namespace.
    ns: dict = {"__name__": "__md2html_chart__"}
    module = compile(src, str(py_path), "exec")
    exec(module, ns)  # noqa: S102 - source is authored chart code, skill workflow

    # Find the chart object.
    candidates = ["chart", "fig", "figure", "c"]
    chart = None
    for name in candidates:
        obj = ns.get(name)
        if obj is not None and hasattr(obj, "to_html"):
            chart = obj
            break
    if chart is None:
        for name, obj in ns.items():
            if name.startswith("__"):
                continue
            if isinstance(obj, type) is False and hasattr(obj, "to_html"):
                chart = obj
                break
    if chart is None:
        raise RuntimeError(f"no XY chart found in {py_path} (expected variable: {', '.join(candidates)})")

    # Resolve theme: auto -> light default; dark -> inject .dark class.
    html = chart.to_html()
    if theme == "dark":
        html = html.replace("<body>", '<body class="dark">', 1)
        # Also flip the initial html class so theme detection on load is correct.
        html = html.replace("<html>", '<html class="dark">', 1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return {"py": str(py_path), "out": str(out_path), "bytes": out_path.stat().st_size}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("py", nargs="?", help="chart source .py file")
    ap.add_argument("out", nargs="?", help="output .html file")
    ap.add_argument("--manifest", help="JSON manifest string: [{py, out, theme}]")
    ap.add_argument("--theme", choices=["light", "dark"], default="light",
                    help="initial theme for standalone output (default: light)")
    args = ap.parse_args()

    if args.manifest:
        entries = json.loads(args.manifest)
        results = []
        for e in entries:
            results.append(render_one(
                Path(e["py"]),
                Path(e["out"]),
                e.get("theme", "light"),
            ))
        print(json.dumps(results, indent=2))
        return 0

    if not args.py or not args.out:
        ap.error("py and out are required without --manifest")
    results = [render_one(Path(args.py), Path(args.out), args.theme)]
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
