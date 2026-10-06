import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation, useNavigate } from 'react-router-dom';
import { format, isSameDay } from 'date-fns';
import {
  AlarmClock,
  Cake,
  CalendarDays,
  Check,
  CloudDownload,
  Database,
  Download,
  FileSpreadsheet,
  Flame,
  HardDrive,
  History,
  Info,
  Palette,
  Ruler,
  Smartphone,
  Trash2,
  Upload,
  User,
  Vibrate,
  Volume2,
  Weight,
  Dumbbell,
  Footprints,
  Gauge,
  Image as ImageIcon,
  Heart,
} from 'lucide-react';
import type { Settings } from '../../types';
import { db, requestPersistentStorage } from '../../db';
import {
  ActionSheet,
  ListGroup,
  ListRow,
  Page,
  SectionHeader,
  Segmented,
  Spinner,
  Toggle,
  TopBar,
  confirm,
  cx,
  prompt,
  toast,
} from '../../components/ui';
import { currentBodyweightKg, updateSettings, useSettings } from '../../lib/settings';
import { useExercises } from '../../lib/ExerciseProvider';
import { DEFAULT_BODYWEIGHT_KG } from '../../lib/calories';
import { formatWeight, kgToUnit, parseDecimal, round, unitToKg } from '../../lib/units';
import { countCachedExerciseImages, precacheExerciseImages } from '../../lib/offline';
import { downloadBlob, exportBackup, exportCsv, importBackup, keepsFoodLog, parseBackup } from '../../lib/backup';
import { clearNutritionKeys } from '../../lib/nutrition/keys';
import { flushActiveWorkout, useWorkoutStore } from '../../lib/workoutStore';
import { uid } from '../../lib/ids';
import { restOptionLabel, restOptionsWith } from '../../lib/rest';
import { formatHeight, parseHeight } from './format';
import { OptionSheet, type Option } from './components/shared';
import { newestWeighIn } from './components/MeasurementSheet';

/** The app-wide rest choices and labels (lib/rest.ts), plus the current value if it is off that list. */
const restOptions = (current: number): Option<number>[] =>
  restOptionsWith(current).map((s) => ({ value: s, label: restOptionLabel(s) }));

const PREVIOUS_OPTIONS: Option<Settings['previousValues']>[] = [
  { value: 'any', label: 'Any workout', hint: 'The last time you did the exercise, in any workout' },
  { value: 'same_routine', label: 'Same routine', hint: 'The last time you did it in the same routine (falls back to any)' },
];

const SEX_LABEL = { male: 'Male', female: 'Female' } as const;
const STANDARD_BAR_LB = 20.411656; // 45 lb in kg

/** Save a generated file: share sheet in an installed iOS app (downloads are awkward there), else download. */
async function saveFile(blob: Blob, filename: string): Promise<void> {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true && typeof File !== 'undefined' && nav.canShare) {
    const file = new File([blob], filename, { type: blob.type });
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: filename });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
      }
    }
  }
  downloadBlob(blob, filename);
}

