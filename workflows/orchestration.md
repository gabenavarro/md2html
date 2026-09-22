# md2html Subagent Orchestration

Pattern for producing **high-quality, reproducible** reports with parallel
subagents. Use this pattern when a report has 3+ substantive sections,
or exceeds ~200 lines, or requires data work (charts, tables, analysis).

For small one-off reports (< 100 lines, single author voice), skip
orchestration: write the Markdown, render, verify — done.

## Roles

| Role | Agent type | Count | Job |
|------|-----------|-------|-----|
| **Architect** | `task` | 1 | Defines section plan, data contracts, figure list |
| **Section writers** | `task` / `scout` | N (parallel) | Draft one section each |
| **Figure specialist** | `task` | 1 (optional) | `fig` static figures, `xy` chart sources, Mermaid diagrams |
| **Assembler** | `task` | 1 | Merges into final `.md`, fixes seams |
| **Reviewer** | `reviewer` | 1 | Checks rendered HTML, returns fixes |

Section writers that need to read data/code: `task` (read + write).
Writers whose input is fully provided by the Architect: `scout` is fine
for research-only sections, but drafting needs write access → `task`.

## Workflow

### 1. Architect (sequential, fast)

One `task` agent produces `report-plan.md`:

```markdown
# Report plan: <title>
## Sections
1. <heading> — scope, key claims, data needed
2. ...
## Figures
- F1: xy chart — <what>, data source: <path/query>
- F2: mermaid — <what>
## Contracts
- Units: <e.g. seq/s, GB, %>
- Citation style: <bare paths, no URLs>
- Style: <one-sentence voice note>
```

Acceptance: the plan is specific enough that any section writer can work
without reading the conversation. The Architect reads the user's request
verbatim (pass it in the task text) and any cited data files.

### 2. Section writers (parallel fan-out)

One subagent per section. Each task text must contain:

- The plan (or a link to it via `local://`).
- The full user request.
- That section's scope and key claims.
- The contract (units, citation style).
- Output: write `sections/<N>-<slug>.md` (a fragment: heading + body, no
  frontmatter, no report title).
- Explicit non-goals: do NOT write other sections, do NOT create the final
  report, do NOT run the renderer.

Use one `tasks[]` batch for all writers. Cap fan-out at ~6 sections per
batch; larger reports: 2 waves.

### 3. Figure specialist (parallel with writers)

Writes `figures/<n>-<slug>.py` — self-contained sources for the plan's
figure list (see `report-format.md`):

- **Static figures** (`fig` blocks): matplotlib scripts that end with
  `save()`. These are the primary figure form — theme-aware SVG inlined
  into the report.
- **Interactive charts** (`xy` blocks): `xy` chart sources, used only
  when the reader should pan/zoom.
- **Mermaid** blocks inline in a `figures/mermaid.md` snippet.

Every source must run standalone: `.venv/bin/python figures/n-slug.py`
should succeed in a scratch dir.

### 4. Assembler (sequential)

One `task` agent:

- Writes `report.md`: frontmatter (from plan title/description/date) +
  all sections in plan order, splicing in figures.
- Fixes seams: repeated intros, inconsistent units, dangling references.
- Runs `bash scripts/ensure-env.sh && node bin/md2html.mjs report.md`.
- Acceptance: render exits 0, `fig-out/` (and `xy-out/` when charts
  present) has light+dark files for every figure, no missing-image
  warnings, no `fig:` placeholder text leaked into the HTML.

### 5. Reviewer (sequential)

`reviewer` agent with the rendered HTML path:

- Opens the HTML (read the file; spot-check structure) **and** is told to
  verify: every table renders, **every figure present — count the
  `fig`/`xy`/`svg` blocks in the source and confirm each produced output
  (`fig-out/`/`xy-out/` light+dark files for fences, inline `<figure>`/
  `<svg>` for inlined ones)**, TOC slugs match headings, math present,
  no placeholder text ("TODO", "TBD", "lorem"), no `fig:`/`xy:`
  placeholder strings leaked, numbers consistent across sections.
- Returns a fix list. The Assembler applies fixes and re-renders.
- Loop max 2 rounds; if a third round is needed, stop and surface the
  disagreement to the user.

## Why this shape

- **Quality**: sections are drafted in parallel by agents whose entire
  context is one section — no drift, no context-dilution on long reports.
  The reviewer is a fresh agent that sees the artifact, not the intent.
- **Reproducible**: plan → sections → render is a pure function of
  (user request, data, this skill). Re-running from `report-plan.md`
  reproduces the report. `xy-src/` files are hashed from chart source, so
  identical charts produce identical HTML.
- **Bounded**: 5 roles, max 2 review rounds. No open-ended loops.

## Degraded mode (no subagents available)

Same steps, single agent, sequential. The Architect step becomes an
outline at the top of `report.md`; the reviewer step becomes a self-check
against the quality bar in SKILL.md. Output quality bar is identical.
