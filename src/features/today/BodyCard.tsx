import { useMemo, useState } from 'react';
import { bodySummary, goalRateKgPerWeek } from '../../lib/today';
import { useTargets } from '../../lib/nutrition/store';
import { useSettings } from '../../lib/settings';
import { MeasurementSheet } from '../progress/components/MeasurementSheet';
import { useMeasurements } from './data';
import { BodyCardView } from './body/BodyCardView';
import { WeighInsSheet } from './body/WeighInsSheet';
import { weighInList } from './body/weighIns';

export { BodyCardView, type BodyCardViewProps } from './body/BodyCardView';

/*
 * Today → Body (live): the typed weigh-ins, the smoothed trend against the calorie target's pace, body fat and 30
 * days of weigh-ins. "Log today's weight" opens the Measurements entry sheet right here (Save closes it and the card
 * updates). Tapping the big number opens the Weigh-ins sheet, where a wrong reading is deleted. The look is
 * BodyCardView (pure, tested in body.render.test.ts).
 */
export function BodyCard({ today, now }: { today: string; now: number }) {
  const rows = useMeasurements();
  const targets = useTargets();
  const settings = useSettings();
  const [listOpen, setListOpen] = useState(false);
  // A fresh key per open, so the sheet starts empty every time.
  const [logKey, setLogKey] = useState<number | null>(null);

  const summary = useMemo(() => (rows ? bodySummary(rows, today) : undefined), [rows, today]);
  const list = useMemo(() => (rows && listOpen ? weighInList(rows, today) : []), [rows, today, listOpen]);
  // Wait for the targets too: they come with the settings, so the unit and goal don't change under the first paint.
  const loaded = summary !== undefined && targets !== undefined;
  const goalRateKg = targets?.targets ? goalRateKgPerWeek(targets.targets) : null;

  return (
    <>
      <BodyCardView
        today={today}
        now={now}
        unit={settings.unit}
        summary={loaded ? summary : undefined}
        profileKg={settings.bodyweightKg}
        goalRateKg={goalRateKg}
        onShowWeighIns={() => setListOpen(true)}
        onLogWeight={() => setLogKey(Date.now())}
      />
      <WeighInsSheet open={listOpen} onClose={() => setListOpen(false)} items={list} unit={settings.unit} today={today} />
      {logKey != null ? (
        <MeasurementSheet key={logKey} open entry={null} unit={settings.unit} onClose={() => setLogKey(null)} />
      ) : null}
    </>
  );
}
