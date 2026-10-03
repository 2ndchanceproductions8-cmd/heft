import { useEffect, useRef, useState } from 'react';
import { ExternalLink, KeyRound } from 'lucide-react';
import { Button, ListGroup, Spinner, TextField, confirm, cx, toast } from '../../../components/ui';
import { testApiKey } from '../../../lib/nutrition/foodAi';
import { FDC_DEMO_KEY, isAnthropicSecret, looksLikeAnthropicKey, maskKey, setAnthropicKey, setFdcKey } from '../../../lib/nutrition/keys';

/*
 * API keys are DEVICE-ONLY (lib/nutrition/keys.ts → localStorage): never in Dexie, never in a backup, never
 * logged, never put in a URL. The paste fields are password inputs outside any <form> (no autofill / save
 * prompts), and a saved key is only ever shown masked. A Claude key is refused in the USDA field (USDA puts
 * its key in the request URL).
 */

export const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys';
export const USDA_SIGNUP_URL = 'https://fdc.nal.usda.gov/api-key-signup.html';

function KeyInput({ value, onChange, label, placeholder, onEnter }: { value: string; onChange: (v: string) => void; label: string; placeholder: string; onEnter: () => void }) {
  return (
    <TextField
      type="password"
      name={label.toLowerCase().replace(/\W+/g, '-')}
      aria-label={label}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      enterKeyHint="done"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter();
      }}
      className="font-mono"
    />
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-1.5 text-[15px] font-semibold text-accent active:opacity-60">
      {children}
      <ExternalLink className="h-4 w-4" />
    </a>
  );
}

function SavedKey({ masked }: { masked: string }) {
  return (
    <div className="flex items-center gap-2 text-[15px]">
      <KeyRound className="h-4 w-4 shrink-0 text-success" />
      <span>Saved key</span>
      <span className="font-mono text-muted">{masked}</span>
    </div>
  );
}

/**
 * Where the Claude key lives, without overclaiming: it is in this app's storage on this phone (which other
 * pages on the same web address could read), so the advice is a separate, spend-limited key used only here.
 */
export const CLAUDE_KEY_NOTE =
  "Your key is stored in this app on this phone — never in backups or in Heft's code. Use a separate key from a spend-limited workspace used only for Heft.";

export const CLAUDE_KEY_IN_USDA = "That's your Claude key — paste it in the Claude field.";

/** Why a pasted USDA key can't be saved, or null when it can. A Claude key must never reach USDA's URL logs. */
export function usdaKeyProblem(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (isAnthropicSecret(t)) return CLAUDE_KEY_IN_USDA;
  if (t === FDC_DEMO_KEY) return "That's the shared demo key — paste your own key";
  return null;
}

/** "This month: $0.42 across 7 analyses". */
export function spendLine(spend: { costUsd: number; calls: number }): string {
  const n = spend.calls;
  return `This month: $${spend.costUsd.toFixed(2)} across ${n} ${n === 1 ? 'analysis' : 'analyses'}`;
}

