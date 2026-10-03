import { Target } from 'lucide-react';
import { Card, ListGroup, Stat } from '../../../components/ui';
import type { BodyField } from '../../../lib/nutrition/targets';
import type { NutritionProfile, Targets } from '../../../lib/nutrition/types';
import { formatKcal } from '../ui';
import { joinFields } from '../diary/TargetsSummary';
import { saveFailed, saveProfile } from './data';
import { InlineNumber } from './InlineNumber';

/**
 * What the targets come out to (BMR → maintenance → daily target, then macros) plus the two optional
 * overrides. `auto` is the same computation with the overrides removed, shown as the "automatic" value.
 */
export function TargetsCard({
  targets,
  auto,
  missing,
  profile,
}: {
  targets: Targets | null;
  auto: Targets | null;
  missing: BodyField[];
  profile: Pick<NutritionProfile, 'kcalOverride' | 'proteinOverride'>;
}) {
  if (!targets || !auto) {
    return (
      <Card className="mx-4 flex items-start gap-3 p-4">
        <Target className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <p className="text-[14px] leading-snug text-muted">
          Add your {missing.length ? joinFields(missing) : 'body details'} under Body to see your daily targets.
        </p>
      </Card>
    );
  }
  return (
    <>
      <Card className="mx-4 p-4">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="BMR" value={formatKcal(targets.bmr)} />
          <Stat label="Maintenance" value={formatKcal(targets.tdee)} />
          <Stat label="Daily target" value={<span className="text-accent">{formatKcal(targets.kcal)}</span>} />
        </div>
        <div className="mt-1 text-[12px] text-faint">kcal per day</div>
        <div className="mt-3 grid grid-cols-4 gap-2 border-t border-line pt-3">
          <Stat label="Protein" value={`${targets.proteinG} g`} />
          <Stat label="Carbs" value={`${targets.carbsG} g`} />
          <Stat label="Fat" value={`${targets.fatG} g`} />
          <Stat label="Fiber" value={`${targets.fiberG} g`} />
        </div>
      </Card>
      <ListGroup className="mt-3">
        <OverrideRow
          title="Calorie target"
          unit="kcal"
          value={profile.kcalOverride}
          autoValue={auto.kcal}
          min={800}
          max={10000}
          onSave={(v) => saveProfile({ kcalOverride: v })}
        />
        <OverrideRow
          title="Protein target"
          unit="g"
          value={profile.proteinOverride}
          autoValue={auto.proteinG}
          min={20}
          max={500}
          onSave={(v) => saveProfile({ proteinOverride: v })}
        />
      </ListGroup>
      <p className="px-5 pt-2 text-[13px] leading-snug text-muted">Leave blank to use the automatic value. Carbs fill the calories left after protein and fat.</p>
    </>
  );
}

function OverrideRow({
  title,
  unit,
  value,
  autoValue,
  min,
  max,
  onSave,
}: {
  title: string;
  unit: string;
  value: number | null;
  autoValue: number;
  min: number;
  max: number;
  onSave: (v: number | null) => Promise<void>;
}) {
  const custom = value != null && value > 0;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[16px]">{title}</div>
        <div className="text-[13px] text-muted tabular-nums">
          {custom ? 'Custom' : 'Automatic'} · auto {autoValue.toLocaleString()} {unit}
        </div>
        {custom ? (
          <button
            type="button"
            onClick={() => void onSave(null).catch(saveFailed)}
            className="-ml-1 inline-flex h-10 items-center px-1 text-[14px] font-semibold text-accent active:opacity-60"
          >
            Use automatic
          </button>
        ) : null}
      </div>
      <InlineNumber
        label={title}
        value={custom ? value : null}
        integer
        allowEmpty
        min={min}
        max={max}
        placeholder={String(autoValue)}
        suffix={unit}
        onCommit={onSave}
      />
    </div>
  );
}
