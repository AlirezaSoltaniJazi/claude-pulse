#!/usr/bin/env bash
# validate-chrome-extension.sh — VS Code extension structure + convention checker
#
# NOTE ON THE FILENAME: this script predates a rewrite of the extensionDeveloper skill from
# Chrome-extension content to this project's actual domain (a VS Code extension). The filename
# is kept unchanged so existing references to it (SKILL.md, symlinked skill copies) keep working;
# only the checks below were rewritten. Despite the name, this script has nothing to do with
# Chrome/Manifest V3 — it checks claude-pulse's package.json + src/ layout.
#
# Usage: ./scripts/validate-chrome-extension.sh [project-root]

set -euo pipefail

ROOT="${1:-.}"
ERRORS=0
WARNINGS=0

red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }

error() { red "ERROR: $1"; ERRORS=$((ERRORS + 1)); }
warn() { yellow "WARN:  $1"; WARNINGS=$((WARNINGS + 1)); }
ok() { green "OK:    $1"; }

echo "=== VS Code Extension Validator ==="
echo "Root: $ROOT"
echo ""

# 1. Check package.json exists (the extension manifest — VS Code has no separate manifest.json)
if [ ! -f "$ROOT/package.json" ]; then
  error "package.json not found"
  echo ""
  echo "Results: $ERRORS errors, $WARNINGS warnings"
  exit 1
fi
ok "package.json found"

# 2. Check engines.vscode is declared
if grep -q '"vscode"[[:space:]]*:' "$ROOT/package.json" 2>/dev/null; then
  ok "engines.vscode declared"
else
  error "package.json is missing an engines.vscode field"
fi

# 3. Check main points at a built (dist/) entry, not a src/ file
MAIN=$(grep -o '"main"[[:space:]]*:[[:space:]]*"[^"]*"' "$ROOT/package.json" 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"')
if [[ "$MAIN" == dist/* || "$MAIN" == ./dist/* ]]; then
  ok "package.json main points at a dist/ build output ($MAIN)"
elif [ -n "$MAIN" ]; then
  warn "package.json main ('$MAIN') does not point into dist/ — confirm this is intentional"
else
  warn "package.json has no main field"
fi

# 4. Check at least one command is contributed
if grep -q '"commands"[[:space:]]*:' "$ROOT/package.json" 2>/dev/null; then
  ok "contributes.commands present"
else
  warn "No contributes.commands found in package.json"
fi

# 5. Check src/extension.ts exports activate() and deactivate()
ENTRY="$ROOT/src/extension.ts"
if [ -f "$ENTRY" ]; then
  if grep -q 'export function activate' "$ENTRY"; then
    ok "src/extension.ts exports activate()"
  else
    error "src/extension.ts does not export activate()"
  fi
  if grep -q 'export function deactivate' "$ENTRY"; then
    ok "src/extension.ts exports deactivate()"
  else
    warn "src/extension.ts does not export deactivate()"
  fi
else
  warn "src/extension.ts not found — skipping activate()/deactivate() check"
fi

# 6. This project ships NO browser extension code — flag any chrome.* usage as a real problem
if [ -d "$ROOT/src" ] && grep -rl 'chrome\.' "$ROOT/src" --include='*.ts' >/dev/null 2>&1; then
  error "chrome.* API usage found under src/ — this is a VS Code extension, not a Chrome extension"
else
  ok "No chrome.* API usage under src/"
fi

# 7. This project should have NO manifest.json (that's the Chrome-extension manifest, not VS Code's)
if [ -f "$ROOT/manifest.json" ]; then
  warn "manifest.json found at project root — VS Code extensions don't use one; confirm this is intentional"
else
  ok "No stray manifest.json at project root"
fi

# 8. Check for eval/new Function in source files
if [ -d "$ROOT/src" ] && find "$ROOT/src" -name "*.ts" 2>/dev/null | xargs grep -l '\beval\b\|new Function' 2>/dev/null; then
  error "eval() or new Function() found in source"
else
  ok "No eval/new Function usage in src/"
fi

# 9. Check TypeScript strict mode
if [ -f "$ROOT/tsconfig.json" ]; then
  ok "tsconfig.json found"
  if grep -q '"strict"[[:space:]]*:[[:space:]]*true' "$ROOT/tsconfig.json" 2>/dev/null; then
    ok "TypeScript strict mode enabled"
  else
    warn "TypeScript strict mode not enabled"
  fi
else
  warn "tsconfig.json not found"
fi

# 10. Check for source maps in dist/ (should be absent from a production build)
if [ -d "$ROOT/dist" ] && find "$ROOT/dist" -name "*.map" 2>/dev/null | head -1 | grep -q .; then
  warn "Source maps found in dist/ — remove for a production build (esbuild.js: sourcemap: !production)"
else
  ok "No source maps in dist/"
fi

# 11. Check @vscode/vsce is available for packaging
if grep -q '"@vscode/vsce"' "$ROOT/package.json" 2>/dev/null; then
  ok "@vscode/vsce present as a devDependency"
else
  warn "@vscode/vsce not found in package.json devDependencies — 'npm run package' will fail"
fi

echo ""
echo "=== Results ==="
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  green "All checks passed!"
elif [ $ERRORS -eq 0 ]; then
  yellow "$WARNINGS warnings (no errors)"
else
  red "$ERRORS errors, $WARNINGS warnings"
fi

exit $ERRORS
