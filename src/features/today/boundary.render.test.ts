// Server-render tests for a Today card's error box (no DOM library: the error state is set by hand).
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardBoundary } from './CardBoundary';

describe('CardBoundary', () => {
  it('renders the card itself while nothing has thrown', () => {
    expect(renderToString(h(CardBoundary, { title: 'Body', children: h('p', null, 'card body') }))).toContain('card body');
  });

  it('a crashed card shows a full-size Retry button (h-11: the 40px+ touch target rule)', () => {
    const b = new CardBoundary({ title: 'Body', children: null });
    b.state = CardBoundary.getDerivedStateFromError(new Error('IndexedDB went away'));
    const html = renderToString(b.render());
    expect(html.replace(/<!-- -->/g, '')).toContain('Body couldn&#x27;t load');
    expect(html).toContain('IndexedDB went away');
    const retry = html.match(/<button[^>]*>Retry<\/button>/)?.[0] ?? '';
    expect(retry).toMatch(/\bh-11\b/);
    expect(retry).not.toMatch(/\bh-8\b/);
  });
});