function Value({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' | 'success' }) {
  return (
    <span
      className={cx(
        'max-w-[45%] shrink-0 truncate text-right text-[15px] tabular-nums',
        tone === 'muted' && 'text-muted',
        tone === 'warn' && 'text-warn',
        tone === 'success' && 'text-success',
      )}
    >
      {children}
    </span>
  );
}

const icon = (node: ReactNode) => <span className="[&>svg]:h-[20px] [&>svg]:w-[20px]">{node}</span>;

export function SettingsPage() {
  const s = useSettings();
  const location = useLocation();
  const navigate = useNavigate();
  // Body weight actually used for calories (newest weigh-in, else profile). undefined while loading.
  const effective = useLiveQuery(() => currentBodyweightKg(), []);
  const effectiveKg = effective ?? null;
  const loadingWeight = effective === undefined;
  const [sheet, setSheet] = useState<null | 'rest' | 'previous' | 'sex'>(null);

  const unit = s.unit;
  const supportsVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;
  const supportsWakeLock = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  // ---------------------------------------------------------------- profile
  const editBodyweight = async () => {
    const current = effectiveKg ?? s.bodyweightKg;
    const initial = current ? String(round(kgToUnit(current, unit), 1)) : '';
    const v = await prompt({
      title: 'Body weight',
      message: `In ${unit}. Used to estimate calories burned.`,
      initial,
      placeholder: unit === 'lb' ? 'e.g. 180' : 'e.g. 80',
      inputMode: 'decimal',
      validate: (t) => {
        const n = parseDecimal(t);
        const [lo, hi] = unit === 'lb' ? [40, 900] : [20, 400];
        return n == null || n < lo || n > hi ? `Enter a weight between ${lo} and ${hi} ${unit}` : null;
      },
    });
    if (v == null || v.trim() === initial) return; // cancelled or unchanged
    const kg = unitToKg(parseDecimal(v)!, unit);
    await updateSettings({ bodyweightKg: kg });
    // The newest weigh-in wins for calories, so record this as today's weigh-in when weigh-ins exist
    // (correcting today's entry rather than adding a second one for the same day). A corrected Apple Health
    // entry becomes the user's own ('manual'), so the next import doesn't overwrite it.
    const newest = await newestWeighIn();
    if (newest) {
      if (isSameDay(newest.date, Date.now())) await db.measurements.update(newest.id, { bodyweightKg: kg, source: 'manual' });
      else await db.measurements.add({ id: uid(), date: Date.now(), bodyweightKg: kg, photoIds: [] });
      toast('Body weight saved and logged in Measurements', 'success');
    } else {
      toast('Body weight saved', 'success');
    }
  };

  const editHeight = async () => {
    const v = await prompt({
      title: 'Height',
      message: unit === 'lb' ? `Feet and inches, e.g. 5'10"` : 'In centimeters, e.g. 178',
      initial: s.heightCm ? formatHeight(s.heightCm, unit).replace(' cm', '') : '',
      inputMode: unit === 'lb' ? 'text' : 'decimal',
      validate: (t) => {
        const cm = parseHeight(t, unit);
        return cm == null || cm < 90 || cm > 250 ? "That doesn't look like a height" : null;
      },
    });
    if (v == null) return;
    await updateSettings({ heightCm: round(parseHeight(v, unit)!, 1) });
  };

  const editBirthYear = async () => {
    const year = new Date().getFullYear();
    const v = await prompt({
      title: 'Birth year',
      initial: s.birthYear ? String(s.birthYear) : '',
      placeholder: 'e.g. 1994',
      inputMode: 'numeric',
      validate: (t) => {
        const n = Number(t.trim());
        return !Number.isInteger(n) || n < 1900 || n > year - 5 ? `Enter a year between 1900 and ${year - 5}` : null;
      },
    });
    if (v == null) return;
    await updateSettings({ birthYear: Number(v.trim()) });
  };

  const editBar = async () => {
    const v = await prompt({
      title: 'Barbell weight',
      message: `Empty bar in ${unit} (used by the plate calculator).`,
      initial: String(round(kgToUnit(s.barKg, unit), 1)),
      inputMode: 'decimal',
      validate: (t) => {
        const n = parseDecimal(t);
        const hi = unit === 'lb' ? 150 : 70;
        return n == null || n < 0 || n > hi ? `Enter 0–${hi} ${unit}` : null;
      },
    });
    if (v == null) return;
    await updateSettings({ barKg: unitToKg(parseDecimal(v)!, unit) });
  };

  const setUnit = async (next: Settings['unit']) => {
    if (next === unit) return;
    const patch: Partial<Settings> = { unit: next };
    // Keep the standard bar "round" in the new unit (45 lb ↔ 20 kg).
    if (next === 'kg' && Math.abs(s.barKg - STANDARD_BAR_LB) < 0.01) patch.barKg = 20;
    if (next === 'lb' && Math.abs(s.barKg - 20) < 0.01) patch.barKg = STANDARD_BAR_LB;
    await updateSettings(patch);
  };

  const age = s.birthYear ? new Date().getFullYear() - s.birthYear : null;

  return (
    <Page tabBar>
      <TopBar title="Settings" back={location.key === 'default' ? '/progress' : true} />

      <SectionHeader>Profile</SectionHeader>
      <ListGroup>
        <ListRow
          icon={icon(<Weight />)}
          title="Body weight"
          subtitle={
            loadingWeight || effectiveKg ? (
              'Used for calorie estimates'
            ) : (
              <span className="text-warn">
                Not set — calories assume {Math.round(kgToUnit(DEFAULT_BODYWEIGHT_KG, unit))} {unit}
              </span>
            )
          }
          right={
            loadingWeight ? null : (
              <Value tone={effectiveKg ? 'muted' : 'warn'}>{effectiveKg ? `${round(kgToUnit(effectiveKg, unit), 1)} ${unit}` : 'Not set'}</Value>
            )
          }
          chevron
          onClick={() => void editBodyweight()}
        />
        <ListRow
          icon={icon(<Ruler />)}
          title="Height"
          right={<Value>{s.heightCm ? formatHeight(s.heightCm, unit) : 'Not set'}</Value>}
          chevron
          onClick={() => void editHeight()}
        />
        <ListRow
          icon={icon(<User />)}
          title="Sex"
          right={<Value>{s.sex ? SEX_LABEL[s.sex] : 'Unspecified'}</Value>}
          chevron
          onClick={() => setSheet('sex')}
        />
        <ListRow
          icon={icon(<Cake />)}
          title="Birth year"
          right={<Value>{s.birthYear ? `${s.birthYear} · ${age}` : 'Not set'}</Value>}
          chevron
          onClick={() => void editBirthYear()}
        />
      </ListGroup>

      <SectionHeader>Units</SectionHeader>
      <ListGroup>
        <ListRow
          icon={icon(<Weight />)}
          title="Weight"
          subtitle={unit === 'lb' ? 'Lengths in inches' : 'Lengths in cm'}
          right={
            <Segmented<Settings['unit']>
              className="w-[118px]"
              value={unit}
              onChange={(v) => void setUnit(v)}
              options={[
                { value: 'kg', label: 'kg' },
                { value: 'lb', label: 'lb' },
              ]}
            />
          }
        />
        <ListRow
          icon={icon(<Footprints />)}
          title="Distance"
          right={
            <Segmented<Settings['distanceUnit']>
              className="w-[118px]"
              value={s.distanceUnit}
              onChange={(v) => void updateSettings({ distanceUnit: v })}
              options={[
                { value: 'km', label: 'km' },
                { value: 'mi', label: 'mi' },
              ]}
            />
          }
        />
      </ListGroup>

      <SectionHeader>Workout</SectionHeader>
      <ListGroup>
        <ListRow
          icon={icon(<AlarmClock />)}
          title="Default rest timer"
          right={<Value>{restOptionLabel(s.defaultRestSec)}</Value>}
          chevron
          onClick={() => setSheet('rest')}
        />
        <ListRow
          icon={icon(<Volume2 />)}
          title="Rest timer sound"
          right={<Toggle label="Rest timer sound" checked={s.restTimerSound} onChange={(v) => void updateSettings({ restTimerSound: v })} />}
        />
        <ListRow
          icon={icon(<Vibrate />)}
          title="Rest timer vibration"
          subtitle={supportsVibrate ? undefined : 'Not supported by this browser'}
          right={<Toggle label="Rest timer vibration" checked={s.restTimerVibrate} onChange={(v) => void updateSettings({ restTimerVibrate: v })} />}
        />
        <ListRow
          icon={icon(<Smartphone />)}
          title="Keep screen awake"
          subtitle={supportsWakeLock ? 'While a workout is running' : 'Not supported by this browser'}
          right={<Toggle label="Keep screen awake" checked={s.keepAwake} onChange={(v) => void updateSettings({ keepAwake: v })} />}
        />
        <ListRow
          icon={icon(<History />)}
          title="Previous values"
          subtitle="PREVIOUS column"
          right={<Value>{s.previousValues === 'same_routine' ? 'Same routine' : 'Any workout'}</Value>}
          chevron
          onClick={() => setSheet('previous')}
        />
        <ListRow
          icon={icon(<Gauge />)}
          title="Show RPE column"
          subtitle="Rate of perceived exertion per set"
          right={<Toggle label="Show RPE column" checked={s.showRpe} onChange={(v) => void updateSettings({ showRpe: v })} />}
        />
        <ListRow
          icon={icon(<Dumbbell />)}
          title="Barbell weight"
          right={<Value>{formatWeight(round(s.barKg, 3), unit)}</Value>}
          chevron
          onClick={() => void editBar()}
        />
      </ListGroup>

      <SectionHeader>Appearance</SectionHeader>
      <ListGroup>
        <ListRow
          icon={icon(<Palette />)}
          title="Theme"
          right={
            <Segmented<Settings['theme']>
              className="w-[196px] [&>button]:px-1"
              value={s.theme}
              onChange={(v) => void updateSettings({ theme: v })}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
                { value: 'system', label: 'System' },
              ]}
            />
          }
        />
        <ListRow
          icon={icon(<CalendarDays />)}
          title="Week starts on"
          right={
            <Segmented<'0' | '1'>
              className="w-[150px] [&>button]:px-1"
              value={String(s.weekStartsOn) as '0' | '1'}
              onChange={(v) => void updateSettings({ weekStartsOn: v === '1' ? 1 : 0 })}
              options={[
                { value: '0', label: 'Sun' },
                { value: '1', label: 'Mon' },
              ]}
            />
          }
        />
      </ListGroup>

      <SectionHeader>Apple Health</SectionHeader>
      <ListGroup>
        <ListRow
          icon={icon(<Heart />)}
          title="Apple Health"
          subtitle="Send workouts, bring in weigh-ins"
          right={<Value>{s.appleHealth || s.healthImportedAt ? 'On' : 'Set up'}</Value>}
          chevron
          onClick={() => navigate('/settings/apple-health')}
        />
      </ListGroup>

      <SectionHeader>Offline</SectionHeader>
      <OfflineSection />

      <SectionHeader>Data</SectionHeader>
      <DataSection />

      <SectionHeader>About</SectionHeader>
      <ListGroup>
        <ListRow icon={icon(<Info />)} title="Heft" subtitle="Personal workout tracker · works offline" right={<Value>0.1</Value>} />
        <ListRow
          icon={icon(<ImageIcon />)}
          title="Exercise images & instructions"
          subtitle="free-exercise-db (public domain)"
        />
        <div className="flex gap-3 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center text-muted">{icon(<Flame />)}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[16px]">How calories are estimated</div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              MET method from the Compendium of Physical Activities: MET × body weight (kg) × hours. Strength training
              counts as 3.5–6 MET depending on how many working sets you get through per hour (more sets, less rest =
              higher). Cardio exercises use their own MET for the time you log. It's an estimate (±20–30%, like most
              watches) — set your body weight above for better numbers, or type your watch's number when finishing a
              workout.
            </p>
          </div>
        </div>
      </ListGroup>

      <OptionSheet
        open={sheet === 'rest'}
        onClose={() => setSheet(null)}
        title="Default rest timer"
        value={s.defaultRestSec}
        options={restOptions(s.defaultRestSec)}
        onChange={(v) => void updateSettings({ defaultRestSec: v })}
      />
      <OptionSheet
        open={sheet === 'previous'}
        onClose={() => setSheet(null)}
        title="Previous values"
        value={s.previousValues}
        options={PREVIOUS_OPTIONS}
        onChange={(v) => void updateSettings({ previousValues: v })}
      />
      <ActionSheet
        open={sheet === 'sex'}
        onClose={() => setSheet(null)}
        title="Sex"
        actions={[
          { label: 'Male', icon: s.sex === 'male' ? <Check className="h-5 w-5 text-accent" /> : undefined, onClick: () => void updateSettings({ sex: 'male' }) },
          { label: 'Female', icon: s.sex === 'female' ? <Check className="h-5 w-5 text-accent" /> : undefined, onClick: () => void updateSettings({ sex: 'female' }) },
          { label: 'Unspecified', icon: s.sex == null ? <Check className="h-5 w-5 text-accent" /> : undefined, onClick: () => void updateSettings({ sex: null }) },
        ]}
      />
    </Page>
  );
}

