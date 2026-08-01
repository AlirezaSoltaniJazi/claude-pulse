#!/usr/bin/env node
/**
 * Bumps the version and promotes the CHANGELOG, then prints the new version to
 * stdout so the release workflow can capture it.
 *
 * Unlike the Chrome-extension siblings there is no manifest.json to keep in
 * lockstep here — package.json is the single source of truth, and VS Code reads
 * its version straight out of the packaged manifest.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promoteChangelog } from './changelog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const bump = process.argv[2];
// `current` releases the current version without bumping (e.g. the first tag, or
// re-cutting a release) — it still promotes the changelog's [Unreleased] section.
if (!['patch', 'minor', 'major', 'current'].includes(bump)) {
  console.error('Usage: node scripts/bump-version.mjs <patch|minor|major|current>');
  process.exit(1);
}

const pkgPath = resolve(root, 'package.json');
const pkgText = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgText);
const pkgVersion = pkg.version;

const parts = pkgVersion.split('.').map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
  console.error(`package.json version "${pkgVersion}" is not a plain semver MAJOR.MINOR.PATCH.`);
  process.exit(1);
}
const [major, minor, patch] = parts;

let next;
if (bump === 'patch') next = `${major}.${minor}.${patch + 1}`;
else if (bump === 'minor') next = `${major}.${minor + 1}.0`;
else if (bump === 'major') next = `${major + 1}.0.0`;
else next = pkgVersion; // current

// Replace only the top-level "version" field. This preserves the rest of the
// file's formatting exactly, so a CI bump never shows up as a reformat.
function replaceVersion(text, current, nextVersion) {
  const needle = `"version": "${current}"`;
  if (!text.includes(needle)) {
    throw new Error(`Could not find "${needle}" — check the file's formatting.`);
  }
  return text.replace(needle, `"version": "${nextVersion}"`);
}

// `current` releases the existing version, so leave the version files untouched.
if (bump !== 'current') {
  writeFileSync(pkgPath, replaceVersion(pkgText, pkgVersion, next));

  // Keep package-lock.json in sync so the lockfile version doesn't drift on CI
  // bumps. It is prettier-ignored, so re-serializing with 2-space indent is fine.
  const lockPath = resolve(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.version = next;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = next;
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
}

// Promote the changelog's [Unreleased] section to this release and re-seed a
// fresh empty [Unreleased]. The GitHub Release notes are taken from the newly
// promoted section by the release workflow.
const changelogPath = resolve(root, 'CHANGELOG.md');
if (existsSync(changelogPath)) {
  const md = readFileSync(changelogPath, 'utf8');
  const repoUrl = (pkg.repository && pkg.repository.url) || pkg.repository || '';
  const date = new Date().toISOString().slice(0, 10);
  const rolled = promoteChangelog(md, { version: next, date, repoUrl, prevVersion: pkgVersion });
  if (rolled !== md) writeFileSync(changelogPath, rolled);
}

console.log(next);
