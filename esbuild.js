const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    // Pinned to the runtime of the OLDEST VS Code this extension claims to support
    // (engines.vscode ^1.85.0 ships Electron 25 / Node 18). CI cannot test on Node 18 —
    // eslint 10 and vitest 4 both require >=20 — so making the bundle downlevel-safe at
    // build time is the guarantee, not the test matrix. Raise this only with engines.vscode.
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode', 'node-notifier'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'watch-plugin',
        setup(build) {
          build.onStart(() => {
            console.log('[watch] build started');
          });
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error('[watch] build failed:', result.errors);
            } else {
              console.log('[watch] build finished');
            }
          });
        },
      },
    ],
  });

  if (watch) {
    await ctx.watch();
    console.log('[watch] watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
