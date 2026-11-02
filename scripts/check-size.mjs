// Include hidden files, nested relay source, and releases; don't follow symlinks.
import { readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let bytes = 0, diskBytes = 0;
async function visit(path){
  const s = await lstat(path);
  bytes += s.size; diskBytes += (s.blocks ?? Math.ceil(s.size / 512)) * 512;
  if (s.isDirectory()) for (const name of await readdir(path)) await visit(join(path,name));
}
await visit(root);
const limit = 50_000_000, passed = Math.max(bytes,diskBytes) < limit;
console.log(JSON.stringify({ passed, bytes, diskBytes, limit }, null, 2));
if (!passed) process.exitCode = 1;
