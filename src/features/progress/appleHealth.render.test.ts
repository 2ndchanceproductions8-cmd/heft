// Server-render test for Settings → Apple Health: only the "send workouts to Health" Shortcut is left. The Hume
// weigh-in import (paste and automatic) was removed on 2026-10-10 (no DOM library).
import 'fake-indexeddb/auto';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppleHealthPage } from './AppleHealthPage';

/** Visible text, a space at every tag boundary (a row's label and its chip are separate elements). */
const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,:;)])/g, '$1')
    .replace(/\( /g, '(');

const render = (path = '/settings/apple-health') => renderToString(h(MemoryRouter, { initialEntries: [path] }, h(AppleHealthPage)));

describe('Apple Health page', () => {
  it('still walks through the Heft to Health Shortcut, the switch and troubleshooting', () => {
    const out = textOf(render());
    expect(out).toContain('Send workouts to Health');
    expect(out).toContain('Heft to Health');
    expect(out).toContain('Log Workout');
    expect(out).toContain('Show Send button');
    expect(out).toContain('If sending is off');
  });

  it('has nothing left of the Hume weigh-in import', () => {
    const html = render('/settings/apple-health?to=auto');
    const out = textOf(html);
    expect(out).not.toMatch(/Hume/);
    expect(out).not.toMatch(/weigh-in/i);
    expect(out).not.toContain('Health to Heft');
    expect(out).not.toMatch(/heft-inbox|GitHub|personal-access-tokens/);
    expect(html).not.toMatch(/id="(weigh-ins|auto)"/);
  });
});
