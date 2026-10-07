import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, RefreshCw } from 'lucide-react';
import type { Unit } from '../../../types';
import { Button, cx, toast } from '../../../components/ui';
import { checkInboxNow, type InboxStatus, type InboxSyncResult } from '../../../lib/healthInbox';
import { useHealthImport } from '../../progress/components/useHealthImport';
import { inboxLine, plural, syncedLabel } from './format';

/*
 * The Body card's Hume scale row.
 * - Automatic sync set up (a GitHub key saved on this device, lib/healthInbox): "Hume · auto sync", how the last
 *   check went, and Check now. Weigh-ins arrive on their own whenever the Hume app closes on the phone.
 * - Not set up (iPhone / iPad): pull weigh-ins by hand without leaving Today, the same flow and preview / paste
 *   sheet as the Measurements page (useHealthImport), a "Set up" link to the Shortcut guide until the first import,
 *   and "Make it automatic".
 */

export const HUME_GUIDE = '/settings/apple-health?to=weigh-ins';
/** Settings → Apple Health, the automatic sync part (GitHub key + the Shortcuts automation). */
export const HUME_AUTO_SETUP = '/settings/apple-health?to=auto';

// ------------------------------------------------------------------ automatic

export interface HumeAutoRowProps {
  status: Pick<InboxStatus, 'state' | 'checkedAt' | 'lastImport' | 'lastPostAt'>;
  now: number;
  /** The Check now call is running (the hook's own 'checking' state counts too). */
  checking?: boolean;
  onCheck: () => void;
}

/** Pure view of the automatic row (props only). */
export function HumeAutoRowView({ status, now, checking = false, onCheck }: HumeAutoRowProps) {
  const busy = checking || status.state === 'checking';
  const line = inboxLine(status, now, busy);
  return (
    <div className="border-t border-line px-4 pt-3 pb-4" data-state="sync-auto" data-inbox={busy ? 'checking' : status.state}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
            <Heart className="h-3.5 w-3.5 shrink-0 text-danger" fill="currentColor" aria-hidden />
            <span className="truncate">Hume · auto sync</span>
          </div>
          {/* No aria-live: the line ticks every minute and flips to Checking… on every wake. Real news is a toast. */}
          <p
            className={cx('mt-0.5 text-[13px] leading-snug tabular-nums', line.fix ? 'text-danger' : 'text-muted')}
            data-line="inbox"
          >
            {line.text}
          </p>
          {line.fix ? (
            <Link
              to={HUME_AUTO_SETUP}
              className="-mb-2 inline-flex min-h-10 items-center text-[13px] font-semibold text-accent active:opacity-60"
            >
              Fix in Settings
            </Link>
          ) : null}
        </div>
        <Button
          variant="secondary"
          className="h-10! shrink-0 px-3!"
          icon={<RefreshCw className={cx('h-4 w-4', busy && 'animate-spin')} aria-hidden />}
          disabled={busy}
          onClick={onCheck}
        >
          Check now
        </Button>
      </div>
    </div>
  );
}

/** "Now" that moves on every half minute while the row is up, so "Checked 5 min ago" doesn't freeze. */
function useClock(everyMs = 30_000): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return t;
}

/**
 * The toast after a tap on Check now, or null. HealthInboxWatcher already toasts every check's new weigh-ins ("From
 * Hume: 184.2 lb · 19.4% body fat") and a rejected key, and problems show on the status line, so only the answers it
 * stays quiet about are said here.
 */
export function checkNowToast(r: Pick<InboxSyncResult, 'state' | 'added' | 'updated'>): [string, 'success' | 'info'] | null {
  if (r.state !== 'ok' || r.added > 0) return null;
  return r.updated > 0 ? [`${plural(r.updated, 'weigh-in')} updated`, 'success'] : ['No new weigh-ins', 'info'];
}

function HumeAuto({ status, now }: { status: InboxStatus; now: number }) {
  const clock = useClock();
  const [checking, setChecking] = useState(false);
  const onCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const feedback = checkNowToast(await checkInboxNow());
      if (feedback) toast(...feedback);
    } finally {
      setChecking(false);
    }
  };
  return <HumeAutoRowView status={status} now={Math.max(now, clock)} checking={checking} onCheck={onCheck} />;
}

// ------------------------------------------------------------------ by hand

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

/** Pure view of the by-hand row (props only). */
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
    <div className="border-t border-line px-4 pt-3 pb-4" data-state="sync-manual">
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
      {/* -mb-2: the 40px tap target eats into the row's bottom padding instead of adding to it. */}
      <Link
        to={HUME_AUTO_SETUP}
        className="mt-1 -mb-2 flex h-10 items-center justify-center gap-1.5 text-[14px] font-semibold text-accent active:opacity-60"
        data-action="make-automatic"
      >
        <RefreshCw className="h-4 w-4" aria-hidden />
        Make it automatic
      </Link>
    </div>
  );
}

function HumeManual({ unit, now, loading }: { unit: Unit; now: number; loading: boolean }) {
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

// ------------------------------------------------------------------ live

/**
 * Live row. `inbox` = useInboxStatus(), read once by BodyCard (which also decides whether the row shows at all:
 * on iPhone / iPad, or anywhere once automatic sync is set up). Mounted with the card, so its settings load alongside.
 */
export function HumeSync({ unit, now, inbox, loading = false }: { unit: Unit; now: number; inbox: InboxStatus; loading?: boolean }) {
  return inbox.configured ? <HumeAuto status={inbox} now={now} /> : <HumeManual unit={unit} now={now} loading={loading} />;
}
