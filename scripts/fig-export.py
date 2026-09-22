#!/usr/bin/env python3
"""Render md2html ```fig blocks into static, theme-tuned SVG.

A ```fig block is a matplotlib script. fig-export styles it to the report
palette (light or dark) and saves it as SVG, so the figure is inlined into
the report — self-contained, palette-coherent, matching the editorial look
of a hand-drawn figure.

Usage:
    fig-export.py <chart.py> <out.svg> --theme light|dark
    fig-export.py --manifest '<json>'     # json: [{"py":…, "out":…, "theme":…}]

Chart contract — the script receives:
  plt    - matplotlib.pyplot, pre-styled for the requested theme
  C      - dict of palette colors for the theme (coral, teal, orange,
           purple, red, blue, green, ink, muted, line, bg)
  clean  - clean(ax=None): remove top/right spines, thin the grid
  save   - save(): save the current figure (or a `fig` global) to <out.svg>

The script should build its axes with `plt` using semantic colors from `C`,
then call `save()` at the end. Example:

    fig, ax = plt.subplots()
    ax.plot(x, y, color=C["coral"], lw=2.5)
    ax.set_title("Throughput")
    clean(ax)
    save()

The palette mirrors assets/editorial.css so a figure and the page around it
share colors by construction.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Palette per theme. Mirrors assets/editorial.css (--ink/--muted/--line and
# the accent set) so inlined figures are color-matched to the page.
THEMES = {
    "light": {
        "bg": "#fdfcfb",
        "ink": "#2c2c30",
        "muted": "#6b6b72",
        "line": "#e7e7ea",
        "coral": "#ef6a4d",
        "teal": "#2fb7a4",
        "orange": "#f08a3c",
        "purple": "#9b7ede",
        "red": "#ef5a52",
        "blue": "#4f46e5",
        "green": "#059669",
    },
    "dark": {
        "bg": "#0d0d0f",
        "ink": "#ececec",
        "muted": "#9a9aa2",
        "line": "#26262c",
        "coral": "#ff7b72",
        "teal": "#39c5cf",
        "orange": "#ffa657",
        "purple": "#d2a8ff",
        "red": "#ff7b72",
        "blue": "#8b85ff",
        "green": "#34d399",
    },
}

FONT_STACK = [
    "Manrope", "Inter", "Segoe UI", "Helvetica Neue", "Helvetica", "Arial",
    "DejaVu Sans",
]


def _apply_theme(theme: str) -> None:
    """Style matplotlib (via rcParams) for the given theme."""
    import matplotlib

    matplotlib.use("Agg")  # headless: must set before pyplot import
    import matplotlib.pyplot as plt

    t = THEMES[theme]
    plt.rcParams.update({
        "figure.facecolor": t["bg"],
        "axes.facecolor": t["bg"],
        "text.color": t["ink"],
        "axes.labelcolor": t["ink"],
        "axes.edgecolor": t["line"],
        "axes.linewidth": 1.0,
        "axes.titlecolor": t["ink"],
        "axes.titlesize": 13,
        "axes.titleweight": "700",
        "xtick.color": t["muted"],
        "ytick.color": t["muted"],
        "xtick.labelsize": 11,
        "ytick.labelsize": 11,
        "axes.labelsize": 12,
        "legend.facecolor": t["bg"],
        "legend.edgecolor": t["line"],
        "legend.fontsize": 11,
        "font.size": 12,
        "font.sans-serif": FONT_STACK,
        "font.family": "sans-serif",
        "grid.color": t["line"],
        "grid.linewidth": 0.6,
        "grid.alpha": 0.7,
        "lines.linewidth": 2.2,
    })


def _clean(ax) -> None:
    """Remove the top/right box spines and thin the grid to hairlines."""
    import matplotlib.pyplot as plt

    ax = ax if ax is not None else plt.gca()
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    if ax.get_xgridlines() is not None:
        ax.grid(linewidth=0.6, alpha=0.7)


def render_one(py_path: Path, out_path: Path, theme: str) -> dict:
    """Execute a figure source file and write a theme-tuned SVG."""
    _apply_theme(theme)
    import matplotlib.pyplot as plt

    src = py_path.read_text(encoding="utf8")
    palette = dict(THEMES[theme])

    def save() -> None:
        fig = plt.gcf()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(out_path, format="svg", facecolor=palette["bg"],
                    bbox_inches="tight")

    ns = {
        "plt": plt,
        "C": palette,
        "clean": _clean,
        "save": save,
        "__name__": "__md2html_fig__",
    }
    code = compile(src, str(py_path), "exec")
    exec(code, ns)  # noqa: S102 - authored figure source, skill workflow

    # If the script never called save() and left a figure open, save it.
    if not out_path.exists() and plt.get_fignums():
        save()

    return {"py": str(py_path), "out": str(out_path),
            "bytes": out_path.stat().st_size}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("py", nargs="?", help="figure source .py file")
    ap.add_argument("out", nargs="?", help="output .svg file")
    ap.add_argument("--manifest", help="JSON manifest string: [{py, out, theme}]")
    ap.add_argument("--theme", choices=["light", "dark"], default="light",
                    help="theme for the output (default light)")
    ap.add_argument("--version", action="store_true",
                    help="print version and exit")
    args = ap.parse_args()

    if args.version:
        print("fig-export 1.0.0")
        return 0

    if args.manifest:
        entries = json.loads(args.manifest)
        results = [render_one(Path(e["py"]), Path(e["out"]),
                              e.get("theme", "light")) for e in entries]
        print(json.dumps(results, indent=2))
        return 0

    if not args.py or not args.out:
        ap.error("py and out are required without --manifest")
    print(json.dumps([render_one(Path(args.py), Path(args.out), args.theme)],
                     indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
