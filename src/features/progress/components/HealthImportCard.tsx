import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ChevronRight, Heart } from 'lucide-react';
import type { Unit } from '../../../types';
import { Button, Card } from '../../../components/ui';
import { useHealthImport } from './useHealthImport';

/*
 * Measurements → "Import from Apple Health" (iPhone/iPad only). "Get from Health" runs the user's "Health to Heft"
 * Shortcut, which copies the last 30 days of weigh-ins as text; back in Heft, "Paste from Health" reads the
 * clipboard, previews what will be added / updated / skipped, and Save writes it (lib/healthImport.ts: every weigh-in
 * is its own row, and one deleted in Heft stays deleted). When the clipboard can't be read (permission refused, older
 * iOS), the sheet offers a box to long-press-paste into instead.
 * The flow itself (state, handlers, the paste / preview sheet) is useHealthImport, shared with the Today Body card.
 */

export function HealthImportCard({ unit }: { unit: Unit }) {
  const navigate = useNavigate();
  const { getFromHealth, pasteFromHealth, returned, lastAt, neverImported, sheet } = useHealthImport(unit);

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
          {/* Handlers bound directly: both must run inside the tap itself (iOS). */}
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

      {sheet}
    </>
  );
}
