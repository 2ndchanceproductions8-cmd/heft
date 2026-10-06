import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { format } from 'date-fns';
import { ArrowDownToLine, ArrowUpFromLine, Copy, Heart } from 'lucide-react';
import { db } from '../../db';
import { Button, confirm, ListGroup, ListRow, Page, SectionHeader, Toggle, TopBar, toast } from '../../components/ui';
import { activeCalories, isAppleMobile, sendWorkoutToHealth, SHORTCUT_NAME } from '../../lib/appleHealth';
import { HEALTH_IMPORT_SHORTCUT, HEALTH_MARKER, HEALTH_TEMPLATE_LINES, healthTemplateText } from '../../lib/healthImport';
import { DEFAULT_SETTINGS, updateSettings } from '../../lib/settings';
import { formatDuration } from '../../lib/units';

/*
 * Settings → Apple Health: both Shortcut bridges.
 * - Send workouts ("Heft to Health"): how to build the Shortcut, the switch that turns on the "Send to Apple Health"
 *   button, a test send and troubleshooting. Written for the Shortcuts app's action names (Get Dictionary from
 *   Input, Log Workout, Log Health Sample), which are stable even when Apple moves things around on screen.
 * - Bring weigh-ins in ("Health to Heft"): the Shortcut that copies the latest Weight + Body Fat Percentage as
 *   text for Measurements → Paste from Health (lib/healthImport.ts), how to use it and troubleshooting.
 * `?to=weigh-ins` scrolls to the second part (the Measurements card links there).
 */

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

export function AppleHealthPage() {
  // Read here (not useSettings) so the page knows when the row has loaded: undefined while loading, null = defaults.
  const settingsRow = useLiveQuery(() => db.settings.get('settings').then((s) => s ?? null), []);
  const settings = { ...DEFAULT_SETTINGS, ...settingsRow };
  const location = useLocation();
  const [params] = useSearchParams();
  // undefined while loading, null when there are no workouts yet.
  const latest = useLiveQuery(() => db.workouts.orderBy('startedAt').last().then((w) => w ?? null), []);
  const onApple = isAppleMobile();
  const lastImport = settings.healthImportedThrough ?? settings.healthImportedAt ?? null;

  const jumpTo = params.get('to');
  const jumped = useRef(false);
  useEffect(() => {
    // Only once everything above the anchor has loaded: the "Test it" card appears when the settings and the last
    // workout are in, and iOS Safari has no scroll anchoring to keep the position when it does.
    if (jumpTo !== 'weigh-ins' || jumped.current || settingsRow === undefined || latest === undefined) return;
    jumped.current = true;
    document.getElementById('weigh-ins')?.scrollIntoView({ block: 'start' });
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
              <B>Bring weigh-ins into Heft.</B> Your smart scale's latest weight and body fat land in Measurements, and
              calories and Food targets use the new weight.
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
        A second Shortcut reads your latest <B>Weight</B> and <B>Body Fat Percentage</B> from Apple Health (your Hume
        scale writes both there) and copies them as text. Heft then pastes them into Measurements.
        {lastImport != null ? (
          <>
            {' '}
            Last import: <B>{format(lastImport, 'MMM d, h:mm a')}</B>.
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
            If it also has a <B>Start Date</B> filter (like <B>is today</B>), tap that condition and set it to{' '}
            <B>is in the last 30 days</B>, or remove that filter. Otherwise it only finds weigh-ins inside that window.
          </p>
          <p>
            Tap <B>Show More</B>, then set <B>Sort by</B> to <B>Start Date</B>, <B>Order</B> to <B>Latest First</B>, turn
            on <B>Limit</B>, and make it <B>Get 1 Health Sample</B>.
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
            Then set it up like step 2, but choose <B>Body Fat Percentage</B> after <B>Type is</B>. Same Start Date fix,
            Sort by, Order and Limit (Get 1 Health Sample).
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
        </Step>
      </ol>

      <SectionHeader>How to use it</SectionHeader>
      <ol className="mx-4 space-y-2.5">
        <Step n={1} title="Weigh in">
          <p>
            Step on your Hume scale, then give it a few minutes to reach Apple Health. Hume says it can take 30 to 60
            minutes.
          </p>
        </Step>
        <Step n={2} title="Get from Health">
          <p>
            In Heft, open <B>Progress</B> → <B>Measurements</B> and tap <B>Get from Health</B>. The Shortcut runs and
            copies your weigh-in.
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
        Heft keeps the first weigh-in of each day. A weigh-in you typed in yourself that day wins, and entries you edit
        or delete in Heft stay that way. Calories and Food targets use your newest weigh-in, unless you typed a newer
        body weight in Settings.
      </p>

      <SectionHeader>If weigh-ins don't come in</SectionHeader>
      <div className="mx-4 space-y-2.5 rounded-2xl bg-surface p-4 text-[14px] leading-relaxed text-muted">
        <p>
          <B>“That isn't Heft health data”</B>: the clipboard doesn't hold the Shortcut's text. Check that the Text step
          starts with the <B>{HEALTH_MARKER}</B> line and that Copy to Clipboard comes right after it.
        </p>
        <p>
          <B>“Nothing new”</B>: that weigh-in is already in Heft. Heft keeps the first weigh-in of each day, so a second
          one the same day doesn't come in (edit that day's entry if you want it). Otherwise weigh in again, or wait
          until the new one reaches Apple Health.
        </p>
        <p>
          <B>“No weigh-ins in it”</B>: the Find Health Samples steps found nothing. Check the type after Type is (Weight,
          Body Fat Percentage) and the Start Date filter (is in the last 30 days, or none). Then open the Health app →
          your picture → <B>Privacy</B> → <B>Apps</B> → <B>Shortcuts</B> and turn on Weight and Body Fat Percentage.
        </p>
        <p>
          <B>“Body fat came back empty”</B>: the second Find Health Samples reads Filter Health Samples. Tap its blue
          Health Samples → <B>Clear</B> so it reads Find All Health Samples (step 3).
        </p>
        <p>
          <B>“Heft couldn't read the Shortcut's text”</B>: a bubble in the Text step is wrong. Each date line needs the
          Health Samples’ <B>Start Date</B> (not the sample itself), with Date Format <B>ISO 8601</B> and Include ISO
          8601 Time on (step 4).
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
      </div>
    </Page>
  );
}
