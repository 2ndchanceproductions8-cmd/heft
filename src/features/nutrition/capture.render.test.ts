// Server-render test for the capture screen's back button (no DOM library: effects and taps don't run).
import 'fake-indexeddb/auto';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CapturePage } from './CapturePage';

describe('capture back button', () => {
  it('is a plain "Back": opened from Today it returns to Today, not always to Food', () => {
    const html = renderToString(h(MemoryRouter, { initialEntries: ['/nutrition/log'] }, h(CapturePage)));
    expect(html).toContain('aria-label="Back"');
    expect(html).not.toContain('Back to Food');
  });
});
