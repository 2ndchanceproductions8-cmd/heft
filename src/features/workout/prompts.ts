import { prompt } from '../../components/ui';
import { formatClock, parseClock } from '../../lib/units';

/** Max photos per workout. */
export const MAX_PHOTOS = 6;

/** Ask for a workout duration as h:mm:ss. Resolves null when cancelled. */
export async function promptDuration(currentSec: number): Promise<number | null> {
  const v = await prompt({
    title: 'Duration',
    message: 'Enter the workout time as h:mm:ss (e.g. 1:05:00).',
    initial: formatClock(currentSec),
    placeholder: '1:05:00',
    confirmLabel: 'Save',
    validate: (s) => {
      const n = parseClock(s);
      if (n == null) return 'Use h:mm:ss, e.g. 1:05:00';
      if (n <= 0) return 'Duration must be more than 0';
      if (n > 24 * 3600) return 'That is longer than a day';
      return null;
    },
  });
  if (v == null) return null;
  return parseClock(v);
}
