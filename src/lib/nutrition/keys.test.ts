import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FDC_DEMO_KEY, fdcKeyOrDemo, isGithubSecret, setFdcKey } from './keys';

/*
 * The USDA key goes into every food search URL (usda.ts), so a secret saved into that slot by mistake must never be
 * sent: fdcKeyOrDemo falls back to the demo key. Fake keys stay short and obvious (lib/secrets.guard.test.ts).
 */

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub key never goes to USDA', () => {
  it('isGithubSecret catches fine-grained and classic keys, quoted or after "Bearer "', () => {
    const classic = (g: string) => 'gh' + g + '_' + 'TEST'.repeat(5);
    for (const v of ['github_pat_TEST', 'Bearer github_pat_TEST', '"github_pat_TEST"', ...['p', 'o', 'u', 's', 'r'].map(classic)]) {
      expect(isGithubSecret(v)).toBe(true);
    }
    // A real api.data.gov key: 40 letters and digits, no underscore.
    for (const v of ['abcdEFGH1234abcdEFGH1234abcdEFGH1234abcd', 'DEMO_KEY', 'ghp_short', '', null, undefined]) {
      expect(isGithubSecret(v)).toBe(false);
    }
  });

  it('fdcKeyOrDemo sends the user’s own key, but never a GitHub or Claude key (the demo key instead)', () => {
    expect(fdcKeyOrDemo()).toBe(FDC_DEMO_KEY);
    setFdcKey('abcdEFGH1234abcdEFGH1234abcdEFGH1234abcd');
    expect(fdcKeyOrDemo()).toBe('abcdEFGH1234abcdEFGH1234abcdEFGH1234abcd');
    setFdcKey('github_pat_TEST');
    expect(fdcKeyOrDemo()).toBe(FDC_DEMO_KEY);
    setFdcKey('Bearer github_pat_TEST');
    expect(fdcKeyOrDemo()).toBe(FDC_DEMO_KEY);
    setFdcKey('sk-ant-test');
    expect(fdcKeyOrDemo()).toBe(FDC_DEMO_KEY);
  });
});
