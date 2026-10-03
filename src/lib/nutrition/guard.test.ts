import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Source guards for two standing rules that a unit test can't see:
 *
 * 1. DISPLAY-ONLY BURN. Workout calories are shown on the Diary but never change the food budget (the TDEE
 *    activity factor already counts training). So the budget math — targets.ts, math.ts — must never import
 *    the burn / calorie / Apple Health modules.
 * 2. NO SECRETS IN THE BUNDLE. The repo and Pages site are public: nothing under src/ may read a VITE_ env
 *    var for a key or contain a real-looking Anthropic key.
 */

const ROOT = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('display-only burn guard', () => {
  for (const f of ['lib/nutrition/targets.ts', 'lib/nutrition/math.ts']) {
    it(`${f} does not import burn / calories / appleHealth`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(imports.filter((i) => /burn|calories|appleHealth|workouts/.test(i))).toEqual([]);
    });
  }
});

describe('no secrets in the bundle', () => {
  it('no VITE_ key env vars and no real-looking Anthropic keys under src/', () => {
    const offenders: string[] = [];
    for (const f of walk(ROOT)) {
      if (f.endsWith('guard.test.ts')) continue;
      const src = readFileSync(f, 'utf8');
      if (/import\.meta\.env\.VITE_\w*(KEY|TOKEN|SECRET)/i.test(src)) offenders.push(f + ' (VITE_ key)');
      if (/sk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{20,}/.test(src)) offenders.push(f + ' (Anthropic key)');
    }
    expect(offenders).toEqual([]);
  });
});