// ------------------------------------------------------------------ offline

function OfflineSection() {
  const [counts, setCounts] = useState<{ cached: number; total: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // null while checking; persisted null = API not available.
  const [storage, setStorage] = useState<{ persisted: boolean | null; usage: number | null; quota: number | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const supported = typeof window !== 'undefined' && 'caches' in window;

  const refreshCounts = async () => {
    if (!supported) return;
    try {
      setCounts(await countCachedExerciseImages());
    } catch {
      setCounts(null);
    }
  };

  const refreshStorage = async () => {
    const st = navigator.storage;
    const persisted = st?.persisted ? await st.persisted().catch(() => null) : null;
    const est = st?.estimate ? await st.estimate().catch(() => null) : null;
    setStorage({ persisted, usage: est?.usage ?? null, quota: est?.quota ?? null });
  };

  useEffect(() => {
    mounted.current = true;
    void refreshCounts();
    void refreshStorage();
    return () => {
      // Leaving Settings stops the download (images saved so far stay cached).
      mounted.current = false;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    if (!supported || abortRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ done: counts?.cached ?? 0, total: counts?.total ?? 0 });
    try {
      const res = await precacheExerciseImages((done, total) => setProgress({ done, total }), ctrl.signal);
      if (!mounted.current) return;
      if (ctrl.signal.aborted) toast('Download stopped', 'info');
      else if (res.failed) toast(`Saved ${res.done - res.failed} of ${res.total} images — ${res.failed} failed. Try again on Wi-Fi.`, 'error', 4000);
      else toast('All exercise images saved for offline use', 'success');
    } catch (e) {
      if (mounted.current) toast(e instanceof Error ? e.message : 'Download failed', 'error');
    } finally {
      abortRef.current = null;
      if (mounted.current) {
        setProgress(null);
        void refreshCounts();
        void refreshStorage();
      }
    }
  };

  const stop = () => abortRef.current?.abort();

  const askPersist = async () => {
    const ok = await requestPersistentStorage();
    await refreshStorage();
    toast(ok ? 'Data will be kept on this device' : 'The browser declined — install Heft to the home screen and try again', ok ? 'success' : 'info', 3500);
  };

  const mb = (b: number) =>
    b < 1024 * 1024
      ? `${Math.max(1, Math.round(b / 1024))} KB`
      : `${(b / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: b < 10 * 1024 * 1024 ? 1 : 0 })} MB`;
  const complete = !!counts && counts.total > 0 && counts.cached >= counts.total;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <ListGroup>
      <div>
        <ListRow
          icon={icon(<CloudDownload />)}
          title="Exercise images"
          subtitle={
            !supported
              ? 'Offline download needs https'
              : progress
                ? 'Downloading — keep Heft open'
                : counts
                ? `${counts.cached.toLocaleString()} of ${counts.total.toLocaleString()} images saved`
                : 'Checking…'
          }
          right={
            !supported ? null : progress ? (
              <button type="button" onClick={stop} className="h-9 rounded-lg bg-danger-soft px-3 text-[14px] font-semibold text-danger active:brightness-110">
                Stop
              </button>
            ) : complete ? (
              <span className="flex items-center gap-1 text-[14px] font-semibold text-success">
                <Check className="h-4 w-4" strokeWidth={3} /> Saved
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void start()}
                disabled={!counts}
                className="h-9 rounded-lg bg-accent-soft px-3 text-[14px] font-semibold text-accent active:brightness-110 disabled:opacity-40"
              >
                Download
              </button>
            )
          }
        />
        {progress ? (
          <div className="px-4 pb-3 pl-[60px]">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[12px] text-muted tabular-nums">
              <span>
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
              </span>
              <span>{pct}%</span>
            </div>
          </div>
        ) : null}
      </div>
      <ListRow
        icon={icon(<HardDrive />)}
        title="Storage used"
        subtitle={storage?.quota ? `of ${mb(storage.quota)} available` : undefined}
        right={storage ? <Value>{storage.usage != null ? mb(storage.usage) : 'Unknown'}</Value> : null}
      />
      <ListRow
        icon={icon(<Database />)}
        title="Keep data on this device"
        subtitle={
          !storage
            ? 'Checking…'
            : storage.persisted
              ? 'Protected from cleanup'
              : storage.persisted === false
                ? 'Tap to protect from cleanup'
                : 'Not supported by this browser'
        }
        right={
          storage?.persisted ? (
            <Value tone="success">On</Value>
          ) : storage?.persisted === false ? (
            <Value tone="warn">Off</Value>
          ) : null
        }
        onClick={storage?.persisted === false ? () => void askPersist() : undefined}
        chevron={storage?.persisted === false}
      />
    </ListGroup>
  );
}

// ------------------------------------------------------------------ data

function DataSection() {
  const { get } = useExercises();
  const s = useSettings();
  const [busy, setBusy] = useState<null | 'export' | 'import' | 'csv' | 'delete'>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stamp = () => format(Date.now(), 'yyyy-MM-dd');

  const doExport = async () => {
    setBusy('export');
    try {
      const blob = await exportBackup();
      await saveFile(blob, `heft-backup-${stamp()}.json`);
      toast('Backup exported', 'success');
    } catch (e) {
      console.error(e);
      toast("Couldn't create the backup", 'error');
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy('import');
    try {
      const text = await file.text();
      const preview = parseBackup(text);
      const d = preview.data;
      const when = preview.exportedAt ? format(preview.exportedAt, 'MMM d, yyyy h:mm a') : 'an unknown date';
      // A version-1 file predates the Food tab: restoring it replaces the workout side and keeps the food log.
      const keepFood = keepsFoodLog(preview);
      const mealsPart = !keepFood && d.meals.length ? `, ${d.meals.length} ${d.meals.length === 1 ? 'meal' : 'meals'}` : '';
      const ok = await confirm({
        title: keepFood ? 'Replace workout data on this device?' : 'Replace all data on this device?',
        message: `Backup from ${when}: ${d.workouts.length} workouts, ${d.routines.length} routines, ${d.measurements.length} measurements${mealsPart}, ${d.media.length} photos. ${
          keepFood
            ? 'It was made before the Food tab, so your food log on this device is kept. Everything else will be replaced.'
            : 'Everything currently on this device will be replaced.'
        }`,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return;
      // Let any queued write of the in-progress workout land first, so it can't overwrite the restored one.
      await flushActiveWorkout();
      const counts = await importBackup(text);
      // The workout logger keeps the in-progress workout in memory — point it at the restored one.
      const active = await db.active.get('current');
      useWorkoutStore.setState({ active: active?.workout ?? null, hydrated: true });
      toast(
        `Restored ${counts.workouts} ${counts.workouts === 1 ? 'workout' : 'workouts'}, ${counts.routines} ${counts.routines === 1 ? 'routine' : 'routines'}, ${counts.measurements} ${counts.measurements === 1 ? 'measurement' : 'measurements'}${
          counts.meals ? `, ${counts.meals} ${counts.meals === 1 ? 'meal' : 'meals'}` : ''
        }${keepFood ? ' · food log kept' : ''}`,
        'success',
        4000,
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't import that file", 'error', 4500);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doCsv = async () => {
    setBusy('csv');
    try {
      const workouts = await db.workouts.toArray();
      if (!workouts.length) {
        toast('No workouts to export yet', 'info');
        return;
      }
      const csv = exportCsv(workouts, get, s.unit, s.distanceUnit);
      // BOM so Excel opens it as UTF-8.
      await saveFile(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `heft-workouts-${stamp()}.csv`);
      toast(`Exported ${workouts.length} ${workouts.length === 1 ? 'workout' : 'workouts'}`, 'success');
    } catch (e) {
      console.error(e);
      toast("Couldn't export the CSV", 'error');
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    const first = await confirm({
      title: 'Delete all data?',
      message:
        'This erases every workout, routine, custom exercise, measurement, meal, photo and setting on this device, and forgets the Claude and USDA keys saved for the Food tab.',
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!first) return;
    const second = await confirm({
      title: 'Are you absolutely sure?',
      message: "This can't be undone. Export a backup first if you might want your history later.",
      confirmLabel: 'Delete Everything',
      danger: true,
    });
    if (!second) return;
    setBusy('delete');
    try {
      useWorkoutStore.getState().discard();
      await flushActiveWorkout();
      await db.transaction('rw', db.tables, async () => {
        await Promise.all(db.tables.map((t) => t.clear()));
      });
      // The Food tab's API keys live in localStorage, outside the database: a wiped phone must forget them too.
      clearNutritionKeys();
      window.location.reload();
    } catch (e) {
      console.error(e);
      toast("Couldn't delete everything", 'error');
      setBusy(null);
    }
  };

  const spin = (k: typeof busy) => (busy === k ? <Spinner className="h-5 w-5" /> : null);

  return (
    <>
      <ListGroup>
        <ListRow
          icon={icon(<Download />)}
          title="Export backup"
          subtitle="Everything, including photos (.json)"
          right={spin('export')}
          onClick={busy ? undefined : () => void doExport()}
        />
        <ListRow
          icon={icon(<Upload />)}
          title="Import backup"
          subtitle="Replaces all data on this device"
          right={spin('import')}
          onClick={busy ? undefined : () => fileRef.current?.click()}
        />
        <ListRow
          icon={icon(<FileSpreadsheet />)}
          title="Export CSV"
          subtitle="Every set, for spreadsheets"
          right={spin('csv')}
          onClick={busy ? undefined : () => void doCsv()}
        />
        <ListRow
          icon={icon(<Trash2 />)}
          title="Delete all data"
          danger
          right={spin('delete')}
          onClick={busy ? undefined : () => void doDelete()}
        />
      </ListGroup>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => void doImport(e.target.files?.[0])}
      />
    </>
  );
}
