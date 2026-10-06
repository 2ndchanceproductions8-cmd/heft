import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Source guard for a base style a render test can't see: links (Today's whole-card links, History's workout cards)
 * must not keep WebKit's long-press callout, or a resting thumb opens iOS's link preview / Copy Link menu.
 */

describe('index.css base layer', () => {
  it('turns off the long-press callout and text selection on links', () => {
    const css = readFileSync(join(__dirname, 'index.css'), 'utf8');
    const rule = css.match(/\n\s*a\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/-webkit-touch-callout:\s*none;/);
    expect(rule).toMatch(/-webkit-user-select:\s*none;/);
    expect(rule).toMatch(/(^|[^-])user-select:\s*none;/);
  });
});
