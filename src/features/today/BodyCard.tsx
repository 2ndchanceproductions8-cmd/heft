import { useMemo, useState } from 'react';
import { bodySummary, goalRateKgPerWeek } from '../../lib/today';
import { isAppleMobile } from '../../lib/healthImport';
import { useTargets } from '../../lib/nutrition/store';
import { useSettings } from '../../lib/settings';
import { useMeasurements } from './data';
import { BodyCardView } from './body/BodyCardView';
import { HumeSync } from './body/HumeSync';

export { BodyCardView, type BodyCardViewProps } from './body/BodyCardView';

/*
 * Today → Body (live): the Hume scale's weigh-ins (Apple Health → Measurements, or typed in), the smoothed trend
 * against the calorie target's pace, body fat and 30 days of weigh-ins; on iPhone, a row to pull the latest weigh-in
 * from Apple Health without leaving Today. The look is BodyCardView (pure, tested in body.render.test.ts).
 */
export function BodyCard({ today, now }: { today: string; now: number }) {
  const rows = useMeasurements();
  const targets = useTargets();
  const settings = useSettings();
  // Shortcuts (the Apple Health bridge) only exists on iPhone / iPad.
  const [onApple] = useState(isAppleMobile);

  const summary = useMemo(() => (rows ? bodySummary(rows, today) : undefined), [rows, today]);
  // Wait for the targets too: they come with the settings, so the unit and goal don't change under the first paint.
  const loaded = summary !== undefined && targets !== undefined;
  const goalRateKg = targets?.targets ? goalRateKgPerWeek(targets.targets) : null;

  return (
    <BodyCardView
      today={today}
      now={now}
      unit={settings.unit}
      summary={loaded ? summary : undefined}
      profileKg={settings.bodyweightKg}
      goalRateKg={goalRateKg}
      sync={onApple ? <HumeSync unit={settings.unit} now={now} loading={!loaded} /> : null}
    />
  );
}
