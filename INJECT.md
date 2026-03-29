# Claude Pulse — Quick Reference

- **Stack**: TypeScript 5.3 (strict) + VS Code Extension API + esbuild + Vitest
- **Entry point**: `src/extension.ts` → `activate()` / `deactivate()`
- **Key dirs**: `src/data/` (readers, API, file watcher) · `src/ui/` (status bar, webview) · `src/config/` (settings) · `src/notifications/` (session monitor)
- **Run**: `npm run watch` + F5 · `npm test` · `npm run lint`
- **Patterns**: null-return error handling · module-level caches with TTL · event-driven refresh → cachedData → updateUI · Disposable pattern · dual file watching (FSWatch + polling)
- **Never**: throw from data readers · edit `dist/` · add settings to `package.json` without updating `configManager.ts` · convert `node-notifier` require to static import · simplify FileWatcher to FSWatch-only
- **Full context**: See [agents.md](agents.md)
