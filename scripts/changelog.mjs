// Pure CHANGELOG.md helpers shared by the version-bump script and its tests.
// Keep-a-Changelog format: a `## [Unreleased]` section is promoted to a dated
// version heading on release, a fresh empty `## [Unreleased]` is re-seeded, and
// the bottom compare-link reference definitions are kept in step.
//
// No I/O here — callers read/write the file. This module is intentionally plain
// ESM JS so `scripts/bump-version.mjs` (run by `node` in CI) can import it.

/** Normalize a package.json repository URL to a bare `https://host/owner/repo`. */
function normalizeRepoUrl(repoUrl) {
  return repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * Promote `## [Unreleased]` to `## [version] - date`, re-seed an empty
 * `## [Unreleased]` above it, and maintain the bottom reference-link defs.
 *
 * Pure and idempotent-safe: if there is no `## [Unreleased]` heading the input
 * is returned unchanged.
 *
 * @param {string} md Current CHANGELOG.md content.
 * @param {object} opts
 * @param {string} opts.version Version being released, e.g. `"0.3.0"` (no `v`).
 * @param {string} opts.date Release date, ISO `"YYYY-MM-DD"`.
 * @param {string} opts.repoUrl Repo URL, e.g. `"https://github.com/owner/repo"`.
 * @param {string} opts.prevVersion Previous released version, e.g. `"0.2.7"`.
 *   When equal to `version` (a "release current version" run) a `releases/tag`
 *   link is used instead of a compare range.
 * @returns {string} The rolled changelog.
 */
export function promoteChangelog(md, { version, date, repoUrl, prevVersion }) {
  if (!/^## \[Unreleased\]/m.test(md)) return md;

  const base = normalizeRepoUrl(repoUrl);

  // Insert the released heading just below a freshly-emptied `## [Unreleased]`,
  // leaving the existing notes attached to the new version section.
  let next = md.replace(/^## \[Unreleased\]\n/m, `## [Unreleased]\n\n## [${version}] - ${date}\n`);

  const unreleasedLink = `[Unreleased]: ${base}/compare/v${version}...HEAD`;
  const versionLink =
    prevVersion && prevVersion !== version
      ? `[${version}]: ${base}/compare/v${prevVersion}...v${version}`
      : `[${version}]: ${base}/releases/tag/v${version}`;

  if (/^\[Unreleased\]:.*$/m.test(next)) {
    // Replace the existing [Unreleased] def and slot the new version def below it.
    next = next.replace(/^\[Unreleased\]:.*$/m, () => `${unreleasedLink}\n${versionLink}`);
  } else {
    // No reference-link block yet — append a fresh one at the end.
    next = `${next.replace(/\n*$/, '')}\n\n${unreleasedLink}\n${versionLink}\n`;
  }

  return next;
}
