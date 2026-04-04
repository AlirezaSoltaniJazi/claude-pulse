# Publishing a New Version

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ installed
- `@vscode/vsce` installed globally: `npm install -g @vscode/vsce`
- A VS Code Marketplace Personal Access Token (PAT) — see [Managing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- For CI publishing: `VSCE_PAT` secret configured in GitHub repository settings

## Before You Publish

1. **Merge to `main`** — ensure your feature branch is merged and you are on `main`:
   ```bash
   git checkout main
   git pull origin main
   ```

2. **Update `CHANGELOG.md`** — add a new entry at the top under `## [Unreleased]` or directly with the new version number and today's date. Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

3. **Run checks locally** (optional but recommended):
   ```bash
   npm run lint
   npm run format:check
   npm test
   npm run build
   ```

## Publishing

Choose **one** of the two approaches below. Do not mix them — using both causes a double publish.

### Option A: CI-based Publish (Recommended)

Let GitHub Actions handle the publish automatically.

```bash
# 1. Bump version (creates commit + v* tag)
npm version patch    # or: npm version minor / npm version major

# 2. Push commit and tag
git push && git push --tags
```

This triggers the [release workflow](.github/workflows/release.yml) which:
- Runs lint, tests, and build
- Publishes to VS Code Marketplace via `vsce publish`
- Creates a GitHub Release with auto-generated release notes

### Option B: Local Publish

Publish directly from your machine.

```bash
# 1. Bump version (creates commit + v* tag)
npm version patch    # or: npm version minor / npm version major

# 2. Lint, test, build, package, and publish
npm run release

# 3. Push the commit only (do NOT push tags to avoid triggering CI publish)
git push
```

> **Warning:** If you push the tag after a local publish, the CI workflow will attempt to publish again, causing a conflict. Only push the commit.

## Version Bump Types

| Command             | When to use                                      | Example          |
|---------------------|--------------------------------------------------|------------------|
| `npm version patch` | Bug fixes, docs updates, minor tweaks            | 0.2.1 → 0.2.2   |
| `npm version minor` | New features, non-breaking changes               | 0.2.1 → 0.3.0   |
| `npm version major` | Breaking changes                                 | 0.2.1 → 1.0.0   |

## What `npm run release` Does

```
npm run lint && npm run format:check && npm test && npm run build && vsce package && vsce publish
```

1. **Lint** — ESLint checks
2. **Format check** — Prettier verification
3. **Test** — Vitest test suite
4. **Build** — esbuild production bundle
5. **Package** — creates `.vsix` file
6. **Publish** — uploads to VS Code Marketplace

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `vsce publish` fails with 409 | Version already exists — bump again or check Marketplace |
| `VSCE_PAT` expired | Generate a new PAT in [Azure DevOps](https://dev.azure.com/) and update the GitHub secret |
| CI publish + local publish conflict | Pick one approach; delete the duplicate tag if needed: `git tag -d v0.x.x && git push origin :refs/tags/v0.x.x` |
| Tests fail during release | Fix tests first — `npm run release` aborts on any step failure |
