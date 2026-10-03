import { Coins } from 'lucide-react';
import { Segmented, TextArea } from '../../../components/ui';
import type { MassUnit } from '../../../lib/units';

/**
 * What the user knows that a photo can't show: a description (authoritative context for Claude) and an
 * optional weighed total (an exact weight beats any estimate and lifts confidence).
 */
export function DetailsPanel({
  description,
  onDescription,
  weightText,
  onWeightText,
  mu,
  onMu,
  weightError,
}: {
  description: string;
  onDescription: (v: string) => void;
  weightText: string;
  onWeightText: (v: string) => void;
  mu: MassUnit;
  onMu: (mu: MassUnit) => void;
  weightError: string | null;
}) {
  return (
    <div className="space-y-4 rounded-2xl bg-surface p-4">
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium text-muted">Description</span>
        <TextArea
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          placeholder="What is it? e.g. chicken burrito bowl, no sour cream"
          rows={3}
          maxLength={600}
          className="text-[16px]"
        />
      </label>
      <div>
        <span className="mb-1.5 block text-[13px] font-medium text-muted" id="capture-weight-label">
          Weight (optional)
        </span>
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            aria-labelledby="capture-weight-label"
            aria-invalid={!!weightError}
            value={weightText}
            placeholder="0"
            onChange={(e) => onWeightText(e.target.value.replace(/[^\d.,]/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3.5 text-[16px] font-semibold tabular-nums text-fg outline-none placeholder:font-normal placeholder:text-faint focus:border-accent"
          />
          <Segmented
            className="w-28"
            value={mu}
            onChange={onMu}
            options={[
              { value: 'g', label: 'g' },
              { value: 'oz', label: 'oz' },
            ]}
          />
        </div>
        {weightError ? (
          <span className="mt-1 block text-[13px] text-danger">{weightError}</span>
        ) : (
          <span className="mt-1 block text-[12px] text-faint">Weighed it? An exact weight beats any estimate.</span>
        )}
      </div>
    </div>
  );
}

/** The one habit that makes photo portions accurate. */
export function ScaleTip() {
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-accent-soft px-4 py-3">
      <Coins className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
      <p className="text-[14px] leading-snug text-fg">Put a coin or fork next to the plate so Claude can judge size.</p>
    </div>
  );
}