export function ClaudeKeySection({ saved, spend }: { saved: string | null; spend: { costUsd: number; calls: number } | undefined }) {
  const [draft, setDraft] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  // A test result belongs to the key it tested: clear it (and drop any answer still in flight) when the
  // saved key or the draft changes.
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setResult(null);
  }, [saved, draft]);

  const trimmed = draft.trim();
  const save = () => {
    if (!trimmed) return;
    setAnthropicKey(trimmed);
    setDraft('');
    toast('Claude key saved on this phone', 'success');
  };
  const test = async () => {
    const key = trimmed || saved;
    if (!key || testing) return;
    const gen = generation.current;
    setTesting(true);
    let r: { ok: boolean; message: string };
    try {
      r = await testApiKey(key);
    } catch {
      r = { ok: false, message: "Couldn't test the key. Check your connection and try again." };
    }
    setTesting(false);
    if (gen === generation.current) setResult(r);
  };
  const forget = async () => {
    const ok = await confirm({
      title: 'Forget Claude key?',
      message: 'Photo and description logging stop working on this phone until you add a key again. Barcode scans and search keep working.',
      confirmLabel: 'Forget key',
      danger: true,
    });
    if (!ok) return;
    setAnthropicKey(null);
    toast('Claude key removed from this phone');
  };

  return (
    <ListGroup>
      <div className="space-y-3 px-4 py-3.5">
        {saved ? (
          <SavedKey masked={maskKey(saved)} />
        ) : (
          <p className="text-[14px] leading-snug text-muted">
            Add your Anthropic API key to log meals from a photo or a description. Barcode scans, search and quick add work without it.
          </p>
        )}
        <KeyInput value={draft} onChange={setDraft} label="Claude API key" placeholder={saved ? 'Paste a new key to replace it' : 'sk-ant-…'} onEnter={save} />
        {trimmed && !looksLikeAnthropicKey(trimmed) ? (
          <p className="text-[13px] leading-snug text-warn">This doesn't look like an Anthropic key (they start with sk-ant-). You can still save it.</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!trimmed} onClick={save}>
            Save
          </Button>
          <Button variant="secondary" disabled={(!trimmed && !saved) || testing} onClick={() => void test()}>
            {testing ? <Spinner className="h-4 w-4" /> : null}
            Test key
          </Button>
          {saved ? (
            <Button variant="danger" onClick={() => void forget()}>
              Forget key
            </Button>
          ) : null}
        </div>
        {result ? (
          <p role="status" className={cx('text-[14px] leading-snug', result.ok ? 'text-success' : 'text-danger')}>
            {result.message}
          </p>
        ) : null}
        <p className="text-[13px] leading-snug text-muted">{CLAUDE_KEY_NOTE}</p>
        <ExtLink href={ANTHROPIC_KEYS_URL}>Get a key at console.anthropic.com</ExtLink>
      </div>
      <div className="px-4 py-3 text-[14px] text-muted tabular-nums">{spend ? spendLine(spend) : 'This month: …'}</div>
    </ListGroup>
  );
}

export function UsdaKeySection({ saved }: { saved: string | null }) {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const problem = usdaKeyProblem(trimmed);
  const save = () => {
    if (!trimmed) return;
    if (problem) {
      toast(problem, 'error');
      return;
    }
    setFdcKey(trimmed);
    setDraft('');
    toast('USDA key saved on this phone', 'success');
  };
  const forget = async () => {
    const ok = await confirm({
      title: 'Forget USDA key?',
      message: "Lookups go back to USDA's shared demo key (about 10 an hour).",
      confirmLabel: 'Forget key',
      danger: true,
    });
    if (!ok) return;
    setFdcKey(null);
    toast('USDA key removed from this phone');
  };

  return (
    <ListGroup>
      <div className="space-y-3 px-4 py-3.5">
        {saved ? (
          <SavedKey masked={maskKey(saved)} />
        ) : (
          <p className="text-[14px] leading-snug text-muted">
            Using USDA's shared demo key — limited to about 10 lookups an hour. Add your free key for database-accurate numbers.
          </p>
        )}
        {saved && isAnthropicSecret(saved) ? (
          // Saved before this check existed. It is never sent to USDA (the demo key is used instead).
          <p role="alert" className="text-[13px] leading-snug text-danger">
            This is your Claude key, not a USDA key. It isn't sent to USDA — forget it here and paste your USDA key.
          </p>
        ) : null}
        <KeyInput value={draft} onChange={setDraft} label="USDA API key" placeholder={saved ? 'Paste a new key to replace it' : 'Your api.data.gov key'} onEnter={save} />
        {problem === CLAUDE_KEY_IN_USDA ? <p className="text-[13px] leading-snug text-danger">{CLAUDE_KEY_IN_USDA}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!trimmed} onClick={save}>
            Save
          </Button>
          {saved ? (
            <Button variant="danger" onClick={() => void forget()}>
              Forget key
            </Button>
          ) : null}
        </div>
        <ExtLink href={USDA_SIGNUP_URL}>Get a free key</ExtLink>
      </div>
    </ListGroup>
  );
}
