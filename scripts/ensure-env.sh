#!/usr/bin/env bash
# md2html environment bootstrapper.
# Run from anywhere:  bash scripts/ensure-env.sh
# Idempotent. Safe to call before every render.
#
# Self-provisioning: installs missing prerequisites where a package manager
# is available (Homebrew on macOS, apt on Debian/Ubuntu, uv for Python).
# Degrades to actionable error messages on bare systems.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_DIR"

echo "==> md2html environment check: $SKILL_DIR"

# --- helpers ---------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

install_brew() {
  if have brew; then
    echo "==> brew install $*"
    brew install "$@"
    return 0
  fi
  return 1
}

install_apt() {
  if have apt-get && [ "$(id -u)" = "0" ]; then
    echo "==> apt-get install $*"
    apt-get install -y "$@"
    return 0
  fi
  return 1
}

# --- Node ------------------------------------------------------------------
if ! have node; then
  echo "==> node not found (need >= 20), attempting install"
  install_brew node || install_apt nodejs || {
    echo "error: cannot auto-install node. Install Node >= 20 (e.g. https://nodejs.org) and re-run." >&2
    exit 1
  }
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: node $(node --version) too old (need >= 20). Upgrade and re-run." >&2
  exit 1
fi
if [ ! -e node_modules/.package-lock.json ]; then
  echo "==> npm install"
  npm install --no-audit --no-fund --loglevel=error
fi

# --- uv (preferred Python provisioner) --------------------------------------
if ! have uv; then
  echo "==> uv not found, attempting install"
  UV_OK=0
  if install_brew uv; then UV_OK=1; fi
  if [ "$UV_OK" -eq 0 ] && have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)'; then
    echo "==> pip install uv (user site)"
    if python3 -m pip install --user uv 2>/dev/null; then UV_OK=1; fi
  fi
  if [ "$UV_OK" -eq 0 ] && have curl; then
    echo "==> curl astral.sh/uv/install.sh"
    if curl -fsSL https://astral.sh/uv/install.sh | sh 2>/dev/null; then
      export PATH="$HOME/.local/bin:$PATH"
      have uv && UV_OK=1
    fi
  fi
  [ "$UV_OK" -eq 1 ] || echo "note: uv unavailable; will fall back to system python3.11+"
fi

# --- Python + XY (.venv) ----------------------------------------------------
if [ ! -x .venv/bin/python ]; then
  echo "==> creating .venv (python >= 3.11 required for xy)"
  CREATED=0
  if have uv; then
    # uv downloads a managed CPython when the version is not present
    for v in 3.13 3.12 3.11; do
      if uv venv .venv --python "$v" 2>/dev/null; then CREATED=1; break; fi
    done
  fi
  if [ "$CREATED" -eq 0 ]; then
    PY311="$(for p in python3.13 python3.12 python3.11; do command -v "$p" && break; done)"
    if [ -z "$PY311" ]; then
      if install_brew python@3.13; then PY311="$(command -v python3.13)"; fi
    fi
    if [ -z "$PY311" ]; then
      echo "error: no python >= 3.11 available and auto-install failed. Install one (brew install python@3.13 / apt install python3.11) and re-run." >&2
      exit 1
    fi
    echo "==> $PY311 -m venv .venv"
    "$PY311" -m venv .venv
  fi
fi

if ! .venv/bin/python -c "import xy" >/dev/null 2>&1; then
  echo "==> installing xy into .venv"
  if have uv; then
    uv pip install --python .venv/bin/python xy matplotlib
  else
    .venv/bin/python -m pip install -q --upgrade pip
    .venv/bin/python -m pip install -q xy matplotlib
  fi
fi

echo "==> environment ready"
echo "    renderer:  node bin/md2html.mjs"
echo "    xy python: .venv/bin/python"
