import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { format, startOfDay, subMonths, subYears } from 'date-fns';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Camera, ChevronRight, Ruler, Weight } from 'lucide-react';
import type { Measurement, Unit } from '../../types';
import { db } from '../../db';
import { Button, Card, EmptyState, ListGroup, Loading, Page, SectionHeader, Segmented, TopBar, cx } from '../../components/ui';
import { useSettings } from '../../lib/settings';
import { useMediaUrl } from '../../lib/media';
import { formatNumber, kgToUnit } from '../../lib/units';
import { formatLength, lengthUnitFor, readPref, relativeDay, writePref, type LengthUnit } from './format';
import { ChartTip, ProgressCard } from './components/shared';
import { LENGTH_FIELDS, MeasurementSheet } from './components/MeasurementSheet';

type Range = '3m' | '1y' | 'all';
const RANGES: readonly Range[] = ['3m', '1y', 'all'];
const RANGE_TEXT: Record<Range, string> = { '3m': 'in 3 months', '1y': 'in 1 year', all: 'overall' };
const PAGE = 40;

const fmtW = (kg: number, unit: Unit) => `${formatNumber(kgToUnit(kg, unit), 1)} ${unit}`;

export function MeasurementsPage() {
  const settings = useSettings();
  const { unit } = settings;
  const lu = lengthUnitFor(unit);
  const location = useLocation();
  const entries = useLiveQuery(() => db.measurements.orderBy('date').reverse().toArray(), []); // newest first
  const [editing, setEditing] = useState<{ entry: Measurement | null; key: number } | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const openNew = () => setEditing({ entry: null, key: Date.now() });
  const openEntry = (m: Measurement) => setEditing({ entry: m, key: Date.now() });

  return (
    <Page tabBar>
      <TopBar
        title="Measurements"
        back={location.key === 'default' ? '/progress' : true}
        right={
          <button type="button" onClick={openNew} className="h-10 px-3 text-[17px] font-semibold text-accent active:opacity-60">
            Add
          </button>
        }
      />
      {entries === undefined ? (
        <Loading />
      ) : (
        <div className="pt-3">
          <div className="space-y-3 px-4">
            <WeightCard entries={entries} unit={unit} onAdd={openNew} />
            {entries.length > 0 ? <LatestGrid entries={entries} unit={unit} lu={lu} /> : null}
          </div>

          {entries.length === 0 ? (
            <EmptyState
              icon={<Ruler className="h-7 w-7" />}
              title="No measurements yet"
              message="Log your body weight, body fat, tape measurements and progress photos to see how your body changes."
              action={<Button onClick={openNew}>Add Measurement</Button>}
            />
          ) : (
            <>
              <SectionHeader right={<span className="text-[13px] text-muted tabular-nums">{entries.length}</span>}>
                History
              </SectionHeader>
              <ListGroup>
                {entries.slice(0, limit).map((m) => (
                  <EntryRow key={m.id} m={m} unit={unit} lu={lu} onClick={() => openEntry(m)} />
                ))}
              </ListGroup>
              {entries.length > limit ? (
                <div className="px-4 pt-3">
                  <Button variant="secondary" block onClick={() => setLimit((l) => l + PAGE)}>
                    Show more ({entries.length - limit})
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
      {editing ? (
        <MeasurementSheet key={editing.key} open entry={editing.entry} unit={unit} onClose={() => setEditing(null)} />
      ) : null}
    </Page>
  );
}

// ------------------------------------------------------------------ body weight chart

function WeightCard({ entries, unit, onAdd }: { entries: Measurement[]; unit: Unit; onAdd: () => void }) {
  const [range, setRangeState] = useState<Range>(() => readPref('measurements.range', RANGES, '3m'));
  const setRange = (r: Range) => {
    setRangeState(r);
    writePref('measurements.range', r);
  };
  const weighIns = useMemo(
    () => entries.filter((m) => !!m.bodyweightKg).map((m) => ({ date: m.date, kg: m.bodyweightKg! })).reverse(), // oldest first
    [entries],
  );
  const now = Date.now();
  const from = range === '3m' ? startOfDay(subMonths(now, 3)).getTime() : range === '1y' ? startOfDay(subYears(now, 1)).getTime() : 0;
  const data = useMemo(
    () => weighIns.filter((p) => p.date >= from).map((p) => ({ date: p.date, value: Math.round(kgToUnit(p.kg, unit) * 10) / 10 })),
    [weighIns, from, unit],
  );

  const latest = weighIns[weighIns.length - 1];
  const change = data.length >= 2 ? data[data.length - 1].value - data[0].value : null;

  if (weighIns.length === 0) {
    return (
      <ProgressCard title="Body Weight" icon={<Weight className="h-[18px] w-[18px] text-accent" />}>
        <div className="rounded-xl bg-surface-2 px-4 py-6 text-center">
          <div className="text-[15px] font-semibold">No weigh-ins yet</div>
          <div className="mt-1 text-[13px] text-muted">Your weight also makes calorie estimates more accurate.</div>
          {/* Small button, 40px tall hit area (an invisible box 4px above and below). */}
          <Button size="sm" className="relative mt-3 after:absolute after:inset-x-0 after:-inset-y-1" onClick={onAdd}>
            Log weight
          </Button>
        </div>
      </ProgressCard>
    );
  }

  const values = data.map((d) => d.value);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 0;
  const pad = Math.max(1, (hi - lo) * 0.15);
  const domain: [number, number] = [Math.floor(lo - pad), Math.ceil(hi + pad)];
  const spanDays = data.length ? (data[data.length - 1].date - data[0].date) / 86_400_000 : 0;
  const tickFmt = spanDays > 200 ? "MMM ''yy" : 'MMM d';

  return (
    <ProgressCard
      title="Body Weight"
      icon={<Weight className="h-[18px] w-[18px] text-accent" />}
      right={
        <Segmented<Range>
          value={range}
          onChange={setRange}
          className="w-[150px] [&>button]:py-1 [&>button]:text-[13px]"
          options={[
            { value: '3m', label: '3M' },
            { value: '1y', label: '1Y' },
            { value: 'all', label: 'All' },
          ]}
        />
      }
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[26px] leading-none font-bold tabular-nums">{fmtW(latest.kg, unit)}</span>
        {change != null ? (
          <span className={cx('text-[14px] font-semibold tabular-nums', change === 0 ? 'text-muted' : 'text-fg')}>
            {change > 0 ? '+' : change < 0 ? '−' : '±'}
            {formatNumber(Math.abs(change), 1)} {unit}
            <span className="font-normal text-muted"> {RANGE_TEXT[range]}</span>
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 text-[12px] text-muted">Latest · {relativeDay(latest.date)}</div>

      <div className="relative -mx-1 mt-3 h-[190px]">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[14px] text-muted">No weigh-ins in this range</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} stroke="var(--c-line)" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                type="number"
                scale="time"
                domain={data.length === 1 ? [data[0].date - 86_400_000 * 3, data[0].date + 86_400_000 * 3] : ['dataMin', 'dataMax']}
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                minTickGap={28}
                tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
                tickFormatter={(t: number) => format(t, tickFmt)}
              />
              <YAxis
                orientation="right"
                width={36}
                domain={domain}
                tickLine={false}
                axisLine={false}
                tickCount={4}
                allowDecimals={false}
                tick={{ fill: 'var(--c-faint)', fontSize: 11 }}
              />
              <Tooltip
                cursor={{ stroke: 'var(--c-faint)', strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  const d = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  if (!active || !d) return null;
                  return <ChartTip title={format(d.date, 'EEE, MMM d, yyyy')} value={`${formatNumber(d.value, 1)} ${unit}`} />;
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--c-accent)"
                strokeWidth={2.5}
                dot={data.length <= 40 ? { r: 3, fill: 'var(--c-accent)', strokeWidth: 0 } : false}
                activeDot={{ r: 5, fill: 'var(--c-accent)', stroke: 'var(--c-surface)', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </ProgressCard>
  );
}

// ------------------------------------------------------------------ latest values

function LatestGrid({ entries, unit, lu }: { entries: Measurement[]; unit: Unit; lu: LengthUnit }) {
  // entries are newest first: the first entry with a value is the latest for that field.
  const latest = <K extends keyof Measurement>(key: K) => entries.find((m) => m[key] != null && m[key] !== 0);
  const tiles: { label: string; value: string | null; date?: number }[] = [];
  const w = latest('bodyweightKg');
  tiles.push({ label: 'Weight', value: w?.bodyweightKg ? fmtW(w.bodyweightKg, unit) : null, date: w?.date });
  const bf = latest('bodyFatPct');
  tiles.push({ label: 'Body Fat', value: bf?.bodyFatPct ? `${formatNumber(bf.bodyFatPct, 1)}%` : null, date: bf?.date });
  for (const f of LENGTH_FIELDS) {
    const m = latest(f.key);
    tiles.push({ label: f.label, value: m?.[f.key] ? formatLength(m[f.key], lu) : null, date: m?.date });
  }

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-[17px] font-semibold">Latest</h2>
      <div className="grid grid-cols-2 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className="min-w-0 rounded-xl bg-surface-2 px-3 py-2.5">
            <div className="text-[12px] font-medium text-muted">{t.label}</div>
            <div className={cx('truncate text-[18px] leading-tight font-bold tabular-nums', !t.value && 'text-faint')}>
              {t.value ?? '–'}
            </div>
            <div className="truncate text-[11px] text-faint">{t.date ? relativeDay(t.date) : 'Not logged'}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ history rows

function summarize(m: Measurement, unit: Unit, lu: LengthUnit): string {
  const parts: string[] = [];
  if (m.bodyweightKg) parts.push(fmtW(m.bodyweightKg, unit));
  if (m.bodyFatPct) parts.push(`${formatNumber(m.bodyFatPct, 1)}% fat`);
  for (const f of LENGTH_FIELDS) {
    const v = m[f.key];
    if (v) parts.push(`${f.label} ${formatLength(v, lu)}`);
  }
  if (!parts.length && m.notes) parts.push(m.notes);
  if (!parts.length && m.photoIds.length) parts.push(m.photoIds.length === 1 ? '1 photo' : `${m.photoIds.length} photos`);
  return parts.join(' · ');
}

function EntryRow({ m, unit, lu, onClick }: { m: Measurement; unit: Unit; lu: LengthUnit; onClick: () => void }) {
  const thumb = useMediaUrl(m.photoIds[0]);
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-surface-2">
      <span className="flex w-11 shrink-0 flex-col items-center rounded-xl bg-surface-2 py-1.5 leading-none">
        <span className="text-[11px] font-semibold text-accent uppercase">{format(m.date, 'MMM')}</span>
        <span className="mt-0.5 text-[18px] font-bold tabular-nums">{format(m.date, 'd')}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold">
          {format(m.date, new Date(m.date).getFullYear() === new Date().getFullYear() ? 'EEEE' : 'EEEE · yyyy')}
        </span>
        <span className="block truncate text-[13px] text-muted tabular-nums">{summarize(m, unit, lu) || 'Empty entry'}</span>
      </span>
      {m.photoIds.length ? (
        thumb ? (
          <img src={thumb} alt="" className="h-11 w-9 shrink-0 rounded-lg object-cover" />
        ) : (
          <Camera className="h-5 w-5 shrink-0 text-faint" />
        )
      ) : null}
      <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
    </button>
  );
}
