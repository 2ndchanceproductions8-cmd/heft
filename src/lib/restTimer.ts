import { useEffect, useState } from 'react';
import { toast } from '../components/ui/dialogs';
import { getSettings } from './settings';
import { useWorkoutStore } from './workoutStore';

/*
 * Rest timer runtime. The timer itself is just `active.rest.endsAt` (a timestamp) in the workout store, so
 * it keeps counting while the phone is locked. This module turns that timestamp into a ticking countdown
 * and fires the "rest complete" alert (double beep / vibration / toast) exactly once per rest, even when
 * several components watch it or the app comes back from the background after the end.
 */

// ------------------------------------------------------------------ audio

type AudioCtor = typeof AudioContext;
let audioCtx: AudioContext | null = null;

function getAudioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Ask the browser to MIX our beeps with other audio instead of taking over the audio session. Without this,
 * iOS Safari pauses the user's music (Spotify, Apple Music...) as soon as the page plays a sound.
 * Audio Session API: Safari 16.4+; elsewhere a no-op.
 */
function preferMixing(): void {
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== 'ambient') session.type = 'ambient';
  } catch {
    /* unsupported */
  }
}

/** The shared AudioContext (created lazily; recreated if the browser closed it). */
function ensureContext(): AudioContext | null {
  const Ctor = getAudioCtor();
  if (!Ctor) return null;
  preferMixing();
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new Ctor();
  // 'suspended' (autoplay policy) or iOS 'interrupted' (after a call / backgrounding).
  if (audioCtx.state !== 'running') void audioCtx.resume().catch(() => undefined);
  return audioCtx;
}

/**
 * Create/resume the shared AudioContext. Browsers (iOS Safari especially) only allow this inside a user
 * gesture, so call it from tap handlers (e.g. ticking a set) — the beep at the end of the rest then works.
 */
export function unlockAudio(): void {
  try {
    const wasRunning = audioCtx?.state === 'running';
    const ctx = ensureContext();
    if (!ctx || wasRunning) return;
    // A silent 1-sample buffer fully unlocks output on iOS.
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* audio not available */
  }
}

/** Short double beep. Silently does nothing when audio is unavailable or still locked. */
export function playRestBeep(): void {
  try {
    const ctx = ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02;
    for (const offset of [0, 0.22]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const start = t0 + offset;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.17);
    }
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ completion

/** endsAt of the last rest we alerted for — shared by every watcher so the alert fires once. */
let lastFiredEndsAt: number | null = null;
/** Beyond this, an expired rest found on return/mount is cleared with a toast only (no beep/buzz). */
const LATE_ALERT_MS = 10 * 60 * 1000;

async function completeRest(endsAt: number): Promise<void> {
  if (lastFiredEndsAt === endsAt) return;
  lastFiredEndsAt = endsAt;
  const store = useWorkoutStore.getState();
  if (store.active?.rest?.endsAt === endsAt) store.stopRest();
  const late = Date.now() - endsAt > LATE_ALERT_MS;
  try {
    const s = await getSettings();
    if (!late) {
      if (s.restTimerSound) playRestBeep();
      if (s.restTimerVibrate) navigator.vibrate?.([200, 100, 200]);
    }
  } catch {
    /* settings unavailable — still toast */
  }
  toast('Rest complete', 'info');
}

function checkRest(): void {
  const rest = useWorkoutStore.getState().active?.rest;
  if (rest && Date.now() >= rest.endsAt) void completeRest(rest.endsAt);
}

/**
 * Watches the rest timer of the active workout and returns the remaining seconds (null when no rest is
 * running). Fires the completion alert when it reaches 0 — also right after the app returns from the
 * background past the end. Mount it wherever the user can be while a workout runs (logger, mini bar).
 */
export function useRestTimer(): { remainingSec: number | null; totalSec: number; endsAt: number | null } {
  const rest = useWorkoutStore((s) => s.active?.rest ?? null);
  const endsAt = rest?.endsAt ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (endsAt == null) return;
    const tick = () => {
      setNow(Date.now());
      checkRest();
    };
    tick();
    const t = window.setInterval(tick, 250);
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [endsAt]);

  if (!rest || endsAt == null) return { remainingSec: null, totalSec: 0, endsAt: null };
  // `now` only drives re-renders: it can be minutes old on the first render of a NEW rest (the effect that
  // refreshes it runs after paint), which would flash e.g. "6:30" for a 1:30 rest. Read the clock instead.
  const remainingSec = Math.max(0, Math.ceil((endsAt - Math.max(now, Date.now())) / 1000));
  return { remainingSec, totalSec: rest.totalSec, endsAt };
}
