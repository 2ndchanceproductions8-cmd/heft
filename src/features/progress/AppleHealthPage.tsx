import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { format } from 'date-fns';
import { ArrowDownToLine, ArrowUpFromLine, Copy, ExternalLink, Heart, KeyRound, RefreshCw } from 'lucide-react';
import { db } from '../../db';
import { Button, confirm, cx, ListGroup, ListRow, Page, SectionHeader, Spinner, TextField, Toggle, TopBar, toast } from '../../components/ui';
import { activeCalories, inSafariTab, isAppleMobile, sendWorkoutToHealth, SHORTCUT_NAME } from '../../lib/appleHealth';
import {
  HEALTH_IMPORT_SHORTCUT,
  HEALTH_MARKER,
  HEALTH_PASTE_INPUT,
  HEALTH_TEMPLATE_LINES,
  healthTemplateText,
} from '../../lib/healthImport';
import {
  INBOX,
  INBOX_COMMENTS_URL,
  cleanToken,
  clearInboxToken,
  getInboxToken,
  setInboxToken,
  testInboxToken,
  useInboxStatus,
  type InboxState,
  type InboxStatus,
} from '../../lib/healthInbox';
import { isAnthropicSecret, maskKey } from '../../lib/nutrition/keys';
import { DEFAULT_SETTINGS, updateSettings } from '../../lib/settings';
import { formatDuration } from '../../lib/units';

/*
 * Settings → Apple Health: both Shortcut bridges.
 * - Send workouts ("Heft to Health"): how to build the Shortcut, the switch that turns on the "Send to Apple Health"
 *   button, a test send and troubleshooting. Written for the Shortcuts app's action names (Get Dictionary from
 *   Input, Log Workout, Log Health Sample), which are stable even when Apple moves things around on screen.
 * - Bring weigh-ins in ("Health to Heft"): the Shortcut that copies the last 30 days of Weight + Body Fat
 *   Percentage as text for Measurements → Paste from Health (lib/healthImport.ts), how to use it and troubleshooting.
 * - Automatic sync from Hume: the same Shortcut also posts that text to the private heft-inbox repo (lib/healthInbox.ts),
 *   run by a Shortcuts automation when the Hume app closes; Heft picks it up with a GitHub key kept in the installed
 *   app's storage (and in the Shortcut's Authorization header). A Safari tab can't save it (inSafariTab). The key is
 *   never shown in full (maskKey) and never logged.
 * `?to=weigh-ins` scrolls to the second part (the Measurements card links there), `?to=auto` to the automatic sync
 * (Settings links there).
 */

/** GitHub's new fine-grained key page with the name, a year's expiry, the owner and Issues: Read and write filled in. */
const NEW_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Heft%20inbox&description=Hume%20weigh-ins%20for%20Heft' +
  `&target_name=${INBOX.owner}&expires_in=366&issues=write`;
/** The list of fine-grained keys (to edit or delete one). */
const TOKENS_URL = 'https://github.com/settings/personal-access-tokens';
/** Anchors `?to=` may scroll to. */
const JUMP_TARGETS = ['weigh-ins', 'auto'];

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`, 'success');
  } catch {
    toast(`Type it in: ${text}`, 'info', 4000);
  }
}

function CopyChip({ text, what }: { text: string; what?: string }) {
  return (
    <button
      type="button"
      aria-label={`Copy ${text}`}
      onClick={() => void copy(text, what ?? `"${text}"`)}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-soft px-2.5 align-middle text-[14px] font-semibold text-accent active:brightness-110"
    >
      {text}
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-fg">{children}</strong>;

function Step({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3 rounded-2xl bg-surface p-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[14px] font-bold text-on-accent tabular-nums">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-semibold">{title}</div>
        <div className="mt-1.5 space-y-2 text-[14px] leading-relaxed text-muted">{children}</div>
      </div>
    </li>
  );
}

function KeyRow({ field, keyName, extra }: { field: string; keyName: string; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-2 px-3 py-2">
      <span className="min-w-[72px] font-semibold text-fg">{field}</span>
      <span>Dictionary → key</span>
      <CopyChip text={keyName} />
      {extra}
    </div>
  );
}

/** A blue variable bubble, like the ones in the Shortcuts editor. */
const Var = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center rounded-md bg-accent px-1.5 py-0.5 align-middle font-sans text-[12px] leading-none font-semibold text-on-accent">
    {children}
  </span>
);

/** What goes after each template line's colon (same order as HEALTH_TEMPLATE_LINES). */
const TEMPLATE_VARS: ({ variable: string; from: string } | null)[] = [
  null,
  { variable: 'Health Samples', from: 'from step 2 (Weight)' },
  { variable: 'Start Date', from: 'step 2’s Health Samples → Start Date, ISO 8601' },
  { variable: 'Health Samples', from: 'from step 3 (Body Fat)' },
  { variable: 'Start Date', from: 'step 3’s Health Samples → Start Date, ISO 8601' },
];

function TemplateBlock() {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="space-y-2 font-mono text-[13px] text-fg">
        {HEALTH_TEMPLATE_LINES.map((line, i) => {
          const v = TEMPLATE_VARS[i];
          return (
            <div key={line} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="whitespace-pre">{line.trimEnd()}</span>
              {v ? (
                <>
                  <Var>{v.variable}</Var>
                  <span className="font-sans text-[12px] text-muted">{v.from}</span>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <Button
        variant="soft"
        block
        className="mt-3"
        icon={<Copy className="h-4 w-4" />}
        onClick={() => void copy(healthTemplateText(), 'the template')}
      >
        Copy template
      </Button>
    </div>
  );
}

/** Section anchor that clears the sticky top bar when scrolled to. */
function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} style={{ scrollMarginTop: 'calc(env(safe-area-inset-top) + 52px)' }}>
      {children}
    </div>
  );
}

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/** A long value (a URL) that wraps, with a full-width Copy button under it. */
function CopyBlock({ text, what, label }: { text: string; what: string; label: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="font-mono text-[13px] leading-snug break-all text-fg">{text}</div>
      <Button variant="soft" block className="mt-3" icon={<Copy className="h-4 w-4" />} onClick={() => void copy(text, what)}>
        {label}
      </Button>
    </div>
  );
}

/** One "name → value" line in the Get Contents of URL setup. */
function SettingRow({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-2 px-3 py-2">
      <span className="min-w-[72px] font-semibold text-fg">{name}</span>
      {children}
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="inline-flex min-h-10 max-w-full items-center gap-1.5 text-[15px] font-semibold text-accent active:opacity-60"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      <ExternalLink className="h-4 w-4 shrink-0" />
    </a>
  );
}

// ---------------------------------------------------------------- automatic sync: the GitHub key

/** What Test says for each answer (testInboxToken). */
const TEST_RESULT: Partial<Record<InboxState, { ok: boolean; text: string }>> = {
  ok: { ok: true, text: `Connected to your ${INBOX.repo}` },
  token_rejected: { ok: false, text: 'GitHub rejected this key' },
  not_found: { ok: false, text: `This key can't see ${INBOX.repo}: check Repository access` },
  no_permission: { ok: false, text: "This key can't write Issues: set Issues to Read and write (step 1)" },
  offline: { ok: false, text: 'No connection' },
};
const TEST_FALLBACK = { ok: false, text: "GitHub didn't answer. Try again in a minute." };

