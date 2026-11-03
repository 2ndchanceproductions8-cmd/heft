import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirm } from '../../components/ui';
import { startNewRoutine } from './routineActions';

/*
 * "New routine" asks FIRST whether to start a workout too (a routine only plans; Justin built one expecting it to
 * log the session). Yes → the editor opens with ?start=1, which makes Save start the workout.
 */

vi.mock('../../components/ui', async (orig) => ({ ...(await orig<typeof import('../../components/ui')>()), confirm: vi.fn() }));

const ask = (answer: boolean) => vi.mocked(confirm).mockResolvedValueOnce(answer);

describe('startNewRoutine', () => {
  const navigate = vi.fn();
  beforeEach(() => {
    navigate.mockReset();
    vi.mocked(confirm).mockReset();
  });

  it('asks the question before anything opens, and names the choice plainly', async () => {
    ask(false);
    await startNewRoutine(navigate);
    const opts = vi.mocked(confirm).mock.calls[0][0];
    expect(opts.title).toBe('Start a workout too?');
    expect(opts.message).toMatch(/only plans/);
    expect(opts.confirmLabel).toBe('Yes, start workout');
    expect(opts.cancelLabel).toBe('No, just the routine');
  });

  it('yes → the editor opens in start mode', async () => {
    ask(true);
    await startNewRoutine(navigate);
    expect(navigate).toHaveBeenCalledWith('/routines/new?start=1');
  });

  it('no → a plain routine (no start flag)', async () => {
    ask(false);
    await startNewRoutine(navigate);
    expect(navigate).toHaveBeenCalledWith('/routines/new');
  });

  it('keeps the folder, for a routine begun inside one', async () => {
    ask(true);
    await startNewRoutine(navigate, 'f 1');
    expect(navigate).toHaveBeenCalledWith('/routines/new?folder=f+1&start=1');
    ask(false);
    await startNewRoutine(navigate, 'f1');
    expect(navigate).toHaveBeenLastCalledWith('/routines/new?folder=f1');
  });
});
