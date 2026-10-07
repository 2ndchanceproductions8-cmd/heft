import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Camera, ChevronRight, Clock, Loader2, ScanBarcode, Target, TriangleAlert, Utensils } from 'lucide-react';
import { Button, Card, cx } from '../../../components/ui';
import { countsTowardDay, remaining, sumMeals } from '../../../lib/nutrition/math';
import type { TargetsState } from '../../../lib/nutrition/store';
import type { Meal, Targets, Totals } from '../../../lib/nutrition/types';
import { joinFields } from '../../nutrition/diary/TargetsSummary';
import { formatKcal, MacroBar, Ring } from '../../nutrition/ui';
import { mealCountLabel, unfinishedLines, type UnfinishedKind, type UnfinishedLine } from './model';

/*
 * The Today Food card: today's calories against the target (the Diary's ring, smaller), protein first, what
 * isn't counted yet, and the two quickest ways to log. Budget = target − eaten (lib/nutrition/math remaining());
 * workout calories never enter it (the Training card shows them, display only).
 */

const DIARY = '/nutrition';
const FOOD_SETTINGS = '/nutrition/settings';
const LOG = '/nutrition/log';
const SCAN = '/nutrition/scan';

const RING = 108;
/**
 * Height of the totals row with a target: ring 108 + 8 gap + the 18 px kcal line. The skeleton uses the same
 * height so the page doesn't jump when the data arrives.
 */
const BUDGET_ROW = 'min-h-[134px]';

export interface FuelCardViewProps {
  /** Today's meals, any status, oldest first. undefined while loading. */
  meals: Meal[] | undefined;
  /** undefined while loading; `targets: null` when body fields are missing (named in `missing`). */
  targets: Pick<TargetsState, 'targets' | 'missing'> | undefined;
  /** Ids of today's 'analyzing' meals whose run died with the app: shown as needing a retry. */
  interrupted?: ReadonlySet<string>;
  /** Maintain · Recomp: the training / rest day switch, shown under the budget. */
  dayChip?: ReactNode;
}

/** Presentational card (plain props, no IndexedDB), so every state renders in tests. */
export function FuelCardView({ meals, targets, interrupted, dayChip }: FuelCardViewProps) {
  const navigate = useNavigate();
  const ready = meals !== undefined && targets !== undefined;
  return (
    <Card className="p-4">
      <Header count={meals?.length ?? 0} />
      {ready ? <Body meals={meals} targets={targets.targets} missing={targets.missing} interrupted={interrupted} /> : <Skeleton />}
      {ready && targets.targets && dayChip ? <div className="mt-3">{dayChip}</div> : null}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant="soft" className="min-w-0" icon={<Camera className="h-[18px] w-[18px] shrink-0" />} onClick={() => navigate(LOG)}>
          <span className="truncate">Snap a meal</span>
        </Button>
        <Button
          variant="secondary"
          className="min-w-0"
          aria-label="Scan a barcode"
          icon={<ScanBarcode className="h-[18px] w-[18px] shrink-0" />}
          onClick={() => navigate(SCAN)}
        >
          <span className="truncate">Scan</span>
        </Button>
      </div>
    </Card>
  );
}

/** Title row like the Progress cards; the whole row opens the Diary. */
function Header({ count }: { count: number }) {
  return (
    <h2 className="-mx-2 -mt-1 mb-2">
      <Link
        to={DIARY}
        className="flex min-h-10 items-center gap-2 rounded-xl px-2 text-[17px] font-semibold transition-colors active:bg-surface-2"
      >
        <Utensils className="h-[18px] w-[18px] shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">Food</span>
        {count > 0 ? <span className="shrink-0 text-[13px] font-medium text-muted tabular-nums">{mealCountLabel(count)}</span> : null}
        <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
      </Link>
    </h2>
  );
}

function Body({
  meals,
  targets,
  missing,
  interrupted,
}: {
  meals: Meal[];
  targets: Targets | null;
  missing: TargetsState['missing'];
  interrupted?: ReadonlySet<string>;
}) {
  const totals = sumMeals(meals);
  const logged = meals.some(countsTowardDay);
  const lines = unfinishedLines(meals, interrupted);
  return (
    <div className="space-y-3">
      {targets ? (
        <Budget totals={totals} targets={targets} logged={logged} empty={meals.length === 0} />
      ) : logged ? (
        <Eaten totals={totals} />
      ) : meals.length === 0 ? (
        <div className="rounded-xl bg-surface-2 px-4 py-3.5 text-center">
          <div className="text-[15px] font-semibold">Nothing logged yet</div>
          <div className="mt-0.5 text-[13px] leading-snug text-muted">Photograph a meal or scan a barcode and today's calories show up here.</div>
        </div>
      ) : null}
      {lines.length ? <Unfinished lines={lines} /> : null}
      {targets ? null : (
        <Link
          to={FOOD_SETTINGS}
          className="flex min-h-11 items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 transition-colors active:bg-surface-3"
        >
          <Target className="h-5 w-5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 text-[14px] leading-snug">
            Add your {missing.length ? joinFields(missing) : 'body details'} to get a daily target
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
        </Link>
      )}
    </div>
  );
}

