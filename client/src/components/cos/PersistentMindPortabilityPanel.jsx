import { useId, useState } from 'react';
import { Brain, Database, Download, Lock, ShieldCheck, Sparkles } from 'lucide-react';
import { downloadBlob } from '../../lib/downloadBlob.js';
import * as api from '../../services/api';
import Banner from '../ui/Banner';

// Mirrors `MIND_BUNDLE_PASSPHRASE_MIN_CHARS` in server/lib/mindBundleCrypto.js.
// Checked here so the user is told before a round trip; the server is still the
// authority and refuses a short passphrase on its own.
export const MIND_BUNDLE_PASSPHRASE_MIN_CHARS = 12;

// Protected memories quote private conversation, so that scope is opt-in —
// the decision is the epic's (#7620), not this panel's to soften.
const EXPORT_SCOPES = [
  {
    scope: 'profile',
    icon: Brain,
    label: 'Profile',
    detail: 'Chosen name, identity and operating instructions, playbook, and the pinned model policy. No install ids, paths, or capability grants.',
    defaultOn: true,
  },
  {
    scope: 'avatar',
    icon: Sparkles,
    label: 'Appearance',
    detail: 'The avatar style this Mind wears. A style id from the bundled vocabulary — no image is stored on this install today.',
    defaultOn: true,
  },
  {
    scope: 'memories',
    icon: Database,
    label: 'Protected memories',
    detail: 'Only core-identity and important memories, as type + text + date. These quote private conversation, so they are off unless you ask for them.',
    defaultOn: false,
  },
];

const defaultScopes = () => new Set(EXPORT_SCOPES.filter(({ defaultOn }) => defaultOn).map(({ scope }) => scope));

/**
 * The server names the file the same way. Deriving it here too keeps the
 * download on the plain `responseType: 'text'` path — reading the server's
 * Content-Disposition would mean dropping to a raw fetch for a filename both
 * sides can compute from the clock.
 */
export const mindBundleFilename = (now = new Date()) =>
  `portos-mind-${now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')}.portos-mind`;

/**
 * Export the Persistent Mind as one passphrase-sealed file (#7621).
 *
 * Nothing leaves the machine on its own: the bytes are produced by an explicit
 * click, handed to the browser's download, and never sent to a peer. The
 * passphrase lives in component state for the length of the click and is never
 * logged or persisted.
 */
