import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ChevronRight, ClipboardPaste, Heart, TriangleAlert } from 'lucide-react';
import type { Measurement, Unit } from '../../../types';
import { db } from '../../../db';
import { Button, Card, Sheet, TextArea, cx, toast } from '../../../components/ui';
import { getSettings, useSettings } from '../../../lib/settings';
import {
  applyHealthImport,
  HEALTH_IMPORT_SHORTCUT,
  HEALTH_SKIP_LABEL,
  importShortcutUrl,
  parseHealthText,
  planHealthImport,
  type HealthImportPlan,
  type HealthKind,
  type HealthParseResult,
  type HealthSkipReason,
} from '../../../lib/healthImport';
import { formatNumber, kgToUnit } from '../../../lib/units';

/*
 * Measurements → "Import from Apple Health" (iPhone/iPad only). "Get from Health" runs the user's "Health to Heft"
 * Shortcut, which copies the latest weigh-in as text; back in Heft, "Paste from Health" reads the clipboard,
 * previews what will be added / updated / skipped, and Save writes it (lib/healthImport.ts). When the clipboard
 * can't be read (permission refused, older iOS), the sheet offers a box to long-press-paste into instead.
 */

const NOT_HEALTH_DATA = `That isn't Heft health data — run the ${HEALTH_IMPORT_SHORTCUT} Shortcut first`;

type SheetState =
  | { mode: 'paste'; text: string; error?: string }
  | { mode: 'preview'; text: string; parsed: HealthParseResult; plan: HealthImportPlan; reimportAll: boolean };

/** The "Nothing new" box, by why the newest weigh-in in the paste was skipped. */
const NOTHING_NEW: Record<HealthSkipReason, string> = {
  unchanged:
    'Heft already has this weigh-in. Weigh in again, give it a few minutes to reach Apple Health, then run the Shortcut.',
  later: "Heft keeps the first weigh-in of each day, and that day's is already in. Edit that entry if you want the later one.",
  old: 'You deleted this weigh-in in Heft. Tap Bring deleted weigh-ins back to restore it.',
  manual:
    'You already logged a weigh-in that day, and Heft keeps yours. To use the scale’s reading instead, delete your entry and paste again.',
  edited: 'You edited this weigh-in in Heft, so Heft keeps your version.',
};

/** A template line that came back empty while the other one had a value. */
const MISSING_HINT: Record<HealthKind, string> = {
  weight:
    'Weight came back empty. Check step 2 of the guide: the type after “Type is” must be Weight, and a Start Date filter can hide your last weigh-in.',
  bodyFat:
    'Body fat came back empty. If your scale measures it, check step 3 of the guide: the second Find Health Samples must read “Find All Health Samples”, not “Filter Health Samples”.',
};

const dayLabel = (ms: number) => format(ms, new Date(ms).getFullYear() === new Date().getFullYear() ? 'MMM d' : 'MMM d, yyyy');

/** "Oct 5 · 184.2 lb · 18.5% body fat" */
function weighInLabel(m: Pick<Measurement, 'date' | 'bodyweightKg' | 'bodyFatPct'>, unit: Unit): string {
  const parts = [dayLabel(m.date)];
  if (m.bodyweightKg) parts.push(`${formatNumber(kgToUnit(m.bodyweightKg, unit), 1)} ${unit}`);
  if (m.bodyFatPct) parts.push(`${formatNumber(m.bodyFatPct, 1)}% body fat`);
  return parts.join(' · ');
}

