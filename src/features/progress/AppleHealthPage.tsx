import { type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Copy, Heart } from 'lucide-react';
import { db } from '../../db';
import { Button, confirm, ListGroup, ListRow, Page, SectionHeader, Toggle, TopBar, toast } from '../../components/ui';
import { activeCalories, isAppleMobile, sendWorkoutToHealth, SHORTCUT_NAME } from '../../lib/appleHealth';
import { DEFAULT_SETTINGS, updateSettings } from '../../lib/settings';
import { formatDuration } from '../../lib/units';

/*
 * Settings → Apple Health: the "Heft to Health" Shortcut that sends finished workouts to Health. How to build the
 * Shortcut, the switch that turns on the "Send to Apple Health" button, a test send and troubleshooting. Written for
 * the Shortcuts app's action names (Get Dictionary from Input, Log Workout, Log Health Sample), which are stable even
 * when Apple moves things around on screen. (Weigh-ins are typed in: Today → Body or Progress → Measurements.)
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

export function AppleHealthPage() {
  // Read here (not useSettings) so the page knows when the row has loaded: undefined while loading, null = defaults.
  const settingsRow = useLiveQuery(() => db.settings.get('settings').then((s) => s ?? null), []);
  const settings = { ...DEFAULT_SETTINGS, ...settingsRow };
  const location = useLocation();
  // undefined while loading, null when there are no workouts yet.
  const latest = useLiveQuery(() => db.workouts.orderBy('startedAt').last().then((w) => w ?? null), []);
  const onApple = isAppleMobile();

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
          Heft is a web app, so your iPhone doesn't let it talk to Health directly. A Shortcut does it instead: you
          build it once (a few minutes), then sending a finished workout is one tap. It shows up in the Health and
          Fitness apps and counts toward your Move ring.
        </p>
        {!onApple ? (
          <p className="mt-3 rounded-xl bg-warn-soft px-3 py-2 text-[14px] text-fg">
            Shortcuts only exists on iPhone and iPad. Open Heft on your iPhone to set this up.
          </p>
        ) : null}
      </div>

      {/* ---------------------------------------------------------------- Heft → Health */}
      <SectionHeader>Send workouts to Health</SectionHeader>
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

    </Page>
  );
}
