// Production-only minification; editable source stays readable and buildless.
// esbuild runs from an existing binary or npm's external cache, not node_modules here.
import { readFile, writeFile, mkdir, mkdtemp, copyFile, rm, stat, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] || join(root, 'releases', `Ace-of-Sky-II-optimized-${new Date().toISOString().slice(0,10)}.zip`));
if (!output.endsWith('.zip')) throw new Error('Output must be a .zip file');
if (await access(output).then(() => true, () => false)) throw new Error(`Refusing to overwrite ${output}`);
const stage = await mkdtemp(join(tmpdir(), 'ace-sky-release-'));
function run(command, args, cwd = root){
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
}
function build(args){
  if (process.env.ESBUILD_BIN) run(process.env.ESBUILD_BIN, args);
  else run('npx', ['--yes', '--package=esbuild@0.28.0', 'esbuild', ...args]);
}
try {
  build(['js/main.js', '--bundle', '--minify', '--format=esm', '--target=es2022',
    '--alias:three=./vendor/three.module.js', `--outfile=${join(stage,'game.js')}`, '--legal-comments=eof']);
  build(['css/style.css', '--minify', `--outfile=${join(stage,'style.css')}`]);
  const html = (await readFile(join(root,'index.html'),'utf8'))
    .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
    .replace(/css\/style\.css\?v=[^" ]+/, 'style.css')
    .replace(/js\/main\.js\?v=[^" ]+/, 'game.js');
  await writeFile(join(stage,'index.html'), html);
  await mkdir(join(stage,'assets'));
  await copyFile(join(root,'assets/menu-music.mp3'), join(stage,'assets/menu-music.mp3'));
  await mkdir(dirname(output), { recursive: true });
  run('zip', ['-q', '-9', '-r', output, 'index.html', 'game.js', 'style.css', 'assets'], stage);
  run('unzip', ['-t', output]);
  console.log(JSON.stringify({ output, javascriptBytes: (await stat(join(stage,'game.js'))).size,
    zipBytes: (await stat(output)).size }, null, 2));
} finally {
  // Only the unique staging directory created above, never a user-supplied path.
  await rm(stage, { recursive: true, force: true });
}
