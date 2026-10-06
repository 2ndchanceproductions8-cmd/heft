// Server-render test for Settings → Apple Health's "How to use it" steps (no DOM library).
import 'fake-indexeddb/auto';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppleHealthPage } from './AppleHealthPage';

const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

describe('Apple Health page', () => {
  it("step 2 points at Today's Body card first, Measurements second", () => {
    const out = textOf(renderToString(h(MemoryRouter, { initialEntries: ['/settings/apple-health'] }, h(AppleHealthPage))));
    expect(out).toContain("In Heft, tap Get from Health on Today's Body card (or in Progress → Measurements). The Shortcut runs");
    expect(out).not.toContain('open Progress → Measurements and tap Get from Health');
  });
});
