import { Target } from 'lucide-react';
import { Button, Card, Spinner, cx } from '../../../components/ui';
import { remaining } from '../../../lib/nutrition/math';
import { BODY_FIELD_LABEL, type BodyField } from '../../../lib/nutrition/targets';
import type { Targets, Totals } from '../../../lib/nutrition/types';
import { formatKcal, MacroBar, Ring } from '../ui';

/** "sex", "sex and height", "sex, birth year and height". */
export function joinFields(fields: BodyField[]): string {
  const names = fields.map((f) => BODY_FIELD_LABEL[f].toLowerCase());
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The day's budget: a ring of kcal eaten vs target with what's left (or over) in the middle, and macro bars.
 * Budget = target − eaten; workout burn is never part of it (see lib/nutrition/math.ts remaining()).
 * Without body data there is no target: eaten totals still show, plus a prompt naming the missing fields.
 */
export function TargetsSummary({
  totals,
  targets,
  missing,
  loading,
  onSetup,
}: {
  totals: Totals | undefined;
  targets: Targets | null;
  missing: BodyField[];
  /** Totals or targets still loading. */
  loading: boolean;
  onSetup: () => void;
}) {
  if (loading || !totals) {
    return (
      <Card className="mx-4 flex h-[188px] items-center justify-center">
        <Spinner />
      </Card>
    );
  }

  if (!targets) {
    return (
      <Card className="mx-4 p-4">
        <div className="flex items-center gap-4">
          <div className="w-[108px] shrink-0 text-center">
            <div className="text-[30px] leading-none font-bold tabular-nums">{formatKcal(totals.kcal)}</div>
            <div className="mt-1 text-[13px] text-muted">kcal eaten</div>
          </div>
          <Macros totals={totals} targets={null} />
        </div>
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-surface-2 p-3">
          <Target className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">Set up your daily target</div>
            <div className="mt-0.5 text-[13px] leading-snug text-muted">
              Add your {missing.length ? joinFields(missing) : 'body details'} to get a calorie and macro target.
            </div>
            <Button variant="soft" className="mt-2.5" onClick={onSetup}>
              Set up targets
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const left = remaining(targets.kcal, totals.kcal);
  const over = left < 0;
  return (
    <Card className="mx-4 p-4">
      <div className="flex items-center gap-4">
        <div className="flex shrink-0 flex-col items-center">
          <Ring value={totals.kcal} max={targets.kcal} size={120}>
            <span
              aria-label={over ? `${formatKcal(-left)} kcal over` : `${formatKcal(left)} kcal left`}
              className={cx('text-[26px] leading-none font-bold tabular-nums', over ? 'text-danger' : 'text-fg')}
            >
              {formatKcal(Math.abs(left))}
            </span>
            <span className={cx('mt-1 text-[12px] font-semibold', over ? 'text-danger' : 'text-muted')}>{over ? 'over' : 'left'}</span>
          </Ring>
          <div className="mt-2 text-[13px] text-muted tabular-nums">
            <span className="font-semibold text-fg">{formatKcal(totals.kcal)}</span> / {formatKcal(targets.kcal)} kcal
          </div>
        </div>
        <Macros totals={totals} targets={targets} />
      </div>
    </Card>
  );
}

function Macros({ totals, targets }: { totals: Totals; targets: Targets | null }) {
  return (
    <div className="min-w-0 flex-1 space-y-2.5">
      <MacroBar label="Protein" eaten={totals.proteinG} target={targets?.proteinG ?? null} tone="accent" />
      <MacroBar label="Carbs" eaten={totals.carbsG} target={targets?.carbsG ?? null} tone="success" />
      <MacroBar label="Fat" eaten={totals.fatG} target={targets?.fatG ?? null} tone="warn" />
      <MacroBar label="Fiber" eaten={totals.fiberG} target={targets?.fiberG ?? null} tone="drop" />
    </div>
  );
}
