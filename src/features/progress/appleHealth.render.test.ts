// Server-render test for Settings → Apple Health: the "How to use it" steps and the automatic Hume sync guide
// (no DOM library).
import 'fake-indexeddb/auto';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxStatus } from '../../lib/healthInbox';
import { AppleHealthPage, REMOVE_KEY_MESSAGE } from './AppleHealthPage';

// The inbox module keeps the key in localStorage (none in node): drive the key field's states from here instead. The
// fake key is a short obvious fake (src/lib/secrets.guard.test.ts flags anything that looks real).
const inbox = vi.hoisted(() => ({
  token: null as string | null,
  status: null as Partial<InboxStatus> | null,
}));
vi.mock('../../lib/healthInbox', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/healthInbox')>();
  return {
    ...real,
    getInboxToken: () => inbox.token,
    useInboxStatus: (): InboxStatus => ({
      configured: inbox.token != null,
      state: inbox.token ? 'idle' : 'off',
      checkedAt: null,
      lastImport: null,
      lastPostAt: null,
      ...inbox.status,
    }),
  };
});

const FAKE_KEY = 'github_pat_TEST';

/** Visible text, a space at every tag boundary (a row's label and its chip are separate elements). */
const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,:;)])/g, '$1')
    .replace(/\( /g, '(');

/** The key field's markup: from its own tag to the paragraph after it. */
const keyCardOf = (html: string) =>
  textOf(html.slice(html.lastIndexOf('<', html.indexOf('data-key-state')), html.indexOf('Test should say')));

const render = (path = '/settings/apple-health') => renderToString(h(MemoryRouter, { initialEntries: [path] }, h(AppleHealthPage)));

afterEach(() => {
  inbox.token = null;
  inbox.status = null;
});

describe('Apple Health page', () => {
  it("step 2 points at Today's Body card first, Measurements second (where it stays under automatic sync)", () => {
    const out = textOf(render());
    expect(out).toContain(
      "In Heft, tap Get from Health on Today's Body card (or in Progress → Measurements, where it stays once automatic sync is on). The Shortcut runs",
    );
    expect(out).not.toContain('open Progress → Measurements and tap Get from Health');
  });

  it('the manual guide uses the last 30 days with no limit, and never claims Heft keeps only the first weigh-in', () => {
    const out = textOf(render());
    expect(out).toContain('turn Limit off. It now finds every weigh-in from the last 30 days.');
    expect(out).toContain('Same Start Date (is in the last 30 days), Sort by and Order, and Limit off.');
    expect(out).not.toMatch(/Get 1 Health Sample/);
    expect(out).not.toMatch(/first weigh-in/i);
    expect(out).toContain(
      "If the scale got one wrong, tap your weight on Today and tap the trash can next to that reading (or Measurements, tap it, Delete): it won't come back.",
    );
    expect(out).toContain('Calories and Food targets use that same weigh-in, unless you typed a newer body weight in Settings.');
    expect(out).not.toContain('Calories and Food targets use your newest weigh-in');
  });
});

describe('Automatic sync from Hume', () => {
  it('has the ?to=auto anchor and a jump button', () => {
    const html = render('/settings/apple-health?to=auto');
    expect(html).toMatch(/<div id="auto"[^>]*>(?:<[^>]+>)*Automatic sync from Hume/);
    expect(html).toContain('id="weigh-ins"'); // ?to=weigh-ins still works
    expect(textOf(html)).toContain('Automatic sync from Hume');
  });

  it('renders every step in order, with the inbox URL and the token link', () => {
    const html = render();
    const out = textOf(html);
    const auto = out.slice(out.indexOf('Once this is set up, closing the Hume app'));
    const steps = [
      '1 Make a GitHub key',
      '2 Paste the key into Heft',
      '3 Update the “Health to Heft” Shortcut',
      '4 Run it when the Hume app closes',
      '5 Try it',
    ];
    let at = 0;
    for (const s of steps) {
      const i = auto.indexOf(s, at);
      expect(i, s).toBeGreaterThanOrEqual(at);
      at = i;
    }
    // a. the key
    // GitHub's new-key page with the name, a year, the owner and Issues: Read and write filled in (renderToString
    // writes & as &amp;).
    expect(html).toContain('href="https://github.com/settings/personal-access-tokens/new?name=Heft%20inbox');
    expect(html).toContain('&amp;target_name=2ndchanceproductions8-cmd&amp;expires_in=366&amp;issues=write"');
    expect(html).toContain('target="_blank"');
    expect(auto).toContain("Open GitHub's new-key page (most of it comes filled in)");
    expect(auto).toContain('Token name Heft inbox is filled in');
    expect(auto).toContain('Expiration Already set to a year (or pick No expiration)');
    expect(auto).toContain('Only select repositories → heft-inbox');
    // GitHub's "Add permissions" list (Aug 2025) adds Issues as Read-only: never the old "Repository permissions" list.
    expect(auto).toContain(
      'Permissions Issues: Read and write is already listed. If it is missing or says Read-only: Add permissions → Issues, then set Access to Read and write',
    );
    expect(auto).not.toContain('Repository permissions →');
    expect(auto).toContain('Tap Generate token, then copy the key.');
    // c. the Shortcut
    expect(auto).toContain('In both Find Health Samples actions, set Start Date to is in the last 30 days and turn Limit off.');
    // Copy to Clipboard runs only when Heft asks (Get from Health passes "paste"), not on every Hume close.
    expect(auto).not.toContain('Keep the Text and Copy to Clipboard steps');
    expect(auto).toContain('Copy to Clipboard would replace whatever you copied every time Hume closes.');
    expect(auto).toContain(
      'Tap Input → Shortcut Input, tap it again and set its type to Text, set the condition to is and type paste. Drag Copy to Clipboard inside the If, above Otherwise',
    );
    expect(auto).toContain('Get from Health in Heft still copies, so Paste from Health keeps working.');
    expect(auto).toContain('Search Get Contents of URL and add it at the very end, under End If.');
    expect(html).toContain('https://api.github.com/repos/2ndchanceproductions8-cmd/heft-inbox/issues/1/comments');
    expect(auto).toContain('Copy URL');
    expect(auto).toContain('Method POST');
    expect(auto).toContain('Authorization Bearer, a space, then your key');
    expect(auto).toContain('Accept application/vnd.github+json');
    expect(auto).toContain('Request Body JSON → Add new field → Text');
    expect(auto).toContain('Key body');
    expect(auto).toContain('the Text variable');
    expect(auto).toContain('tap Always Allow');
    // d. the automation: iOS 27 (the automation is set up inside the Shortcut) first, then the old Automation tab
    const ios27 =
      'iOS 27: in Shortcuts, open Health to Heft, tap Edit, then Automation → App. Choose Hume Health, tick Is Closed and untick Is Opened.';
    const ios26 = 'iOS 26 or earlier: in Shortcuts, tap the Automation tab → + (or New Automation) → App.';
    expect(auto).toContain(ios27);
    expect(auto).toContain('Then tap Edit → ⓘ → Privacy and turn on Allow Running When Locked so it runs without asking.');
    expect(auto).toContain(ios26);
    expect(auto).toContain('Pick Run Immediately, turn Notify When Run off, tap Next and choose Health to Heft.');
    expect(auto.indexOf(ios27)).toBeLessThan(auto.indexOf(ios26));
    // e. try it + the note
    expect(auto).toContain('open Hume until the reading shows. Close Hume');
    expect(auto).toContain('the weigh-in appears on Today within a few seconds.');
    expect(auto).toContain('Not there? Tap Check now on the Body card: its line should say iPhone sent just now.');
    expect(auto).toContain("If it doesn't, the Shortcut didn't reach GitHub: see If weigh-ins don't come in.");
    expect(auto).not.toContain('Not there? Hume may not have passed it');
    expect(auto).toContain("Heft brings in every weigh-in from the last 30 days that it doesn't have yet.");
    expect(auto).toContain("A weigh-in you delete in Heft doesn't come back.");
    // Where the key really is, and how to stop the phone sending (removing it from Heft alone doesn't).
    expect(auto).toContain('The key can only touch heft-inbox. It is kept in the installed Heft app');
    expect(auto).toContain('storage is separate from Safari');
    expect(auto).toContain("and in the Health to Heft Shortcut, so don't share that Shortcut.");
    expect(auto).toContain('any other browser that has it takes your weigh-ins into its own copy of Heft.');
    expect(auto).not.toContain('lives only on this phone');
    expect(auto).toContain('To turn automatic sync off, remove the automation (step 4), remove the key here, and delete it on GitHub.');
    expect(html).toContain('href="https://github.com/settings/personal-access-tokens"');
    // The Safari-tab warning only shows on an iPhone (inSafariTab is false under Node).
    expect(auto).not.toContain("You're in Safari");
  });

  it('troubleshooting: the iOS 27 automation, Show Result, and a 403 is a permission, not an expired key', () => {
    const out = textOf(render());
    const help = out.slice(out.indexOf("If weigh-ins don't come in"));
    expect(help).toContain(
      'Nothing arrives after closing Hume: on iOS 27, open Health to Heft → Edit and check that it starts with the Hume Health, Is Closed trigger',
    );
    expect(help).toContain('Allow Running When Locked is on (Edit → ⓘ → Privacy).');
    expect(help).toContain('On iOS 26 or earlier, check that Shortcuts → Automation has the Hume Health automation');
    expect(help).toContain(
      'Then add Show Result under Get Contents of URL and run the Shortcut by hand. An answer with html_url means it worked.',
    );
    expect(help).toContain("Resource not accessible by personal access token = Issues isn't Read and write.");
    expect(help).toContain('Problems parsing JSON or Validation Failed = Request Body must be JSON with the key body.');
    expect(help).toContain('Remove Show Result afterwards, or the automation stops to show it.');
    expect(help).not.toContain('if Get Contents of URL shows an error');
    expect(help).toContain('“Bad credentials” in Show Result, or Test says GitHub rejected this key: it expired or was copied wrong.');
    expect(help).toContain(
      "“Resource not accessible by personal access token” in Show Result, or Test says the key can't write Issues: on GitHub open the key (Fine-grained tokens → Heft inbox → Edit), set Issues to Read and write, save. No new key needed.",
    );
    expect(help).toContain("“Not Found” in Show Result, or Test says the key can't see heft-inbox");
    expect(help).toContain("“Can't read what the Shortcut sent” (on Today) or “Heft couldn't read the Shortcut's text” (after a paste)");
    expect(help).toContain("“No weigh-ins in what the Shortcut sent”: the automatic sync got the Shortcut's text");
    expect(help).toContain('Copy to Clipboard copies the Text (inside the If, once automatic sync is set up)');
  });

  it('no key saved: a password field and Save, no Test / Remove', () => {
    const html = render();
    expect(html).toContain('data-key-state="none"');
    const field = /<input[^>]*aria-label="GitHub key"[^>]*>/.exec(html)?.[0] ?? '';
    expect(field).toContain('type="password"');
    expect(field).toContain('autoComplete="off"');
    expect(field).toContain('placeholder="github_pat_…"');
    const keyCard = keyCardOf(html);
    expect(keyCard).toContain('Save');
    expect(keyCard).not.toContain('Saved key');
    expect(keyCard).not.toContain('Remove');
    expect(keyCard).not.toMatch(/\bTest\b/);
  });

  it('key saved: shown masked with Test and Remove, never in full', () => {
    inbox.token = FAKE_KEY;
    const html = render();
    expect(html).toContain('data-key-state="saved"');
    const keyCard = keyCardOf(html);
    expect(keyCard).toContain('Saved key …TEST');
    expect(keyCard).toContain('Test');
    expect(keyCard).toContain('Remove');
    expect(html).toContain('placeholder="Paste a new key to replace it"');
    expect(html).not.toContain(FAKE_KEY);
    expect(html).not.toContain('Bearer github_pat');
  });

  it('key saved: the last check shows under it; a rejected key says so', () => {
    inbox.token = FAKE_KEY;
    inbox.status = { state: 'ok', checkedAt: new Date(2026, 9, 6, 7, 5).getTime(), lastImport: { at: new Date(2026, 9, 6, 7, 5).getTime(), added: 2, updated: 0 } };
    expect(textOf(render())).toContain('Last checked Oct 6, 7:05 AM · 2 weigh-ins came in Oct 6, 7:05 AM');
    inbox.status = { state: 'token_rejected' };
    expect(textOf(render())).toContain('GitHub rejected this key. Make a new one (step 1)');
    inbox.status = { state: 'ok', checkedAt: new Date(2026, 9, 6, 7, 5).getTime(), message: "The token can't clear the inbox" };
    expect(textOf(render())).toContain("Last checked Oct 6, 7:05 AM · The token can't clear the inbox");
    expect(textOf(render())).not.toContain('iPhone last sent'); // lastPostAt null
  });

  it('key saved: says when the iPhone last reached GitHub, so a check that found nothing new still shows the Shortcut ran', () => {
    inbox.token = FAKE_KEY;
    inbox.status = { state: 'ok', checkedAt: new Date(2026, 9, 6, 7, 5).getTime(), lastPostAt: new Date(2026, 9, 6, 7, 4).getTime() };
    expect(keyCardOf(render())).toContain('Last checked Oct 6, 7:05 AM · iPhone last sent Oct 6, 7:04 AM');
  });

  it('key saved: a key without Issues write and an unreadable post each say so (not "rejected")', () => {
    inbox.token = FAKE_KEY;
    inbox.status = { state: 'no_permission' };
    const card = keyCardOf(render());
    expect(card).toContain("This key can't write to heft-inbox's Issues. Set Issues to Read and write (step 1).");
    expect(card).not.toContain('rejected');
    inbox.status = { state: 'unreadable', message: "Can't read what the Shortcut sent" };
    expect(keyCardOf(render())).toContain("Can't read what the Shortcut sent");
  });

  it("Remove says the iPhone keeps sending until the automation goes, and the key works until it's deleted on GitHub", () => {
    expect(REMOVE_KEY_MESSAGE).toContain('Heft stops checking heft-inbox on this phone.');
    expect(REMOVE_KEY_MESSAGE).toContain(
      'Your iPhone keeps sending weigh-ins there each time Hume closes until you remove the Hume Health automation in Shortcuts (step 4).',
    );
    expect(REMOVE_KEY_MESSAGE).toContain('The key keeps working until you delete it on GitHub');
    expect(REMOVE_KEY_MESSAGE).not.toContain('stops on this phone');
  });
});
