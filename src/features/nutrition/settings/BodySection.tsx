import { format } from 'date-fns';
import { Cake, Ruler, User, Weight } from 'lucide-react';
import { ListGroup, ListRow, Segmented } from '../../../components/ui';
import { updateSettings } from '../../../lib/settings';
import { kgToUnit, round, unitToKg } from '../../../lib/units';
import type { Measurement, Settings } from '../../../types';
import { bodyweightSource, saveFailed } from './data';
import { HeightFtIn, InlineNumber } from './InlineNumber';

const ic = 'h-5 w-5';

/**
 * Body inputs for the BMR — the SAME fields as Heft's Settings → Profile (lib/settings.ts), so they're
 * entered once for both calorie estimates and food targets. Weight is shown and typed in the user's unit.
 */
export function BodySection({
  settings: s,
  bodyweightKg,
  latest,
  now,
}: {
  settings: Settings;
  /** The body weight in use (profile value or newest weigh-in, whichever is newer). */
  bodyweightKg: number | null;
  latest: Measurement | null;
  now: number;
}) {
  const unit = s.unit;
  const year = new Date(now).getFullYear();
  const source = bodyweightSource(s, latest);
  const weightShown = bodyweightKg ? round(kgToUnit(bodyweightKg, unit), 1) : null;
  const [wLo, wHi] = unit === 'lb' ? [40, 900] : [20, 400];

  return (
    <ListGroup>
      <ListRow
        icon={<User className={ic} />}
        title="Sex"
        subtitle={s.sex ? undefined : <span className="text-warn">Not set</span>}
        right={
          <Segmented<'male' | 'female' | ''>
            className="w-[150px]"
            value={s.sex ?? ''}
            onChange={(v) => {
              if (v) void updateSettings({ sex: v }).catch(saveFailed);
            }}
            options={[
              { value: 'male', label: 'Male' },
              { value: 'female', label: 'Female' },
            ]}
          />
        }
      />
      <ListRow
        icon={<Cake className={ic} />}
        title="Birth year"
        subtitle={s.birthYear ? `Age ${year - s.birthYear}` : <span className="text-warn">Not set</span>}
        right={
          <InlineNumber
            label="Birth year"
            value={s.birthYear}
            integer
            min={1900}
            max={year - 5}
            placeholder="1994"
            onCommit={(v) => (v == null ? undefined : updateSettings({ birthYear: v }))}
          />
        }
      />
      <ListRow
        icon={<Ruler className={ic} />}
        title="Height"
        subtitle={s.heightCm ? undefined : <span className="text-warn">Not set</span>}
        right={
          unit === 'lb' ? (
            <HeightFtIn cm={s.heightCm} onCommit={(cm) => updateSettings({ heightCm: cm })} />
          ) : (
            <InlineNumber
              label="Height in cm"
              value={s.heightCm ? Math.round(s.heightCm) : null}
              min={90}
              max={250}
              placeholder="178"
              suffix="cm"
              className="w-16"
              onCommit={(v) => (v == null ? undefined : updateSettings({ heightCm: round(v, 1) }))}
            />
          )
        }
      />
      <ListRow
        icon={<Weight className={ic} />}
        title="Body weight"
        subtitle={
          source === 'weighin' && latest ? (
            `From weigh-in, ${format(latest.date, new Date(latest.date).getFullYear() === year ? 'MMM d' : 'MMM d, yyyy')}`
          ) : source === 'profile' ? (
            'Your profile weight'
          ) : (
            <span className="text-warn">Not set</span>
          )
        }
        right={
          <InlineNumber
            label={`Body weight in ${unit}`}
            value={weightShown}
            min={wLo}
            max={wHi}
            placeholder={unit === 'lb' ? '180' : '80'}
            suffix={unit}
            onCommit={(v) =>
              // Stamped explicitly: updateSettings ignores an UNstamped patch that equals the newest weigh-in
              // (an automatic copy), but here the user typed it — e.g. going back to an older weigh-in's value
              // after a newer profile edit — so it must win as a manual edit.
              v == null ? undefined : updateSettings({ bodyweightKg: unitToKg(v, unit), bodyweightUpdatedAt: Date.now() })
            }
          />
        }
      />
    </ListGroup>
  );
}
