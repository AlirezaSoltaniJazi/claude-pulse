#!/usr/bin/env bash
# validate-chrome-extension.sh — Manifest + structure convention checker
# Usage: ./scripts/validate-chrome-extension.sh [extension-root]

set -euo pipefail

ROOT="${1:-.}"
ERRORS=0
WARNINGS=0

red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }

error() { red "ERROR: $1"; ((ERRORS++)); }
warn() { yellow "WARN:  $1"; ((WARNINGS++)); }
ok() { green "OK:    $1"; }

echo "=== Chrome Extension Validator ==="
echo "Root: $ROOT"
echo ""

# 1. Check manifest.json exists
if [ ! -f "$ROOT/manifest.json" ]; then
  error "manifest.json not found"
  echo ""
  echo "Results: $ERRORS errors, $WARNINGS warnings"
  exit 1
fi
ok "manifest.json found"

# 2. Check manifest version
MV=$(grep -o '"manifest_version"[[:space:]]*:[[:space:]]*[0-9]*' "$ROOT/manifest.json" | grep -o '[0-9]*$')
if [ "$MV" = "3" ]; then
  ok "Manifest V3"
elif [ "$MV" = "2" ]; then
  error "Manifest V2 detected — migrate to V3"
else
  error "Unknown manifest version: $MV"
fi

# 3. Check for dangerous permissions
if grep -q '"<all_urls>"' "$ROOT/manifest.json" 2>/dev/null; then
  warn "<all_urls> permission found — use specific host patterns"
fi

if grep -q '"tabs"' "$ROOT/manifest.json" 2>/dev/null; then
  warn '"tabs" permission found — consider "activeTab" instead'
fi

if grep -q '"webRequest"' "$ROOT/manifest.json" 2>/dev/null; then
  warn '"webRequest" found — use "declarativeNetRequest" in MV3'
fi

# 4. Check for service worker
if grep -q '"service_worker"' "$ROOT/manifest.json" 2>/dev/null; then
  ok "Service worker declared"
else
  warn "No service_worker in manifest — background logic won't run"
fi

# 5. Check for eval/new Function in source files
if find "$ROOT/src" -name "*.ts" -o -name "*.js" 2>/dev/null | xargs grep -l '\beval\b\|new Function' 2>/dev/null; then
  error "eval() or new Function() found in source — violates MV3 CSP"
else
  ok "No eval/new Function usage"
fi

# 6. Check for innerHTML in content scripts
CONTENT_DIR="$ROOT/src/content"
if [ -d "$CONTENT_DIR" ]; then
  if find "$CONTENT_DIR" -name "*.ts" -o -name "*.js" 2>/dev/null | xargs grep -l 'innerHTML\|outerHTML' 2>/dev/null; then
    warn "innerHTML/outerHTML found in content scripts — XSS risk, use DOM API"
  else
    ok "No innerHTML in content scripts"
  fi
fi

# 7. Check for inline scripts in HTML
if find "$ROOT" -name "*.html" -not -path "*/node_modules/*" 2>/dev/null | xargs grep -l '<script[^>]*>[^<]' 2>/dev/null; then
  error "Inline scripts found in HTML — violates CSP"
else
  ok "No inline scripts in HTML"
fi

# 8. Check TypeScript config
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

# 9. Check for source maps in dist
if find "$ROOT/dist" -name "*.map" 2>/dev/null | head -1 | grep -q .; then
  warn "Source maps found in dist/ — remove for production builds"
else
  ok "No source maps in dist/"
fi

# 10. Check package.json
if [ -f "$ROOT/package.json" ]; then
  ok "package.json found"
else
  warn "package.json not found"
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