export function HealthImportCard({ unit }: { unit: Unit }) {
  const settings = useSettings();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [saving, setSaving] = useState(false);
  // "Get from Health" opened the Shortcuts app; when Heft is visible again, Paste becomes the next step.
  const [awaitingReturn, setAwaitingReturn] = useState(false);
  const [returned, setReturned] = useState(false);

  useEffect(() => {
    if (!awaitingReturn) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setAwaitingReturn(false);
      setReturned(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [awaitingReturn]);

  const lastAt = settings.healthImportedThrough ?? settings.healthImportedAt ?? null;
  const neverImported = settings.healthImportedAt == null;

  const getFromHealth = () => {
    // From the tap itself: iOS only follows an app link that comes from a user gesture.
    setAwaitingReturn(true);
    setReturned(false);
    window.location.href = importShortcutUrl();
  };

  /** Parse, plan against the database and show the preview. false = not Heft health data. */
  const openPreview = async (text: string, reimportAll = false): Promise<boolean> => {
    const parsed = parseHealthText(text, { unit });
    if (!parsed.recognized) return false;
    const [existing, s] = await Promise.all([db.measurements.toArray(), getSettings()]);
    const plan = planHealthImport(parsed.samples, existing, s, { reimportAll });
    setSheet({ mode: 'preview', text, parsed, plan, reimportAll });
    return true;
  };

  const finishPaste = async (read: Promise<string>) => {
    let text: string;
    try {
      text = await read;
    } catch {
      // Refused or unsupported: let the user paste by hand.
      setSheet({ mode: 'paste', text: '' });
      return;
    }
    try {
      if (!(await openPreview(text))) toast(NOT_HEALTH_DATA, 'error', 4000);
    } catch (e) {
      console.error(e);
      toast("Couldn't read your measurements", 'error');
    }
  };

  const pasteFromHealth = () => {
    let read: Promise<string>;
    try {
      // FIRST, before anything else: iOS only allows a clipboard read that starts inside the tap itself.
      read = navigator.clipboard.readText();
    } catch (e) {
      read = Promise.reject(e);
    }
    void finishPaste(read);
  };

  const usePasted = async () => {
    if (sheet?.mode !== 'paste') return;
    try {
      if (!(await openPreview(sheet.text))) {
        setSheet({ ...sheet, error: NOT_HEALTH_DATA });
        toast(NOT_HEALTH_DATA, 'error', 4000);
      }
    } catch (e) {
      console.error(e);
      toast("Couldn't read your measurements", 'error');
    }
  };

  const save = async () => {
    if (sheet?.mode !== 'preview' || saving) return;
    if (!sheet.parsed.samples.length) {
      setSheet(null);
      return;
    }
    setSaving(true);
    try {
      // The watermark only covers samples this import actually brought in (plan.importedThrough).
      const { added, updated } = await applyHealthImport(sheet.plan);
      const n = added + updated;
      toast(n ? `Imported ${n} weigh-in${n === 1 ? '' : 's'}` : 'Nothing new from Apple Health', n ? 'success' : 'info');
      setSheet(null);
      setReturned(false);
    } catch (e) {
      console.error(e);
      toast("Couldn't save the import", 'error');
    } finally {
      setSaving(false);
    }
  };

  const toGuide = () => {
    setSheet(null);
    navigate('/settings/apple-health?to=weigh-ins');
  };

  return (
    <>
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
            <Heart className="h-5 w-5" fill="currentColor" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] leading-tight font-semibold">Import from Apple Health</h2>
            <div className="mt-0.5 truncate text-[13px] text-muted tabular-nums">
              {lastAt != null ? `Last import: ${format(lastAt, 'MMM d, h:mm a')}` : 'Weight & body fat from your scale'}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant={returned ? 'secondary' : 'soft'} className="px-2!" onClick={getFromHealth}>
            Get from Health
          </Button>
          <Button variant={returned ? 'primary' : 'secondary'} className="px-2!" onClick={pasteFromHealth}>
            Paste from Health
          </Button>
        </div>
        {returned ? (
          <p className="mt-2 text-center text-[13px] text-muted">Back from Shortcuts? Tap Paste from Health.</p>
        ) : null}
        {neverImported ? (
          <button
            type="button"
            onClick={() => navigate('/settings/apple-health?to=weigh-ins')}
            className="mt-1 -mb-2 flex h-10 w-full items-center justify-center gap-0.5 text-[14px] font-semibold text-accent active:opacity-60"
          >
            Set up the Shortcut
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : null}
      </Card>

      <Sheet
        open={!!sheet}
        onClose={() => (saving ? undefined : setSheet(null))}
        size={sheet?.mode === 'paste' ? 'auto' : 'full'}
        title="Apple Health"
        left={
          <button type="button" onClick={() => setSheet(null)} disabled={saving} className="h-10 px-1 text-[17px] text-accent active:opacity-60">
            Cancel
          </button>
        }
        footer={
          sheet?.mode === 'preview' ? (
            <PreviewFooter sheet={sheet} saving={saving} onSave={() => void save()} />
          ) : undefined
        }
      >
        {sheet?.mode === 'paste' ? (
          <div className="space-y-3 px-4 pt-1 pb-6">
            <p className="text-[14px] leading-relaxed text-muted">
              Heft couldn't read the clipboard by itself. Run the <strong className="font-semibold text-fg">{HEALTH_IMPORT_SHORTCUT}</strong>{' '}
              Shortcut, then long-press the box below, tap <strong className="font-semibold text-fg">Paste</strong> and{' '}
              <strong className="font-semibold text-fg">Use pasted text</strong>.
            </p>
            <TextArea
              value={sheet.text}
              onChange={(e) => setSheet({ mode: 'paste', text: e.target.value })}
              rows={6}
              placeholder={'heft-health\nweight: …'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="font-mono"
              aria-label="Health data from the Shortcut"
            />
            {sheet.error ? <p className="text-[13px] text-danger">{sheet.error}</p> : null}
            <Button block icon={<ClipboardPaste className="h-4 w-4" />} disabled={!sheet.text.trim()} onClick={() => void usePasted()}>
              Use pasted text
            </Button>
          </div>
        ) : sheet?.mode === 'preview' ? (
          <Preview sheet={sheet} unit={unit} onReimport={() => void openPreview(sheet.text, true)} onGuide={toGuide} />
        ) : null}
      </Sheet>
    </>
  );
}

function PreviewFooter({ sheet, saving, onSave }: { sheet: Extract<SheetState, { mode: 'preview' }>; saving: boolean; onSave: () => void }) {
  const n = sheet.plan.add.length + sheet.plan.update.length;
  if (!n) {
    return (
      <Button block variant="secondary" disabled={saving} onClick={onSave}>
        Done
      </Button>
    );
  }
  return (
    <Button block disabled={saving} onClick={onSave}>
      {saving ? 'Saving…' : 'Save'}
    </Button>
  );
}

function Preview({
  sheet,
  unit,
  onReimport,
  onGuide,
}: {
  sheet: Extract<SheetState, { mode: 'preview' }>;
  unit: Unit;
  onReimport: () => void;
  onGuide: () => void;
}) {
  const { plan, parsed } = sheet;
  const rows = [
    ...plan.add.map((m) => ({ m, kind: 'new' as const })),
    ...plan.update.map((m) => ({ m, kind: 'update' as const })),
  ].sort((a, b) => b.m.date - a.m.date);
  const skipped = [...plan.skipped].sort((a, b) => b.at - a.at);
  const deletedBefore = !sheet.reimportAll && plan.skipped.some((s) => s.reason === 'old');
  // Explain the newest weigh-in: that's the one the user just made.
  const nothingNew = NOTHING_NEW[skipped[0]?.reason ?? 'unchanged'];
  const missing = parsed.samples.length ? parsed.missing : [];

  return (
    <div className="space-y-5 px-4 pt-1 pb-6">
      {!parsed.samples.length ? (
        <div className="rounded-xl bg-surface-2 px-4 py-5 text-center">
          {parsed.errors.length ? (
            <>
              <div className="text-[15px] font-semibold">Heft couldn't read the Shortcut's text</div>
              <p className="mt-1 text-[13px] leading-snug text-muted">
                See below. Usually a bubble in the Text step is wrong: a date line needs the Health Samples’ Start Date,
                with its Date Format set to ISO 8601.
              </p>
            </>
          ) : (
            <>
              <div className="text-[15px] font-semibold">No weigh-ins in it</div>
              <p className="mt-1 text-[13px] leading-snug text-muted">
                The Shortcut ran but didn't find a Weight or Body Fat Percentage sample. Check its Find Health Samples
                steps: the type after “Type is”, and the Start Date filter.
              </p>
            </>
          )}
          <Button variant="ghost" className="mt-2" onClick={onGuide}>
            Open the guide
          </Button>
        </div>
      ) : rows.length ? (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">
            {rows.length === 1 ? 'Will save' : `Will save ${rows.length}`}
          </h3>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-surface-2">
            {rows.map(({ m, kind }) => (
              <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                <Heart className="h-4 w-4 shrink-0 text-danger" fill="currentColor" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold tabular-nums">{weighInLabel(m, unit)}</span>
                  <span className="block text-[13px] text-muted tabular-nums">{format(m.date, 'h:mm a')}</span>
                </span>
                <span
                  className={cx(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-semibold',
                    kind === 'new' ? 'bg-success-soft text-success' : 'bg-accent-soft text-accent',
                  )}
                >
                  {kind === 'new' ? 'New' : 'Update'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="rounded-xl bg-surface-2 px-4 py-5 text-center">
          <div className="text-[15px] font-semibold">Nothing new</div>
          <p className="mt-1 text-[13px] leading-snug text-muted">{nothingNew}</p>
        </div>
      )}

      {missing.length ? (
        <section className="space-y-1.5 rounded-xl bg-warn-soft px-3 py-2.5">
          {missing.map((k) => (
            <p key={k} className="flex gap-1.5 text-[13px] leading-snug text-fg">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <span>{MISSING_HINT[k]}</span>
            </p>
          ))}
          <Button variant="ghost" className="mt-1 -ml-3" onClick={onGuide}>
            Open the guide
          </Button>
        </section>
      ) : null}

      {skipped.length ? (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">Skipped</h3>
          <ul className="space-y-1 text-[14px] text-muted">
            {skipped.map((s, i) => (
              <li key={s.at + s.reason + i} className="tabular-nums">
                {dayLabel(s.at)} · {HEALTH_SKIP_LABEL[s.reason]}
              </li>
            ))}
          </ul>
          {deletedBefore ? (
            <Button variant="ghost" className="mt-1 -ml-4" onClick={onReimport}>
              Bring deleted weigh-ins back
            </Button>
          ) : null}
        </section>
      ) : null}

      {parsed.errors.length ? (
        <section className="rounded-xl bg-warn-soft px-3 py-2.5">
          <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-fg">
            <TriangleAlert className="h-4 w-4 text-warn" />
            Couldn't use
          </h3>
          <ul className="mt-1 space-y-0.5 text-[13px] text-fg">
            {parsed.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
