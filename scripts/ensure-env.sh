#!/usr/bin/env bash
# md2html environment bootstrapper.
# Run from anywhere:  bash scripts/ensure-env.sh
# Idempotent. Safe to call before every render.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_DIR"

echo "==> md2html environment check: $SKILL_DIR"

# --- Node -----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found (need Node >= 20)" >&2
  exit 1
fi
if [ ! -e node_modules/.package-lock.json ]; then
  echo "==> npm install"
  npm install --no-audit --no-fund --loglevel=error
fi

# --- Python + XY ----------------------------------------------------------
if [ ! -x .venv/bin/python ]; then
  echo "==> creating .venv (python >= 3.11 required for xy)"
  CREATED=0
  if command -v uv >/dev/null 2>&1; then
    for v in 3.13 3.12 3.11; do
      if uv venv .venv --python "$v" 2>/dev/null; then
        CREATED=1
        break
      fi
    done
  fi
  if [ "$CREATED" -eq 0 ]; then
    PY311="$(for p in python3.13 python3.12 python3.11; do command -v "$p" && break; done)"
    if [ -z "$PY311" ]; then
      echo "error: no python >= 3.11 found. Install one (e.g. brew install python@3.13) or 'brew install uv'." >&2
      exit 1
    fi
    "$PY311" -m venv .venv
    CREATED=1
  fi
fi

if ! .venv/bin/python -c "import xy" >/dev/null 2>&1; then
  echo "==> installing xy into .venv"
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python .venv/bin/python xy matplotlib
  else
    .venv/bin/python -m pip install -q --upgrade pip
    .venv/bin/python -m pip install -q xy matplotlib
  fi
fi

echo "==> environment ready"
echo "    renderer:  node bin/md2html.mjs"
echo "    xy python: .venv/bin/python"
