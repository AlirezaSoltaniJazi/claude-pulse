/**
 * Launches this extension in a VS Code Extension Development Host.
 *
 * Why this exists rather than a bare `code --extensionDevelopmentPath=.`:
 * when VS Code is already running, the CLI hands the request to the running
 * instance and DROPS the flag — you get the folder in an ordinary window using
 * the installed Marketplace build, which looks like it worked while running the
 * wrong code. Passing a dedicated --user-data-dir forces a separate instance, so
 * the development host actually starts. The profile dir is reused between runs,
 * so any settings applied there persist.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const profileDir = path.join(repoRoot, '.vscode-dev');

const CANDIDATES = [
  process.env.VSCODE_CLI,
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
  '/usr/share/code/bin/code',
  '/usr/bin/code',
  '/snap/bin/code',
].filter(Boolean);

function resolveCli() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fall back to PATH — works when the user ran "Shell Command: Install 'code'".
  return 'code';
}

const cli = resolveCli();
fs.mkdirSync(path.join(profileDir, 'data'), { recursive: true });
fs.mkdirSync(path.join(profileDir, 'extensions'), { recursive: true });

const args = [
  `--extensionDevelopmentPath=${repoRoot}`,
  `--user-data-dir=${path.join(profileDir, 'data')}`,
  `--extensions-dir=${path.join(profileDir, 'extensions')}`,
  '--new-window',
  repoRoot,
];

console.log(`Launching Extension Development Host via ${cli}`);
const child = spawn(cli, args, { detached: true, stdio: 'ignore' });

child.on('error', (err) => {
  console.error(`\nCould not launch VS Code: ${err.message}`);
  console.error("Install the CLI with Cmd+Shift+P -> \"Shell Command: Install 'code' command in PATH\",");
  console.error('or set VSCODE_CLI to the full path of the code binary.');
  process.exit(1);
});

child.unref();
console.log('A new VS Code window titled "[Extension Development Host]" should open shortly.');
