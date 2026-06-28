#!/usr/bin/env bash
# ============================================================
# DevNexus - Build and install locally into VS Code
# ============================================================
# Requires: Node.js 20+, VS Code 'code' CLI on PATH
# Run from the repo root: ./build-and-install.sh
# ============================================================

set -euo pipefail
cd "$(dirname "$0")"

echo
echo "[1/4] Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "ERROR: node not on PATH. Install Node 20+ from https://nodejs.org/"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm not on PATH."; exit 1; }
command -v code >/dev/null 2>&1 || { echo "ERROR: VS Code 'code' CLI not on PATH. In VS Code: Ctrl+Shift+P -> 'Shell Command: Install code command in PATH'."; exit 1; }
echo "  Node:    $(node --version)"
echo "  npm:     $(npm --version)"
echo "  VS Code: $(code --version | head -n1)"

echo
echo "[2/4] Installing npm dependencies (npm ci)..."
if [[ ! -d node_modules ]]; then
    npm ci
else
    echo "  node_modules already present, skipping. Delete it to force reinstall."
fi

echo
echo "[3/4] Compiling TypeScript and packaging extension..."
npx --yes @vscode/vsce@^2.22.0 package --no-dependencies

VSIX="$(ls -t devnexus-*.vsix 2>/dev/null | head -n1 || true)"
if [[ -z "${VSIX}" ]]; then
    echo "ERROR: No devnexus-*.vsix file found after packaging."
    exit 1
fi
echo "  Built: ${VSIX}"

echo
echo "[4/4] Installing ${VSIX} into VS Code..."
code --install-extension "${VSIX}" --force

cat <<EOF

============================================================
 DevNexus installed. Reload VS Code, then use @nexus
 in Copilot Chat. Configure devnexus.jira.baseUrl and
 devnexus.bitbucket.baseUrl in Settings before first use.
============================================================
EOF