/**
 * What Remove asks: removing the key only stops Heft reading. The automation keeps posting to the inbox (and nothing
 * clears it any more), and the key keeps working in the Shortcut and on GitHub.
 */
export const REMOVE_KEY_MESSAGE =
  `Heft stops checking ${INBOX.repo} on this phone. Your iPhone keeps sending weigh-ins there each time Hume closes ` +
  'until you remove the Hume Health automation in Shortcuts (step 4). The key keeps working until you delete it on ' +
  'GitHub (Settings → Developer settings → Personal access tokens). Weigh-ins already in Heft stay, and Paste from ' +
  'Health keeps working.';

/** Fine-grained keys start with github_pat_, classic ones with ghp_ (a loose check: saving is still allowed). */
const looksLikeGithubKey = (v: string) => /^(github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}$/.test(v);

/** How the sync is doing (useInboxStatus): one line, or null when there is nothing to say yet. */
function statusLine(status: InboxStatus): { text: string; tone: 'muted' | 'warn' } | null {
  const when = (ms: number) => format(ms, 'MMM d, h:mm a');
  switch (status.state) {
    case 'checking':
      return { text: 'Checking for weigh-ins…', tone: 'muted' };
    case 'token_rejected':
      return { text: 'GitHub rejected this key. Make a new one (step 1) and paste it here and in the Shortcut.', tone: 'warn' };
    case 'not_found':
      return { text: `This key can't see ${INBOX.repo}. Check its Repository access (step 1).`, tone: 'warn' };
    case 'no_permission':
      return { text: `This key can't write to ${INBOX.repo}'s Issues. Set Issues to Read and write (step 1).`, tone: 'warn' };
    case 'offline':
      return { text: 'No connection the last time Heft checked.', tone: 'muted' };
    case 'error':
    case 'unreadable':
      return { text: status.message || "The last check didn't work.", tone: 'warn' };
    default: {
      const parts: string[] = [];
      if (status.checkedAt != null) parts.push(`Last checked ${when(status.checkedAt)}`);
      // When the Shortcut last reached GitHub: "Checked just now" alone looks the same whether it posted or not.
      if (status.lastPostAt != null) parts.push(`iPhone last sent ${when(status.lastPostAt)}`);
      if (status.lastImport) {
        const n = status.lastImport.added + status.lastImport.updated;
        parts.push(`${n} ${n === 1 ? 'weigh-in' : 'weigh-ins'} came in ${when(status.lastImport.at)}`);
      }
      // A check that worked can still carry a note (e.g. the key can read the inbox but not clear it).
      if (status.message) return { text: [...parts, status.message].join(' · '), tone: 'warn' };
      return parts.length ? { text: parts.join(' · '), tone: 'muted' } : null;
    }
  }
}

/**
 * Paste / test / remove the GitHub key (lib/healthInbox.ts keeps it in this browser's localStorage only). Outside
 * any <form> and a password field, so iOS offers no autofill or "save password"; a saved key only shows masked.
 */
