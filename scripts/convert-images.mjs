// Converts free-exercise-db JPGs (850x567, ~72KB) into 600px WebP (~20KB) under public/ex/<id>/<n>.webp.
// Usage: node scripts/convert-images.mjs <path-to-free-exercise-db/exercises>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error('usage: node scripts/convert-images.mjs <free-exercise-db/exercises dir>');
  process.exit(1);
}
const out = join(root, 'public', 'ex');

const jobs = [];
for (const id of readdirSync(src)) {
  const dir = join(src, id);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (!/\.jpe?g$/i.test(f)) continue;
    const dest = join(out, id, f.replace(/\.jpe?g$/i, '.webp'));
    if (existsSync(dest)) continue;
    jobs.push({ from: join(dir, f), to: dest });
  }
}
console.log(`converting ${jobs.length} images`);

let done = 0, failed = 0;
function run(job) {
  return new Promise((resolve) => {
    mkdirSync(dirname(job.to), { recursive: true });
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', job.from, '-vf', 'scale=600:-2', '-c:v', 'libwebp', '-quality', '72', job.to]);
    p.on('close', (code) => {
      if (code !== 0) failed++;
      done++;
      if (done % 200 === 0) console.log(`${done}/${jobs.length}`);
      resolve();
    });
  });
}
const pool = Math.max(2, os.cpus().length - 2);
let i = 0;
await Promise.all(Array.from({ length: pool }, async () => {
  while (i < jobs.length) await run(jobs[i++]);
}));
console.log(`done ${done}, failed ${failed}`);
