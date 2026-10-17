// Builds the options page (React + Kumo) into build/: options.js with esbuild, options.css
// with Tailwind. The content scripts aren't built; they ship as they are.
import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';

const watch = process.argv.includes('--watch');

const js = {
  entryPoints: ['options/index.jsx'],
  outfile: 'build/options.js',
  bundle: true,
  minify: !watch,
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome120',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'warning'
};

function css() {
  let args = ['@tailwindcss/cli', '-i', 'options/options.css', '-o', 'build/options.css'];
  args.push(watch ? '--watch' : '--minify');
  return new Promise((resolve, reject) => {
    let child = spawn('npx', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('tailwind exited with ' + code))));
  });
}

if (watch) {
  await (await context(js)).watch();
  await css();
} else {
  await Promise.all([build(js), css()]);
}