/**
 * Ring of eaten vs target with what's left (or over) inside, plus the macros. "Nothing logged yet" is the line
 * under the ring, not a row of its own, so the empty morning card keeps the skeleton's height.
 */
function Budget({ totals, targets, logged, empty }: { totals: Totals; targets: Targets; logged: boolean; empty: boolean }) {
  const left = remaining(targets.kcal, totals.kcal);
  const over = left < 0;
  return (
    <div className={cx('flex items-center gap-4', BUDGET_ROW)}>
      <div className="flex shrink-0 flex-col items-center">
        <Ring value={totals.kcal} max={targets.kcal} size={RING} stroke={10}>
          <span
            aria-label={over ? `${formatKcal(-left)} kcal over` : `${formatKcal(left)} kcal left`}
            className={cx('text-[24px] leading-none font-bold tabular-nums', over ? 'text-danger' : 'text-fg')}
          >
            {formatKcal(Math.abs(left))}
          </span>
          <span className={cx('mt-1 text-[12px] font-semibold', over ? 'text-danger' : 'text-muted')}>{over ? 'over' : 'left'}</span>
        </Ring>
        <div className="mt-2 h-[18px] text-[13px] leading-[18px] whitespace-nowrap text-muted tabular-nums">
          {logged ? (
            <>
              <span className="font-semibold text-fg">{formatKcal(totals.kcal)}</span> / {formatKcal(targets.kcal)} kcal
            </>
          ) : empty ? (
            <>Nothing logged yet</>
          ) : (
            <>{formatKcal(targets.kcal)} kcal target</>
          )}
        </div>
      </div>
      <Macros totals={totals} targets={targets} />
    </div>
  );
}

/** No target yet (body fields missing): what was eaten, macros without targets. */
function Eaten({ totals }: { totals: Totals }) {
  return (
    <div className="flex items-center gap-4">
      <div className="w-[108px] shrink-0 text-center">
        <div className="text-[30px] leading-none font-bold tabular-nums">{formatKcal(totals.kcal)}</div>
        <div className="mt-1 text-[13px] text-muted">kcal eaten</div>
      </div>
      <Macros totals={totals} targets={null} />
    </div>
  );
}

/** Protein first: it matters most to a lifter. Tones match the Diary. */
function Macros({ totals, targets }: { totals: Totals; targets: Targets | null }) {
  return (
    <div className="min-w-0 flex-1 space-y-2.5">
      <MacroBar label="Protein" eaten={totals.proteinG} target={targets?.proteinG ?? null} tone="accent" />
      <MacroBar label="Carbs" eaten={totals.carbsG} target={targets?.carbsG ?? null} tone="success" />
      <MacroBar label="Fat" eaten={totals.fatG} target={targets?.fatG ?? null} tone="warn" />
    </div>
  );
}

const LINE_ICON: Record<UnfinishedKind, ReactNode> = {
  failed: <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />,
  draft: <Camera className="h-4 w-4 shrink-0 text-warn" />,
  pending: <Clock className="h-4 w-4 shrink-0 text-warn" />,
  analyzing: <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" />,
};

/** Today's meals that don't count yet, and why; opens the Diary, where each row has its Retry / Continue. */
function Unfinished({ lines }: { lines: UnfinishedLine[] }) {
  return (
    <Link to={DIARY} className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 transition-colors active:bg-surface-3">
      <span className="min-w-0 flex-1 space-y-1">
        {lines.map((l) => (
          <span key={l.kind} className="flex items-center gap-2 text-[14px] font-medium">
            {LINE_ICON[l.kind]}
            <span className="min-w-0 truncate tabular-nums">{l.label}</span>
          </span>
        ))}
        <span className="block text-[12px] leading-snug text-faint">Only analyzed meals count toward your totals.</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
    </Link>
  );
}

/** Same height as the Budget row, so the card keeps its size while IndexedDB answers. */
function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading today's food" className={cx('flex items-center gap-4 motion-safe:animate-pulse', BUDGET_ROW)}>
      <div className="flex shrink-0 flex-col items-center">
        <div className="rounded-full border-[10px] border-surface-2" style={{ width: RING, height: RING }} />
        <div className="mt-2 h-[18px] w-24 rounded-md bg-surface-2" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-3.5 w-2/3 rounded bg-surface-2" />
            <div className="h-1.5 rounded-full bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
