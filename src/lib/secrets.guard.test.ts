import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * NO GITHUB TOKENS IN THE SOURCE. Heft's repo and Pages site are public, so a real token must never be committed:
 * not in code, a fixture, a test or a comment. (The automatic Hume sync, removed 2026-10-10, used one; the guard
 * stays.) Fake tokens in tests stay short and obvious ('github_pat_TEST').
 *
 * Same shape as lib/nutrition/guard.test.ts (which guards the Anthropic key). Offenders are reported by file and line
 * only: the matched text is never printed.
 */

const SRC = join(__dirname, '..');

/** Fine-grained (github_pat_…) and classic / OAuth / user-to-server / server-to-server / refresh tokens. */
const TOKEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'fine-grained GitHub token', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** "path:line (kind)" for every line that looks like it holds a real token. */
function findTokens(text: string, file: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const { name, re } of TOKEN_PATTERNS) if (re.test(line)) hits.push(`${file}:${i + 1} (${name})`);
  });
  return hits;
}

describe('no GitHub tokens under src/', () => {
  it('the patterns catch real-looking tokens and let obvious fakes through', () => {
    // Built at runtime so this file never contains a token-shaped string itself.
    const fine = 'github_pat_' + '11ABCDEFG0' + 'x'.repeat(40);
    const classic = 'gh' + 'p_' + 'A1b2C3d4'.repeat(5);
    expect(findTokens(`const k = "${fine}";`, 'a.ts')).toEqual(['a.ts:1 (fine-grained GitHub token)']);
    expect(findTokens(`Authorization: Bearer ${classic}`, 'b.ts')).toEqual(['b.ts:1 (GitHub token)']);
    for (const g of ['o', 'u', 's', 'r']) expect(findTokens('gh' + g + '_' + 'Z9'.repeat(18), 'c.ts')).toHaveLength(1);
    expect(findTokens("setInboxToken('github_pat_TEST')", 'd.ts')).toEqual([]);
    expect(findTokens("placeholder={'github_pat_…'}", 'e.ts')).toEqual([]);
  });

  it('no file under src/ contains a real-looking GitHub token', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(50); // the walk really saw the source tree
    const offenders: string[] = [];
    for (const f of files) offenders.push(...findTokens(readFileSync(f, 'utf8'), relative(SRC, f)));
    expect(offenders).toEqual([]);
  });
});
