import { Check } from 'lucide-react';
import { Card, ListGroup, ListRow, Segmented } from '../../../components/ui';
import {
  ACTIVITY_LABEL,
  ACTIVITY_SUBTITLE,
  calorieAdjustment,
  GOAL_LABEL,
  PACE_LABEL,
  RECOMP_OFFSET,
} from '../../../lib/nutrition/targets';
import type { Activity, Goal, Pace } from '../../../lib/nutrition/types';
import { saveFailed, saveProfile } from './data';

const ACTIVITIES: Activity[] = ['sedentary', 'light', 'moderate', 'active', 'very_active'];
const GOALS: Goal[] = ['lose', 'maintain', 'gain'];
const PACES: Pace[] = ['steady', 'aggressive'];

/** "+250", "−400", "0" (real minus sign). */
export function signedKcal(v: number): string {
  if (v > 0) return `+${v.toLocaleString()}`;
  if (v < 0) return `−${Math.abs(v).toLocaleString()}`;
  return '0';
}

/** Activity level: the ONE place training counts toward the target (workout burn is never added back). */
export function ActivitySection({ activity }: { activity: Activity }) {
  return (
    <>
      <ListGroup>
        {ACTIVITIES.map((a) => (
          <ListRow
            key={a}
            title={ACTIVITY_LABEL[a]}
            subtitle={ACTIVITY_SUBTITLE[a]}
            onClick={() => void saveProfile({ activity: a }).catch(saveFailed)}
            right={a === activity ? <Check aria-label="Selected" className="h-5 w-5 shrink-0 text-accent" strokeWidth={2.5} /> : null}
          />
        ))}
      </ListGroup>
      <p className="px-5 pt-2 text-[13px] leading-snug text-muted">Count your training here. Workout calories are never added back.</p>
    </>
  );
}

type MaintainMode = 'steady' | 'recomp';

/**
 * Goal (lose / maintain / gain) and pace, each pace labelled with its daily kcal offset from maintenance. Maintain has
 * its own choice instead of a pace: plain maintenance, or Recomp (RECOMP_OFFSET every day, protein 1 g/lb).
 */
export function GoalSection({ goal, pace, recomp = false }: { goal: Goal; pace: Pace; recomp?: boolean }) {
  const isRecomp = goal === 'maintain' && recomp;
  const offset = calorieAdjustment(goal, pace, isRecomp);
  return (
    <Card className="mx-4 w-auto! space-y-3 p-4">
      <Segmented<Goal>
        value={goal}
        onChange={(g) => void saveProfile({ goal: g }).catch(saveFailed)}
        options={GOALS.map((g) => ({ value: g, label: GOAL_LABEL[g] }))}
      />
      {goal === 'maintain' ? (
        <Segmented<MaintainMode>
          value={recomp ? 'recomp' : 'steady'}
          onChange={(m) => void saveProfile({ recomp: m === 'recomp' }).catch(saveFailed)}
          options={[
            {
              value: 'steady',
              label: (
                <span className="block leading-tight">
                  <span className="block">Maintenance</span>
                  <span className="block text-[12px] font-medium text-muted tabular-nums">0 kcal/day</span>
                </span>
              ),
            },
            {
              value: 'recomp',
              label: (
                <span className="block leading-tight">
                  <span className="block">Recomp</span>
                  <span className="block text-[12px] font-medium text-muted tabular-nums">{signedKcal(RECOMP_OFFSET)} kcal/day</span>
                </span>
              ),
            },
          ]}
        />
      ) : (
        <Segmented<Pace>
          value={pace}
          onChange={(p) => void saveProfile({ pace: p }).catch(saveFailed)}
          options={PACES.map((p) => ({
            value: p,
            label: (
              <span className="block leading-tight">
                <span className="block">{PACE_LABEL[p]}</span>
                <span className="block text-[12px] font-medium text-muted tabular-nums">{signedKcal(calorieAdjustment(goal, p))} kcal/day</span>
              </span>
            ),
          }))}
        />
      )}
      <p className="text-[13px] leading-snug text-muted tabular-nums">
        {isRecomp
          ? `Build muscle and lose fat together: maintenance ${signedKcal(offset)} kcal every day, training or rest, and protein 1 g per lb.`
          : offset === 0
            ? 'Daily target = your maintenance calories.'
            : `Daily target = maintenance ${signedKcal(offset)} kcal.`}
      </p>
    </Card>
  );
}

