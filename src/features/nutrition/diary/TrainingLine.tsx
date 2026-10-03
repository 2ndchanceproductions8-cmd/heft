import { useState } from 'react';
import { Dumbbell, Info } from 'lucide-react';
import { Button, IconButton, Sheet } from '../../../components/ui';
import type { DayBurn } from '../../../lib/nutrition/burn';
import { formatKcal } from '../ui';

/**
 * "Workouts: 312 kcal active · already in your target" — DISPLAY ONLY. The number is never added to the
 * budget (the activity level in Food settings already counts the training), so there is no "+" anywhere.
 * Without a target (body fields missing) there is nothing for it to be "in", so the line is just the number.
 */
export function TrainingLine({ burn, hasTarget, onSettings }: { burn: DayBurn | undefined; hasTarget: boolean; onSettings: () => void }) {
  const [info, setInfo] = useState(false);
  if (!burn || burn.workouts <= 0) return null;
  return (
    <>
      <div className="mx-4 mt-2 flex items-center gap-2 pl-1 text-[13px] text-muted">
        <Dumbbell className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 leading-snug">
          Workouts: <span className="tabular-nums">{formatKcal(burn.activeKcal)}</span> kcal active
          {hasTarget ? ' · already in your target' : null}
        </span>
        <IconButton label="Why workout calories aren't added" tone="muted" onClick={() => setInfo(true)}>
          <Info className="h-[18px] w-[18px]" />
        </IconButton>
      </div>
      <Sheet open={info} onClose={() => setInfo(false)} title="Workout calories">
        <div className="space-y-3 px-5 pb-5 text-[15px] leading-snug">
          <p>
            {hasTarget
              ? 'Your daily target already includes your training: it comes from the activity level you picked in Food settings.'
              : 'Once you set up your daily target, it includes your training: it comes from the activity level you pick in Food settings.'}
          </p>
          <p className="text-muted">
            So workout calories are shown here but not added back to what you can eat. Adding them would count your
            training twice.
          </p>
          <p className="text-muted">Training more or less than you set? Change your activity level instead.</p>
          <Button
            block
            onClick={() => {
              setInfo(false);
              onSettings();
            }}
          >
            {hasTarget ? 'Change activity in Food settings' : 'Set up targets in Food settings'}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