function InboxKeyField() {
  const status = useInboxStatus();
  const [saved, setSaved] = useState<string | null>(() => getInboxToken());
  const [draft, setDraft] = useState('');
  // A test (and its answer) belongs to the key it tested: shown only while that key is the saved one.
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  // The key can change elsewhere (Settings → Delete all data, another tab): re-read it when the status says so.
  useEffect(() => setSaved(getInboxToken()), [status.configured]);

  const trimmed = draft.trim();
  const runTest = async (key: string) => {
    setTesting(key);
    let r: { ok: boolean; text: string };
    try {
      r = TEST_RESULT[await testInboxToken(key)] ?? TEST_FALLBACK;
    } catch {
      r = TEST_FALLBACK;
    }
    setTesting((k) => (k === key ? null : k));
    setResult({ key, ...r });
  };
  const save = () => {
    if (!trimmed) return;
    if (isAnthropicSecret(trimmed)) {
      toast("That's your Claude key. Paste the GitHub key here.", 'error');
      return;
    }
    // A Safari tab has its own storage: it would take the weigh-ins into its own copy of Heft, away from the app.
    if (inSafariTab()) {
      toast('Open Heft from your Home Screen and paste the key there.', 'info');
      return;
    }
    setInboxToken(trimmed);
    const stored = getInboxToken();
    if (!stored) {
      toast("Couldn't save the key on this phone", 'error');
      return;
    }
    setDraft('');
    setSaved(stored);
    toast('Key saved on this phone', 'success');
    void runTest(stored); // check it right away
  };
  const remove = async () => {
    const ok = await confirm({
      title: 'Remove the GitHub key?',
      message: REMOVE_KEY_MESSAGE,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    clearInboxToken();
    setSaved(getInboxToken());
    toast('Key removed from Heft');
  };

  const shown = result && result.key === saved ? result : null;
  const isTesting = testing != null && testing === saved;
  // A failed Test says it all; after a good one, a later warning (e.g. the inbox can't be read) still shows under it.
  const line = saved && status.configured && !(shown && !shown.ok) ? statusLine(status) : null;
  return (
    <div className="space-y-2.5 pt-0.5" data-key-state={saved ? 'saved' : 'none'}>
      {saved ? (
        <div className="flex min-w-0 items-center gap-2 text-[15px] text-fg">
          <KeyRound className="h-4 w-4 shrink-0 text-success" />
          <span className="shrink-0">Saved key</span>
          <span className="min-w-0 truncate font-mono text-muted">{maskKey(saved)}</span>
        </div>
      ) : null}
      <TextField
        type="password"
        name="github-key"
        aria-label="GitHub key"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        value={draft}
        placeholder={saved ? 'Paste a new key to replace it' : 'github_pat_…'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
        }}
        className="font-mono"
      />
      {trimmed && !looksLikeGithubKey(cleanToken(trimmed)) ? (
        <p className="text-[13px] leading-snug text-warn">
          This doesn't look like a GitHub key (they start with github_pat_). You can still save it.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!trimmed} onClick={save}>
          Save
        </Button>
        {saved ? (
          <>
            <Button variant="secondary" disabled={isTesting} onClick={() => void runTest(saved)}>
              {isTesting ? <Spinner className="h-4 w-4" /> : null}
              Test
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              Remove
            </Button>
          </>
        ) : null}
      </div>
      {shown ? (
        <p role="status" className={cx('text-[14px] leading-snug', shown.ok ? 'text-success' : 'text-danger')}>
          {shown.text}
        </p>
      ) : null}
      {line ? <p className={cx('text-[13px] leading-snug tabular-nums', line.tone === 'warn' ? 'text-warn' : 'text-muted')}>{line.text}</p> : null}
    </div>
  );
}

/** Copies "Bearer <key>" for the Shortcut's Authorization header without ever showing the key. */
function CopyAuthorization() {
  const copyHeader = async () => {
    const key = getInboxToken();
    if (!key) {
      toast('Save your key in step 2 first', 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(`Bearer ${key}`);
      toast('Copied. Paste it as the Authorization value.', 'success');
    } catch {
      // Never fall back to showing the key.
      toast("Couldn't copy. Type Bearer, a space, then paste your key.", 'error', 4000);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copyHeader()}
      className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-accent-soft px-3 align-middle text-[14px] font-semibold text-accent active:brightness-110"
    >
      Copy “Bearer” + your key
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

export function AppleHealthPage() {
  // Read here (not useSettings) so the page knows when the row has loaded: undefined while loading, null = defaults.
  const settingsRow = useLiveQuery(() => db.settings.get('settings').then((s) => s ?? null), []);
  const settings = { ...DEFAULT_SETTINGS, ...settingsRow };
  const location = useLocation();
  const [params] = useSearchParams();
  // undefined while loading, null when there are no workouts yet.
  const latest = useLiveQuery(() => db.workouts.orderBy('startedAt').last().then((w) => w ?? null), []);
  const onApple = isAppleMobile();
  const safariTab = inSafariTab();
  // The newest Apple Health weigh-in Heft holds; older data only has the time of the last saved import.
  const newestFromHealth = settings.healthImportedThrough ?? null;
  const lastImportAt = settings.healthImportedAt ?? null;

  const jumpTo = params.get('to');
  const jumped = useRef(false);
  useEffect(() => {
    // Only once everything above the anchor has loaded: the "Test it" card appears when the settings and the last
    // workout are in, and iOS Safari has no scroll anchoring to keep the position when it does.
    if (!jumpTo || !JUMP_TARGETS.includes(jumpTo) || jumped.current || settingsRow === undefined || latest === undefined) return;
    jumped.current = true;
    document.getElementById(jumpTo)?.scrollIntoView({ block: 'start' });
  }, [jumpTo, settingsRow, latest]);

  const sendLatest = async () => {
    if (!latest) return;
    if (
      latest.healthSentAt &&
      !(await confirm({
        title: 'Send again?',
        message: 'Your last workout was already sent to Apple Health. Sending it again adds a second copy there.',
        confirmLabel: 'Send Again',
      }))
    )
      return;
    await sendWorkoutToHealth(latest);
  };

  return (
    <Page tabBar>
      {/* Opened cold (e.g. after switching back from the Shortcuts app) there is no in-app history. */}
      <TopBar title="Apple Health" back={location.key === 'default' ? '/settings' : true} />

      <div className="mx-4 mt-4 rounded-2xl bg-surface p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <Heart className="h-6 w-6" fill="currentColor" />
          </span>
          <div className="text-[19px] leading-tight font-bold">Heft and Apple Health</div>
        </div>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          Heft is a web app, so your iPhone doesn't let it talk to Health directly. Shortcuts do it instead: you build
          each one once (a few minutes), then it's one tap.
        </p>
        <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-muted">
          <li className="flex gap-2.5">
            <ArrowUpFromLine className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              <B>Send workouts to Health.</B> A finished workout shows up in the Health and Fitness apps and counts toward
              your Move ring.
            </span>
          </li>
          <li className="flex gap-2.5">
            <ArrowDownToLine className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              <B>Bring weigh-ins into Heft.</B> Every weigh-in from your smart scale lands in Measurements, and calories
              and Food targets use the newest weight.
            </span>
          </li>
          <li className="flex gap-2.5">
            <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              <B>Sync from Hume on its own.</B> Close the Hume app after a weigh-in and it shows up in Heft, no tapping.
            </span>
          </li>
        </ul>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="secondary" className="px-2!" onClick={() => scrollTo('send-workouts')}>
            Send workouts
          </Button>
          <Button variant="secondary" className="px-2!" onClick={() => scrollTo('weigh-ins')}>
            Bring in weigh-ins
          </Button>
          <Button variant="secondary" className="col-span-2 px-2!" onClick={() => scrollTo('auto')}>
            Automatic sync from Hume
          </Button>
        </div>
        {!onApple ? (
          <p className="mt-3 rounded-xl bg-warn-soft px-3 py-2 text-[14px] text-fg">
            Shortcuts only exists on iPhone and iPad. Open Heft on your iPhone to set this up.
          </p>
        ) : null}
      </div>

      {/* ---------------------------------------------------------------- Heft → Health */}
      <Anchor id="send-workouts">
        <SectionHeader>Send workouts to Health</SectionHeader>
      </Anchor>
      <p className="mx-4 mb-2.5 text-[14px] leading-relaxed text-muted">
        Each send logs a <B>Traditional Strength Training</B> workout with its start time, duration and{' '}
        <B>active calories</B>. Active means what the workout burned on top of resting, like Apple Watch shows. If you
        typed calories in yourself, they're sent as you typed them.
      </p>
      <ol className="mx-4 space-y-2.5">
        <Step n={1} title="Make a new Shortcut">
          <p>
            Open the <B>Shortcuts</B> app (it comes with your iPhone) and tap <B>+</B> in the top right.
          </p>
        </Step>
        <Step n={2} title="Name it exactly">
          <p>
            Tap the name at the top → <B>Rename</B> → type it exactly like this (tap to copy):
          </p>
          <p>
            <CopyChip text={SHORTCUT_NAME} what="the name" />
          </p>
        </Step>
        <Step n={3} title={<>Add “Get Dictionary from Input”</>}>
          <p>
            Tap <B>Search Actions</B>, type <B>Dictionary</B> and tap <B>Get Dictionary from Input</B>.
          </p>
          <p>
            It should read <B>Get dictionary from Shortcut Input</B>. If the blue word says something else, tap it and
            pick <B>Shortcut Input</B>. If you see a <B>Receive … input</B> line at the top, make sure <B>Text</B> is
            allowed.
          </p>
        </Step>
        <Step n={4} title={<>Add “Log Workout”</>}>
          <p>
            Search <B>Log Workout</B> and tap it. Set <B>Type</B> to <B>Traditional Strength Training</B>. Tap{' '}
            <B>Show More</B> if you don't see every field, then fill them in like this:
          </p>
          <p>
            For each field: tap it, pick the <B>Dictionary</B> variable from the bar above the keyboard (or{' '}
            <B>Select Variable</B>), tap the blue <B>Dictionary</B> bubble, and type the key into{' '}
            <B>Get Value for Key</B>.
          </p>
          <div className="space-y-1.5">
            <KeyRow field="Date" keyName="start" />
            <KeyRow field="Duration" keyName="minutes" extra={<span>· unit <B>min</B></span>} />
            <KeyRow field="Calories" keyName="kcal" extra={<span>· unit <B>kcal</B></span>} />
          </div>
          <p>
            Set <B>Distance</B> to <B>0</B> (any unit). Left blank, the Shortcut can fail without logging anything.
          </p>
        </Step>
        <Step n={5} title={<>Add “Log Health Sample” (Move ring)</>}>
          <p>
            Search <B>Log Health Sample</B> and tap it. Set <B>Type</B> to <B>Active Energy</B>, then:
          </p>
          <div className="space-y-1.5">
            <KeyRow field="Value" keyName="kcal" extra={<span>· unit <B>kcal</B></span>} />
            <KeyRow field="Date" keyName="start" />
          </div>
          <p>
            Workouts logged by Shortcuts don't always count toward the Move ring on their own; this step makes sure they
            do. (After your first send, see “Calories counted twice?” below.)
          </p>
        </Step>
        <Step n={6} title="Tap Done">
          <p>
            The first time it runs, your iPhone asks to let Shortcuts write to Health. Tap <B>Turn On All</B> (or at
            least <B>Workouts</B>, <B>Active Energy</B> and <B>Walking + Running Distance</B>), then <B>Allow</B>.
          </p>
        </Step>
      </ol>

      <details className="mx-4 mt-2.5 rounded-2xl bg-surface p-4 text-[14px] leading-relaxed text-muted">
        <summary className="cursor-pointer font-semibold text-fg">No “key” option when you tap Dictionary?</summary>
        <p className="mt-2">
          Add a <B>Get Dictionary Value</B> action for each key instead (Get <B>Value</B> for <CopyChip text="start" />{' '}
          in <B>Dictionary</B>, and the same for <CopyChip text="minutes" /> and <CopyChip text="kcal" />), placed right
          after step 3. Then use those results in the Log Workout and Log Health Sample fields.
        </p>
      </details>

      <SectionHeader>Turn it on</SectionHeader>
      <ListGroup>
        <ListRow
          icon={<Heart className="h-5 w-5" />}
          title="Show Send button"
          subtitle="On each workout's summary"
          right={<Toggle checked={settings.appleHealth} onChange={(v) => void updateSettings({ appleHealth: v })} label="Send to Apple Health button" />}
        />
      </ListGroup>

      {settings.appleHealth && onApple && latest !== undefined ? (
        <div className="mx-4 mt-3 rounded-2xl bg-surface p-4">
          <div className="text-[16px] font-semibold">Test it</div>
          {latest ? (
            <>
              <p className="mt-1 text-[14px] leading-relaxed text-muted">
                Sends your last workout, <B>{latest.name}</B> ({formatDuration(latest.durationSec)},{' '}
                {activeCalories(latest)} active kcal). Then open <B>Health</B> → <B>Browse</B> → <B>Activity</B> →{' '}
                <B>Workouts</B> to see it.
              </p>
              <Button block className="mt-3" onClick={() => void sendLatest()}>
                Send Last Workout
              </Button>
            </>
          ) : (
            <p className="mt-1 text-[14px] text-muted">Finish a workout first, then send it from its summary.</p>
          )}
        </div>
      ) : null}

      <SectionHeader>If sending is off</SectionHeader>
      <div className="mx-4 space-y-2.5 rounded-2xl bg-surface p-4 text-[14px] leading-relaxed text-muted">
        <p>
          <B>“Shortcut not found”</B>: the name must be exactly <B>{SHORTCUT_NAME}</B>, with the same capitals and spaces.
        </p>
        <p>
          <B>Nothing shows up in Health</B>: check that Distance is set to 0 (step 4). Then open iPhone{' '}
          <B>Settings → Apps → Health → Data Access & Devices → Shortcuts</B> (or in the Health app: your picture →{' '}
          <B>Apps</B> → <B>Shortcuts</B>) and turn on Workouts, Active Energy and Walking + Running Distance.
        </p>
        <p>
          <B>Move ring didn't change</B>: check that step 5 (Log Health Sample → Active Energy) is in the Shortcut.
        </p>
        <p>
          <B>Calories counted twice?</B> After your first send, open Health → <B>Active Energy</B> → <B>Show All Data</B>.
          If that workout's calories are listed twice, delete step 5 from the Shortcut — on your iPhone version Log
          Workout already counts them.
        </p>
        <p>
          <B>Workout lands at the wrong time</B>: in Log Workout's Date field, use the key <CopyChip text="startISO" />{' '}
          instead of start.
        </p>
        <p>
          <B>Sent twice</B>: every tap adds a copy. Delete extras in Health → Browse → Activity → Workouts.
        </p>
        <p>
          After it runs you stay in the Shortcuts app. Swipe back to Heft or open it from your home screen.
        </p>
      </div>

      {/* ---------------------------------------------------------------- Health → Heft */}
      <Anchor id="weigh-ins">
        <SectionHeader>Bring weigh-ins into Heft</SectionHeader>
      </Anchor>
      <p className="mx-4 mb-2.5 text-[14px] leading-relaxed text-muted">
        A second Shortcut reads the last 30 days of <B>Weight</B> and <B>Body Fat Percentage</B> from Apple Health (your
        Hume scale writes both there) and copies them as text. Heft then pastes them into Measurements, or picks them up
        on its own once automatic sync is set up (below).
        {newestFromHealth != null ? (
          <>
            {' '}
            Newest weigh-in from Health: <B>{format(newestFromHealth, 'MMM d, h:mm a')}</B>.
          </>
        ) : lastImportAt != null ? (
          <>
            {' '}
            Last import: <B>{format(lastImportAt, 'MMM d, h:mm a')}</B>.
          </>
        ) : null}
      </p>
      <ol className="mx-4 space-y-2.5">
        <Step n={1} title="Make a new Shortcut, named exactly">
          <p>
            In <B>Shortcuts</B>, tap <B>+</B>, then tap the name at the top → <B>Rename</B> → type it exactly like this
            (tap to copy):
          </p>
          <p>
            <CopyChip text={HEALTH_IMPORT_SHORTCUT} what="the name" />
          </p>
        </Step>
        <Step n={2} title={<>Add “Find Health Samples” for Weight</>}>
          <p>
            Tap <B>Search Actions</B>, type <B>Find Health</B> and tap <B>Find Health Samples</B>. In its{' '}
            <B>Type is …</B> filter, tap the blue sample type after <B>Type is</B> (not the word Type) and choose{' '}
            <B>Weight</B>.
          </p>
          <p>
            Set its <B>Start Date</B> filter to <B>is in the last 30 days</B>: if it shows one (like <B>is today</B>), tap
            that condition and change it; if not, tap <B>Add Filter</B> and pick <B>Start Date</B>.
          </p>
          <p>
            Tap <B>Show More</B>, then set <B>Sort by</B> to <B>Start Date</B> and <B>Order</B> to <B>Latest First</B>,
            and turn <B>Limit</B> off. It now finds every weigh-in from the last 30 days.
          </p>
        </Step>
        <Step n={3} title={<>Add another one for Body Fat</>}>
          <p>
            Add a second <B>Find Health Samples</B> under the first, then check its first line. If it reads{' '}
            <B>Filter Health Samples where…</B>, tap the blue <B>Health Samples</B> and choose <B>Clear</B>, so it reads{' '}
            <B>Find All Health Samples where…</B>. Otherwise it only searches the weight you just found, and body fat
            always comes back empty.
          </p>
          <p>
            Then set it up like step 2, but choose <B>Body Fat Percentage</B> after <B>Type is</B>. Same Start Date (is in
            the last 30 days), Sort by and Order, and Limit off.
          </p>
        </Step>
        <Step n={4} title={<>Add “Text” with this template</>}>
          <p>
            Search <B>Text</B> and add it. Copy the template below and paste it into the Text box.
          </p>
          <TemplateBlock />
          <p>
            Then put the cursor at the end of each line and insert a variable (each blue bubble above): tap{' '}
            <B>Select Variable</B> in the bar above the keyboard and tap that step's <B>Health Samples</B>. For a date
            line, insert the same Health Samples, then tap the bubble you inserted and choose <B>Start Date</B>.
          </p>
          <p>
            Tap each <B>Start Date</B> bubble once more and set <B>Date Format</B> to <B>ISO 8601</B>, with{' '}
            <B>Include ISO 8601 Time</B> turned on. That date reads the same in every region; without the time, the
            weigh-in lands at midnight.
          </p>
          <p>
            Insert the <B>Health Samples</B> bubble itself, not its Value: the bubble includes the unit (lb or kg), so
            Heft reads the weight right. Keep the first line, <B>{HEALTH_MARKER}</B>, as it is.
          </p>
          <p>
            Each bubble holds every weigh-in it found, one per line. Heft pairs each weight with its date by their order,
            so use the same step's Health Samples for a value and its date.
          </p>
        </Step>
        <Step n={5} title={<>Add “Copy to Clipboard”</>}>
          <p>
            Search <B>Copy to Clipboard</B> and add it under the Text step. It copies the Text.
          </p>
        </Step>
        <Step n={6} title="Tap Done and run it once">
          <p>
            Tap the Shortcut to run it. The first time, your iPhone asks to let Shortcuts <B>read</B> your Health data:
            turn on <B>Weight</B> and <B>Body Fat Percentage</B>, then <B>Allow</B>.
          </p>
          <p>
            That's the Shortcut for pasting by hand. To have weigh-ins arrive on their own, add one more step: see{' '}
            <B>Automatic sync from Hume</B> below.
          </p>
        </Step>
      </ol>

      <SectionHeader>Use it by hand</SectionHeader>
      <ol className="mx-4 space-y-2.5">
        <Step n={1} title="Weigh in">
          <p>
            Step on your Hume scale, then give it a few minutes to reach Apple Health. Hume says it can take 30 to 60
            minutes.
          </p>
        </Step>
        <Step n={2} title="Get from Health">
          <p>
            In Heft, tap <B>Get from Health</B> on Today's Body card (or in <B>Progress</B> → <B>Measurements</B>, where
            it stays once automatic sync is on). The Shortcut runs and copies your weigh-in.
          </p>
        </Step>
        <Step n={3} title="Come back and paste">
          <p>
            Swipe back to Heft, tap <B>Paste from Health</B> (and the small <B>Paste</B> bubble if your iPhone shows
            one), check the preview and tap <B>Save</B>.
          </p>
        </Step>
      </ol>
      <p className="mx-4 mt-2.5 text-[13px] leading-relaxed text-muted">
        Every weigh-in comes in as its own entry. If the scale got one wrong, tap your weight on Today and tap the trash
        can next to that reading (or Measurements, tap it, Delete): it won't come back. Entries you edit stay as you
        left them. Today and your trend use the day's last weigh-in, unless you typed one in yourself that day.
        Calories and Food targets use that same weigh-in, unless you typed a newer body weight in Settings.
      </p>

      {/* ---------------------------------------------------------------- Hume → Heft, automatic */}
      <Anchor id="auto">
        <SectionHeader>Automatic sync from Hume</SectionHeader>
      </Anchor>
      <p className="mx-4 mb-2.5 text-[14px] leading-relaxed text-muted">
        Once this is set up, closing the Hume app sends your weigh-ins to Heft by itself. Your iPhone runs the{' '}
        <B>{HEALTH_IMPORT_SHORTCUT}</B> Shortcut, which drops them in <B>{INBOX.repo}</B>, a private GitHub repo of yours;
        Heft picks them up from there. Build that Shortcut first (Bring weigh-ins into Heft, above).
      </p>
      <ol className="mx-4 space-y-2.5">
        <Step n={1} title="Make a GitHub key">
          <p>
            <ExtLink href={NEW_TOKEN_URL}>Open GitHub's new-key page (most of it comes filled in)</ExtLink>
          </p>
          <div className="space-y-1.5">
            <SettingRow name="Token name">
              <CopyChip text="Heft inbox" what="the name" />
              <span>is filled in</span>
            </SettingRow>
            <SettingRow name="Expiration">
              <span>
                Already set to <B>a year</B> (or pick <B>No expiration</B>)
              </span>
            </SettingRow>
            <SettingRow name="Repository access">
              <span>
                <B>Only select repositories</B> → <B>{INBOX.repo}</B>
              </span>
            </SettingRow>
            <SettingRow name="Permissions">
              <span>
                <B>Issues: Read and write</B> is already listed. If it is missing or says Read-only:{' '}
                <B>Add permissions</B> → <B>Issues</B>, then set <B>Access</B> to <B>Read and write</B>
              </span>
            </SettingRow>
          </div>
          <p>
            Leave everything else as it is. Tap <B>Generate token</B>, then copy the key. GitHub shows it only once.
          </p>
        </Step>
        <Step n={2} title="Paste the key into Heft">
          <InboxKeyField />
          {safariTab ? (
            <p className="rounded-xl bg-warn-soft px-3 py-2 text-fg">
              You're in Safari: a key can't be saved here. Open Heft from your Home Screen and paste it in the app.
            </p>
          ) : null}
          <p>
            Test should say <B>Connected to your {INBOX.repo}</B>. When the key expires, make a new one the same way and
            paste it here and in the Shortcut (step 3).
          </p>
        </Step>
        <Step n={3} title={<>Update the “{HEALTH_IMPORT_SHORTCUT}” Shortcut</>}>
          <p>
            In <B>Shortcuts</B>, tap <B>•••</B> on <B>{HEALTH_IMPORT_SHORTCUT}</B>. In <B>both</B> Find Health Samples
            actions, set <B>Start Date</B> to <B>is in the last 30 days</B> and turn <B>Limit</B> off. Keep Sort by Start
            Date, Latest First.
          </p>
          <p>
            Copy to Clipboard would replace whatever you copied every time Hume closes. To make it copy only when Heft
            asks: search <B>If</B> and add it right above Copy to Clipboard. Tap <B>Input</B> → <B>Shortcut Input</B>,
            tap it again and set its type to <B>Text</B>, set the condition to <B>is</B> and type{' '}
            <CopyChip text={HEALTH_PASTE_INPUT} />. Drag Copy to Clipboard inside the If, above <B>Otherwise</B>, and tap
            its blue word to choose the <Var>Text</Var> variable. Get from Health in Heft still copies, so Paste from
            Health keeps working.
          </p>
          <p>
            Search <B>Get Contents of URL</B> and add it at the very end, under <B>End If</B>. Tap <B>URL</B> and paste
            this:
          </p>
          <CopyBlock text={INBOX_COMMENTS_URL} what="the URL" label="Copy URL" />
          <p>
            Tap the arrow next to it (<B>Show More</B>) and fill it in:
          </p>
          <div className="space-y-1.5">
            <SettingRow name="Method">
              <B>POST</B>
            </SettingRow>
            <SettingRow name="Headers">
              <span>
                <B>Add new header</B> twice:
              </span>
            </SettingRow>
            <SettingRow name="Authorization">
              <span>
                <B>Bearer</B>, a space, then your key
              </span>
              <CopyAuthorization />
            </SettingRow>
            <SettingRow name="Accept">
              <CopyChip text="application/vnd.github+json" what="the Accept value" />
            </SettingRow>
            <SettingRow name="Request Body">
              <span>
                <B>JSON</B> → <B>Add new field</B> → <B>Text</B>
              </span>
            </SettingRow>
            <SettingRow name="Key">
              <CopyChip text="body" />
            </SettingRow>
            <SettingRow name="Text">
              <span>
                the <Var>Text</Var> variable (Select Variable, then tap the Text step)
              </span>
            </SettingRow>
          </div>
          <p>
            Tap <B>Done</B>, then run <B>{HEALTH_IMPORT_SHORTCUT}</B> once by hand. If it asks to connect to{' '}
            <B>api.github.com</B>, tap <B>Always Allow</B>; otherwise the automation stops at that question.
          </p>
        </Step>
        <Step n={4} title="Run it when the Hume app closes">
          <p>
            <B>iOS 27</B>: in <B>Shortcuts</B>, open <B>{HEALTH_IMPORT_SHORTCUT}</B>, tap <B>Edit</B>, then{' '}
            <B>Automation</B> → <B>App</B>. Choose <B>Hume Health</B>, tick <B>Is Closed</B> and untick{' '}
            <B>Is Opened</B>. Then tap <B>Edit</B> → <B>ⓘ</B> → <B>Privacy</B> and turn on{' '}
            <B>Allow Running When Locked</B> so it runs without asking.
          </p>
          <p>
            <B>iOS 26 or earlier</B>: in <B>Shortcuts</B>, tap the <B>Automation</B> tab → <B>+</B> (or{' '}
            <B>New Automation</B>) → <B>App</B>. Choose <B>Hume Health</B>, tick <B>Is Closed</B> and untick{' '}
            <B>Is Opened</B>. Pick <B>Run Immediately</B>, turn <B>Notify When Run</B> off, tap <B>Next</B> and choose{' '}
            <B>{HEALTH_IMPORT_SHORTCUT}</B>.
          </p>
          <p>
            Not sure? <B>Settings</B> → <B>General</B> → <B>About</B> → <B>iOS Version</B>.
          </p>
        </Step>
        <Step n={5} title="Try it">
          <p>
            Step on the scale and open Hume until the reading shows. Close Hume (go to the Home Screen or switch apps),
            then open Heft: the weigh-in appears on Today within a few seconds.
          </p>
          <p>
            Not there? Tap <B>Check now</B> on the Body card: its line should say <B>iPhone sent just now</B>. If it
            does but no weigh-in came in, Hume hasn't passed it to Apple Health yet; it comes in the next time you close
            Hume. If it doesn't, the Shortcut didn't reach GitHub: see <B>If weigh-ins don't come in</B>.
          </p>
        </Step>
      </ol>
      <div className="mx-4 mt-2.5 space-y-2 text-[13px] leading-relaxed text-muted">
        <p>
          Heft brings in every weigh-in from the last 30 days that it doesn't have yet. A weigh-in you delete in Heft
          doesn't come back.
        </p>
        <p>
          The key can only touch {INBOX.repo}. It is kept in the installed Heft app (from your Home Screen), whose storage
          is separate from Safari's, and in the {HEALTH_IMPORT_SHORTCUT} Shortcut, so don't share that Shortcut. Save it
          only in Heft on your iPhone: any other browser that has it takes your weigh-ins into its own copy of Heft.
        </p>
        <p>
          To turn automatic sync off, remove the automation (step 4), remove the key here, and{' '}
          <ExtLink href={TOKENS_URL}>delete it on GitHub</ExtLink>.
        </p>
      </div>

      <SectionHeader>If weigh-ins don't come in</SectionHeader>
      <div className="mx-4 space-y-2.5 rounded-2xl bg-surface p-4 text-[14px] leading-relaxed text-muted">
        <p>
          <B>“That isn't Heft health data”</B>: the clipboard doesn't hold the Shortcut's text. Check that the Text step
          starts with the <B>{HEALTH_MARKER}</B> line and that Copy to Clipboard copies the Text (inside the If, once
          automatic sync is set up).
        </p>
        <p>
          <B>“Nothing new”</B>: every weigh-in in it is already in Heft, or you deleted it in Heft (a deleted weigh-in
          doesn't come back). Otherwise weigh in again, or wait until the new one reaches Apple Health.
        </p>
        <p>
          <B>“No weigh-ins in it”</B>: the Find Health Samples steps found nothing. Check the type after Type is (Weight,
          Body Fat Percentage) and the Start Date filter (is in the last 30 days, or none). Then open the Health app →
          your picture → <B>Privacy</B> → <B>Apps</B> → <B>Shortcuts</B> and turn on Weight and Body Fat Percentage.
        </p>
        <p>
          <B>“No weigh-ins in what the Shortcut sent”</B>: the automatic sync got the Shortcut's text, but its Find
          Health Samples steps found nothing. Same fixes as No weigh-ins in it, above: the type after Type is, the Start
          Date filter (is in the last 30 days), and Shortcuts' access to Weight and Body Fat Percentage in the Health app.
        </p>
        <p>
          <B>“Body fat came back empty”</B>: the second Find Health Samples reads Filter Health Samples. Tap its blue
          Health Samples → <B>Clear</B> so it reads Find All Health Samples (step 3).
        </p>
        <p>
          <B>“Can't read what the Shortcut sent”</B> (on Today) or <B>“Heft couldn't read the Shortcut's text”</B>
          (after a paste): a bubble in the Text step is wrong. Each date line needs the Health Samples’{' '}
          <B>Start Date</B> (not the sample itself), with Date Format <B>ISO 8601</B> and Include ISO 8601 Time on (step
          4).
        </p>
        <p>
          <B>Hume isn't syncing</B>: in the Health app → your picture → <B>Privacy</B> → <B>Apps</B> →{' '}
          <B>Hume Health</B>, turn on Weight and Body Fat Percentage. Also check the Hume app → <B>Me</B> →{' '}
          <B>Connected Apps</B> → <B>Apple Health</B> is on.
        </p>
        <p>
          <B>The weight is way off</B> (like 184 kg): in the Text step, the weight line must use the Health Samples
          bubble itself, which carries its unit, not its Value.
        </p>
        <p>
          <B>“Shortcut not found”</B>: the name must be exactly <B>{HEALTH_IMPORT_SHORTCUT}</B>.
        </p>
        <p>
          <B>Paste doesn't work</B>: tap the small <B>Paste</B> bubble your iPhone shows. If Heft still can't read the
          clipboard, it opens a box instead: long-press it, tap Paste, then Use pasted text.
        </p>
        <p>
          <B>Nothing arrives after closing Hume</B>: on iOS 27, open {HEALTH_IMPORT_SHORTCUT} → <B>Edit</B> and check
          that it starts with the Hume Health, Is Closed trigger and that <B>Allow Running When Locked</B> is on (Edit →
          ⓘ → Privacy). On iOS 26 or earlier, check that Shortcuts → <B>Automation</B> has the Hume Health automation,
          set to Run Immediately and running {HEALTH_IMPORT_SHORTCUT}.
        </p>
        <p>
          Then add <B>Show Result</B> under Get Contents of URL and run the Shortcut by hand. An answer with{' '}
          <B>html_url</B> means it worked. <B>Bad credentials</B> = the Authorization header. <B>Not Found</B> = the
          URL, or the key's repository. <B>Resource not accessible by personal access token</B> = Issues isn't Read and
          write. <B>Problems parsing JSON</B> or <B>Validation Failed</B> = Request Body must be JSON with the key body.
          Remove Show Result afterwards, or the automation stops to show it.
        </p>
        <p>
          <B>“Bad credentials”</B> in Show Result, or Test says GitHub rejected this key: it expired or was copied
          wrong. Make a new one (automatic sync, step 1) and paste it in Heft and in the Shortcut's Authorization
          header. If Test in Heft says Connected, only the Shortcut's header is wrong: copy it again (step 3).
        </p>
        <p>
          <B>“Resource not accessible by personal access token”</B> in Show Result, or Test says the key can't write
          Issues: on GitHub open the key (<B>Fine-grained tokens</B> → <B>Heft inbox</B> → <B>Edit</B>), set{' '}
          <B>Issues</B> to <B>Read and write</B>, save. No new key needed.
        </p>
        <p>
          <B>“Not Found”</B> in Show Result, or Test says the key can't see {INBOX.repo}: the key's Repository access
          must include {INBOX.repo}, with Issues set to Read and write. In the Shortcut, also check the URL (step 3).
        </p>
      </div>
    </Page>
  );
}