export default function PersistentMindPortabilityPanel() {
  const idPrefix = useId();
  const [selected, setSelected] = useState(defaultScopes);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [exported, setExported] = useState(null);

  const toggle = (scope, enabled) => {
    setSelected((current) => {
      const next = new Set(current);
      if (enabled) next.add(scope);
      else next.delete(scope);
      return next;
    });
    setExported(null);
  };

  const tooShort = passphrase.length > 0 && passphrase.length < MIND_BUNDLE_PASSPHRASE_MIN_CHARS;
  const mismatch = confirmPassphrase.length > 0 && confirmPassphrase !== passphrase;
  const ready = selected.size > 0
    && passphrase.length >= MIND_BUNDLE_PASSPHRASE_MIN_CHARS
    && confirmPassphrase === passphrase;

  const exportBundle = async () => {
    if (pending || !ready) return;
    setPending(true);
    setError(null);
    setExported(null);
    const scopes = EXPORT_SCOPES.map(({ scope }) => scope).filter((scope) => selected.has(scope));
    await api.exportPersistentMindBundle({ scopes, passphrase })
      .then((bundle) => {
        const filename = mindBundleFilename();
        downloadBlob(bundle, filename);
        setExported({ filename, scopes });
        // The secret has done its job; do not leave it sitting in the form.
        setPassphrase('');
        setConfirmPassphrase('');
      })
      .catch((nextError) => setError(nextError?.message || 'Could not export the Mind bundle'))
      .finally(() => setPending(false));
  };

  return (
    <div className="space-y-4">
      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-portability-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="mind-portability-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text">
              <Download size={17} aria-hidden="true" /> Export this Mind
            </h3>
            <p className="mt-1 max-w-3xl text-xs text-port-text-muted">Seal the parts of this Mind you choose into one encrypted file you keep. Open it on another PortOS install to carry the same Mind there.</p>
          </div>
          <span className="rounded-full border border-port-border px-2.5 py-1 text-xs text-port-text-muted">Download only — never sent to a peer</span>
        </div>

        <div className="mt-4 rounded border border-port-success/40 bg-port-success/5 p-3 text-xs text-port-text">
          <p className="flex items-center gap-2 font-medium"><ShieldCheck size={16} aria-hidden="true" /> The file carries meaning, not this machine</p>
          <p className="mt-1 text-port-text-muted">No database ids, embeddings, file paths, hostnames, peer records, credentials, or conversation history go in. Capability grants stay here too — importing a Mind never widens what it may do. The file is sealed with a key derived from your passphrase, so this install&apos;s keys are not needed to open it.</p>
        </div>

        <fieldset className="mt-4 grid gap-3 lg:grid-cols-3">
          <legend className="sr-only">Mind bundle scopes</legend>
          {EXPORT_SCOPES.map(({ scope, icon: Icon, label, detail }) => {
            const id = `${idPrefix}-${scope}`;
            return (
              <div key={scope} className={`rounded border p-3 transition-colors ${selected.has(scope) ? 'border-port-accent bg-port-accent/5' : 'border-port-border bg-port-bg/30'}`}>
                <span className="flex items-start gap-3">
                  <input id={id} type="checkbox" checked={selected.has(scope)} disabled={pending} onChange={(event) => toggle(scope, event.target.checked)} className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-50" />
                  <span>
                    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm font-medium text-port-text"><Icon size={15} aria-hidden="true" /> {label}</label>
                    <span className="mt-1 block text-xs text-port-text-muted">{detail}</span>
                  </span>
                </span>
              </div>
            );
          })}
        </fieldset>

        {selected.has('memories') && (
          <p className="mt-3 rounded border border-port-warning/40 bg-port-warning/10 p-3 text-xs text-port-text">
            Protected memories quote things you told this Mind in private. Keep the file somewhere you would keep a password vault, and use a passphrase you do not reuse.
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${idPrefix}-passphrase`} className="flex items-center gap-2 text-xs font-medium text-port-text"><Lock size={14} aria-hidden="true" /> Passphrase</label>
            <input
              id={`${idPrefix}-passphrase`}
              type="password"
              value={passphrase}
              disabled={pending}
              autoComplete="new-password"
              onChange={(event) => { setPassphrase(event.target.value); setExported(null); }}
              className="mt-2 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-port-text-muted">At least {MIND_BUNDLE_PASSPHRASE_MIN_CHARS} characters. There is no recovery — lose it and the bundle cannot be opened.</p>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-passphrase-confirm`} className="flex items-center gap-2 text-xs font-medium text-port-text"><Lock size={14} aria-hidden="true" /> Confirm passphrase</label>
            <input
              id={`${idPrefix}-passphrase-confirm`}
              type="password"
              value={confirmPassphrase}
              disabled={pending}
              autoComplete="new-password"
              onChange={(event) => { setConfirmPassphrase(event.target.value); setExported(null); }}
              className="mt-2 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text disabled:opacity-50"
            />
            {tooShort && <p role="alert" className="mt-1 text-xs text-port-warning">Passphrase is shorter than {MIND_BUNDLE_PASSPHRASE_MIN_CHARS} characters.</p>}
            {mismatch && <p role="alert" className="mt-1 text-xs text-port-warning">The two passphrases do not match.</p>}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-port-text-muted">{selected.size === 0 ? 'Select at least one scope to export.' : 'Everything you selected is sealed, or the export fails — a bundle never silently omits a scope.'}</p>
          <button
            type="button"
            onClick={exportBundle}
            disabled={pending || !ready}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded bg-port-accent px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={16} className={pending ? 'animate-pulse' : ''} aria-hidden="true" /> {pending ? 'Sealing…' : 'Download sealed bundle'}
          </button>
        </div>
      </section>

      {error && (
        <Banner tone="error" title="Export refused">
          {error}
        </Banner>
      )}

      {exported && (
        <Banner tone="success" title="Bundle downloaded">
          Saved {exported.filename} with {exported.scopes.join(', ')}. Store it alongside your other secrets — the passphrase is the only way back in.
        </Banner>
      )}
    </div>
  );
}
