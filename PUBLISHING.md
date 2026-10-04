# Publishing a New Version

## Prerequisites

- [Node.js](https://nodejs.org/) 22+ installed (`@vscode/vsce` 4 requires it)
- `@vscode/vsce` — already a devDependency (`npm install` pulls it in); a global install is only needed if you want to run bare `vsce` commands outside `npm run`/`npx`
- A VS Code Marketplace Personal Access Token (PAT) — see [Managing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- `VSCE_PAT` secret configured in GitHub repository settings (**Settings → Secrets and variables → Actions**) — publishing only happens via CI, there is no local publish path. Create the token in [Azure DevOps](https://dev.azure.com/) → User settings → Personal access tokens, with **Organization: All accessible organizations** and **Scopes: Custom defined → Marketplace → Manage**. A token scoped to a single organization is accepted by Azure DevOps but rejected by the Marketplace.

## Before You Publish

1. **Open a PR against `main`** with your changes.

2. **Update `CHANGELOG.md`** — add your entries under the existing `## [Unreleased]` heading. Don't add a version number or date yourself — the release workflow promotes `[Unreleased]` to `## [x.y.z] - <date>` automatically when it cuts the release. Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

3. **Run checks locally** (optional but recommended):
   ```bash
   npm run lint
   npm run format:check
   npm run typecheck
   npm test
   npm run build
   ```

4. **Label the PR** `release:patch`, `release:minor`, or `release:major` and merge it.

## Publishing

Releases are cut entirely by the [release workflow](.github/workflows/release.yml) — there is no local `vsce publish` step to run.

### Option A: Merge a labelled PR (normal case)

Merging a PR into `main` carrying a `release:patch`, `release:minor`, or `release:major` label triggers the workflow, which:
- Runs lint, format check, typecheck, build, and tests
- Bumps `package.json`/`package-lock.json` and promotes the CHANGELOG's `[Unreleased]` section (via `scripts/bump-version.mjs`)
- Packages the extension (`vsce package --no-update-package-json`)
- Commits the bump, tags it `vX.Y.Z`, and pushes both to `main`
- Creates a GitHub Release — notes come from the promoted CHANGELOG section — with the `.vsix` attached
- Publishes that same `.vsix` to the VS Code Marketplace via `vsce publish`

Dependabot PRs and PRs from forks never trigger a release, even if labelled.

### Option B: Manual dispatch

Go to **Actions → Release → Run workflow** and choose a bump (`patch`, `minor`, `major`, or `current` to re-release the existing version without bumping). This runs the same steps as Option A.

### Option C: Marketplace only (recover a half-finished release)

If a version is tagged and on GitHub Releases but never reached the Marketplace, run the workflow with **`marketplace-only`**. It downloads the `.vsix` already attached to the GitHub Release for the current version and publishes exactly that file — no bump, no commit, no tag, no new GitHub Release.

## Version Bump Types

| Label / dispatch input | When to use | Example |
|---|---|---|
| `release:patch` / `patch` | Bug fixes, docs updates, minor tweaks | 0.2.1 → 0.2.2 |
| `release:minor` / `minor` | New features, non-breaking changes | 0.2.1 → 0.3.0 |
| `release:major` / `major` | Breaking changes | 0.2.1 → 1.0.0 |

Locally, `npm run bump:patch` / `bump:minor` / `bump:major` run the same version bump + CHANGELOG promotion (via `scripts/bump-version.mjs`) without tagging, packaging, or publishing — useful to preview what a release will look like.

## What `npm run release` Does

```
npm run lint && npm run format:check && npm run typecheck && npm test && npm run package
```

1. **Lint** — ESLint checks
2. **Format check** — Prettier verification
3. **Typecheck** — `tsc --noEmit`
4. **Test** — Vitest test suite
5. **Package** — `npm run build` then `vsce package --no-update-package-json`, producing a `.vsix`

This is the same local verification the release workflow runs before it bumps anything — it does **not** publish. Use it to sanity-check a PR before labelling it.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `vsce publish` fails with 409 | Version already exists — re-run the release workflow (it bumps automatically) |
| "Repository secret VSCE_PAT is not set" | The secret doesn't exist or is misnamed. Add it as described under Prerequisites, then run **`marketplace-only`** to publish the version that was already tagged |
| `TF400813: The user 'aaaaaaaa-…' is not authorized` | The token reached the Marketplace empty — same fix as above. The run now stops at **Verify Marketplace token** before tagging, so this should no longer appear |
| "VSCE_PAT is set but cannot publish" / `VSCE_PAT` expired | Generate a new PAT in [Azure DevOps](https://dev.azure.com/) (All accessible organizations, Marketplace → Manage) and update the GitHub secret |
| Release workflow didn't trigger | Check the PR was merged (not just closed), carries a `release:*` label, isn't from a fork, and isn't from `dependabot[bot]` |
| Tests fail during release | Fix tests first — the workflow aborts on any lint/format/typecheck/test failure before bumping anything |
