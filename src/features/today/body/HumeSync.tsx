import { Link } from 'react-router-dom';
import { Heart } from 'lucide-react';
import type { Unit } from '../../../types';
import { Button } from '../../../components/ui';
import { useHealthImport } from '../../progress/components/useHealthImport';
import { syncedLabel } from './format';

/*
 * The Body card's Hume scale row (iPhone/iPad only): pull the latest weigh-in from Apple Health without leaving
 * Today. Same flow and same preview / paste sheet as the Measurements page (useHealthImport). Never imported yet:
 * the buttons plus a "Set up" link to the Shortcut guide, like the Measurements card.
 */

export const HUME_GUIDE = '/settings/apple-health?to=weigh-ins';

export interface HumeSyncRowProps {
  /** Settings are still loading: hold the buttons row's height (no flash of "Not synced yet" for a user who has synced). */
  loading?: boolean;
  /** Settings.healthImportedAt; null = never imported. */
  importedAt: number | null;
  neverImported: boolean;
  /** Back from the Shortcuts app: Paste is the next step. */
  returned: boolean;
  now: number;
  /** The hook's handlers, bound to onClick as they are (iOS: the tap itself must start the app link / clipboard read). */
  onGet: () => void;
  onPaste: () => void;
}

/** Pure view of the row (props only). */
export function HumeSyncRowView({ loading = false, importedAt, neverImported, returned, now, onGet, onPaste }: HumeSyncRowProps) {
  if (loading) {
    return (
      <div className="invisible" aria-hidden data-state="sync-loading">
        <ButtonsRow label="Hume scale" returned={false} onGet={noop} onPaste={noop} />
      </div>
    );
  }
  const label = returned
    ? 'Back from Shortcuts? Tap Paste.'
    : `Hume scale · ${importedAt != null ? syncedLabel(importedAt, now) : 'Not synced yet'}`;
  return (
    <ButtonsRow
      label={label}
      returned={returned}
      onGet={onGet}
      onPaste={onPaste}
      setupHref={neverImported ? HUME_GUIDE : undefined}
    />
  );
}

const noop = () => {};

function ButtonsRow({
  label,
  returned,
  onGet,
  onPaste,
  setupHref,
}: {
  label: string;
  returned: boolean;
  onGet: () => void;
  onPaste: () => void;
  /** Never imported: a "Set up" link to the Shortcut guide at the end of the label line. */
  setupHref?: string;
}) {
  return (
    <div className="border-t border-line px-4 pt-3 pb-4">
      <div className="flex items-center gap-1.5 text-[13px] text-muted tabular-nums">
        <Heart className="h-3.5 w-3.5 shrink-0 text-danger" fill="currentColor" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {setupHref ? (
          // -my-2 py-2: a taller tap target that doesn't grow the line (same height as the loading placeholder).
          <Link to={setupHref} className="-my-2 ml-auto shrink-0 py-2 pl-2 font-semibold text-accent active:opacity-60">
            Set up
          </Link>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button variant={returned ? 'secondary' : 'soft'} className="h-10! px-2!" onClick={onGet}>
          Get from Health
        </Button>
        <Button variant={returned ? 'primary' : 'secondary'} className="h-10! px-2!" onClick={onPaste}>
          Paste
        </Button>
      </div>
    </div>
  );
}

/** Live row: owns the import flow and renders its sheet. Mounted with the card, so its settings load alongside. */
export function HumeSync({ unit, now, loading = false }: { unit: Unit; now: number; loading?: boolean }) {
  const health = useHealthImport(unit);
  return (
    <>
      <HumeSyncRowView
        loading={loading}
        importedAt={health.importedAt}
        neverImported={health.neverImported}
        returned={health.returned}
        now={now}
        onGet={health.getFromHealth}
        onPaste={health.pasteFromHealth}
      />
      {health.sheet}
    </>
  );
}
