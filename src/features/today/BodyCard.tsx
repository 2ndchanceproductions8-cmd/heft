import { useMemo, useState } from 'react';
import { bodySummary, goalRateKgPerWeek } from '../../lib/today';
import { isAppleMobile } from '../../lib/healthImport';
import { useInboxStatus } from '../../lib/healthInbox';
import { useTargets } from '../../lib/nutrition/store';
import { useSettings } from '../../lib/settings';
import { useMeasurements } from './data';
import { BodyCardView } from './body/BodyCardView';
import { HumeSync } from './body/HumeSync';
import { WeighInsSheet } from './body/WeighInsSheet';
import { weighInList } from './body/weighIns';

export { BodyCardView, type BodyCardViewProps } from './body/BodyCardView';

/*
 * Today → Body (live): the Hume scale's weigh-ins (Apple Health → Measurements, automatically through the inbox or
 * pasted, or typed in), the smoothed trend against the calorie target's pace, body fat and 30 days of weigh-ins.
 * Tapping the big number opens the Weigh-ins sheet, where a wrong reading is deleted. Under the card, the Hume row:
 * the automatic sync's status, or on iPhone / iPad the by-hand Get / Paste. The look is BodyCardView (pure, tested
 * in body.render.test.ts).
 */
export function BodyCard({ today, now }: { today: string; now: number }) {
  const rows = useMeasurements();
  const targets = useTargets();
  const settings = useSettings();
  const inbox = useInboxStatus();
  // Shortcuts (the by-hand bridge) only exists on iPhone / iPad; automatic sync shows its status on any device.
  const [onApple] = useState(isAppleMobile);
  const [listOpen, setListOpen] = useState(false);

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
        sync={onApple || inbox.configured ? <HumeSync unit={settings.unit} now={now} inbox={inbox} loading={!loaded} /> : null}
        onShowWeighIns={() => setListOpen(true)}
      />
      <WeighInsSheet open={listOpen} onClose={() => setListOpen(false)} items={list} unit={settings.unit} today={today} />
    </>
  );
}
