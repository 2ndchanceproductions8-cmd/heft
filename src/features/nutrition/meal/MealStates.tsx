import type { ReactNode } from 'react';
import { Barcode, KeyRound, Minus, Plus, Search, TriangleAlert, Utensils } from 'lucide-react';
import { Button, cx, IconButton, Spinner } from '../../../components/ui';
import { MAX_SERVES } from '../../../lib/nutrition/math';
import type { Confidence, MealInput, Totals } from '../../../lib/nutrition/types';
import { ConfidenceBadge, formatKcal, MacroLine } from '../ui';
import { anglesLabel } from './format';
import { Notice } from './parts';

/*
 * Presentational pieces of the meal screen. They take plain props (no live queries) so they render in tests.
 */

/** Photo(s) of the meal, or an icon for meals without one. `dim` is the analyzing look. */
export function MealPhotos({ urls, kind, dim, children }: { urls: string[]; kind: MealInput['kind']; dim?: boolean; children?: ReactNode }) {
  const Icon = kind === 'barcode' ? Barcode : kind === 'search' ? Search : Utensils;
  return (
    <div className="relative overflow-hidden rounded-2xl bg-surface">
      {urls.length ? (
        <div className="no-scrollbar flex aspect-[4/3] snap-x snap-mandatory overflow-x-auto">
          {urls.map((u, i) => (
            <img
              key={u}
              src={u}
              alt={urls.length > 1 ? `Meal photo ${i + 1} of ${urls.length}` : 'Meal photo'}
              className={cx('h-full w-full shrink-0 snap-center object-cover', dim && 'opacity-35')}
            />
          ))}
        </div>
      ) : (
        <div className={cx('flex items-center justify-center text-faint', children ? 'aspect-[4/3]' : 'h-28')}>
          {children ? null : <Icon className="h-10 w-10" />}
        </div>
      )}
      {urls.length > 1 && !children ? (
        <div className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-backdrop px-2 py-0.5 text-[12px] font-semibold text-white">
          {urls.length} photos · swipe
        </div>
      ) : null}
      {children ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">{children}</div> : null}
    </div>
  );
}

/** Claude is working: dimmed photos, a spinner and how many angles it is judging from. */
export function AnalyzingView({ photoUrls, photoCount, description }: { photoUrls: string[]; photoCount: number; description?: string }) {
  return (
    <div className="space-y-3 px-4 pt-4" role="status" aria-live="polite">
      <MealPhotos urls={photoUrls} kind={photoCount ? 'photo' : 'text'} dim>
        <Spinner className="h-9 w-9 text-accent" />
        <div className="text-[17px] font-semibold text-fg">Reading your plate…</div>
        <div className="text-[14px] text-muted">
          {photoCount > 0 ? `Judging portions from ${anglesLabel(photoCount)}` : 'Working from your description'}
        </div>
      </MealPhotos>
      {description ? <DescriptionCard text={description} /> : null}
      <p className="px-2 text-center text-[13px] text-faint">You can leave this screen — it keeps going while Heft is open.</p>
    </div>
  );
}

export function DescriptionCard({ text }: { text: string }) {
  return (
    <div className="rounded-2xl bg-surface px-4 py-3">
      <div className="text-[12px] font-semibold tracking-wide text-muted uppercase">You said</div>
      <div className="mt-0.5 text-[15px] text-fg">{text}</div>
    </div>
  );
}

/**
 * The meal can't show numbers yet: either no Claude key is saved ('no_key') or the analysis failed / was
 * interrupted ('failed'). Both offer manual entry.
 */
export function MealProblem({
  variant,
  error,
  hasKey,
  photosKept,
  retrying,
  onRetry,
  onAddKey,
  onManual,
}: {
  variant: 'failed' | 'no_key';
  error?: string | null;
  hasKey: boolean;
  /** The meal has photos (kept for Retry). */
  photosKept?: boolean;
  retrying?: boolean;
  onRetry: () => void;
  onAddKey: () => void;
  onManual: () => void;
}) {
  if (variant === 'no_key') {
    return (
      <Notice
        tone="accent"
        icon={<KeyRound className="h-5 w-5" />}
        title="Add your Claude key to analyze this"
        actions={
          <>
            <Button block onClick={onAddKey}>
              Add Claude key
            </Button>
            <Button block variant="secondary" onClick={onManual}>
              Enter manually instead
            </Button>
          </>
        }
      >
        The meal is saved — add a key in Food settings, then open it again to analyze. Keys stay on this device.
      </Notice>
    );
  }
  return (
    <Notice
      tone="danger"
      icon={<TriangleAlert className="h-5 w-5" />}
      title="Couldn't analyze this meal"
      actions={
        <>
          {hasKey ? (
            <Button block onClick={onRetry} disabled={retrying} icon={retrying ? <Spinner className="h-5 w-5 text-on-accent" /> : null}>
              Retry
            </Button>
          ) : (
            <Button block onClick={onAddKey}>
              Add Claude key
            </Button>
          )}
          <Button block variant="secondary" onClick={onManual}>
            Enter manually instead
          </Button>
        </>
      }
    >
      <span className="text-danger">{error || 'The analysis failed.'}</span>
      {photosKept ? ' Your photos are kept.' : null}
    </Notice>
  );
}

/** Big kcal number, macros, confidence, and (optionally) the day ring on the right. */
export function MealSummary({ totals, confidence, aside }: { totals: Totals; confidence: Confidence | null; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-surface p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[40px] leading-none font-bold tracking-tight tabular-nums">{formatKcal(totals.kcal)}</span>
          <span className="text-[15px] font-medium text-muted">kcal</span>
        </div>
        <MacroLine proteinG={totals.proteinG} carbsG={totals.carbsG} fatG={totals.fatG} className="mt-1.5 block text-[15px]" />
        {confidence ? <ConfidenceBadge confidence={confidence} className="mt-2" /> : null}
      </div>
      {aside}
    </div>
  );
}

/** What Claude said about the meal: notes, the scale reference, how many angles it used. */
export function AnalysisNotes({
  notes,
  scaleReference,
  angles,
  isPhoto,
  weighedLabel,
}: {
  notes: string;
  scaleReference: string | null;
  angles: number;
  isPhoto: boolean;
  /** "350 g" when the user weighed the meal. */
  weighedLabel: string | null;
}) {
  const lines: string[] = [];
  if (weighedLabel) lines.push(`You weighed it: ${weighedLabel}`);
  if (isPhoto) {
    if (scaleReference) lines.push(`Scale: ${scaleReference}`);
    else if (!weighedLabel) lines.push('No size reference — add a coin or weigh it next time');
  }
  if (angles > 1) lines.push(`Judged from ${anglesLabel(angles)}`);
  if (!notes.trim() && !lines.length) return null;
  return (
    <div className="space-y-1 rounded-2xl bg-surface px-4 py-3">
      {notes.trim() ? <p className="text-[14px] leading-snug text-muted">{notes.trim()}</p> : null}
      {lines.map((l) => (
        <p key={l} className="text-[13px] text-faint">
          {l}
        </p>
      ))}
    </div>
  );
}

/** Servings 1..20: every item is multiplied by it. */
export function ServesStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-medium">Servings</div>
        <div className="text-[13px] text-muted">Every food × {value}</div>
      </div>
      <IconButton label="One serving fewer" className="bg-surface-2" disabled={value <= 1} onClick={() => onChange(value - 1)}>
        <Minus className="h-5 w-5" />
      </IconButton>
      <span className="w-8 text-center text-[18px] font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <IconButton label="One serving more" className="bg-surface-2" disabled={value >= MAX_SERVES} onClick={() => onChange(value + 1)}>
        <Plus className="h-5 w-5" />
      </IconButton>
    </div>
  );
}
