import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ExerciseProvider } from '../../lib/ExerciseProvider';
import { ExercisePicker } from './ExercisePicker';

// The server renderer has no portals — render sheet content inline instead.
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));
vi.stubGlobal('document', { body: {} });

const render = (props: Partial<Parameters<typeof ExercisePicker>[0]> = {}) =>
  renderToString(
    h(
      MemoryRouter,
      null,
      h(ExerciseProvider, null, h(ExercisePicker, { open: true, onClose: () => {}, onAdd: () => {}, ...props })),
    ),
  );

describe('ExercisePicker (SSR smoke)', () => {
  it('renders nothing while closed', () => {
    expect(render({ open: false })).toBe('');
  });
  it('renders the header, tabs, filters and the first page of exercises', () => {
    const html = render();
    expect(html).toContain('Add Exercise');
    expect(html).toContain('Cancel');
    expect(html).toContain('Create');
    expect(html).toContain('Routines');
    expect(html).toContain('Recent');
    expect(html).toContain('All Equipment');
    expect(html).toContain('All Muscles');
    expect(html).toContain('All Exercises');
    // incremental rendering: only the first page of ~750 rows
    const rows = html.match(/aria-pressed="false"/g)?.length ?? 0;
    expect(rows).toBeGreaterThan(30);
    expect(rows).toBeLessThan(120);
  });
  it('honours title and hideRoutinesTab', () => {
    const html = render({ title: 'Replace Exercise', hideRoutinesTab: true, single: true });
    expect(html).toContain('Replace Exercise');
    expect(html).not.toContain('>Routines<');
  });
});
