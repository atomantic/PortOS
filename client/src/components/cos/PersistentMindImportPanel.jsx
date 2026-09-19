import { useId, useState } from 'react';
import { Brain, Check, Database, FileUp, Lock, Sparkles, Upload } from 'lucide-react';
import {
  MIND_BUNDLE_FILE_EXTENSION,
  MIND_BUNDLE_MAX_CHARS,
  MIND_BUNDLE_PASSPHRASE_MIN_CHARS,
} from '../../lib/mindBundle.js';
import * as api from '../../services/api';
import { formatCount, formatDateTime } from '../../utils/formatters.js';
import Banner from '../ui/Banner';

// Labels and the "what this group means" copy live here because they are UI
// prose; the group IDS are contract and come off the preview response, which
// orders them by `PERSISTENT_MIND_BUNDLE_GROUPS`.
const GROUP_PRESENTATION = {
  identity: { icon: Brain, label: 'Chosen name', detail: 'The name this Mind answers to.' },
  personality: { icon: Sparkles, label: 'Personality', detail: 'Identity and operating instructions — one authored piece of text, taken whole or not at all.' },
  playbook: { icon: Sparkles, label: 'Playbook', detail: 'The operating loop this Mind runs, and any custom instructions attached to it.' },
  modelPolicy: { icon: Brain, label: 'Model policy', detail: 'Pinned provider, model, effort, and wake cadence. The destination decides whether that route exists here.' },
  avatar: { icon: Sparkles, label: 'Appearance', detail: 'The avatar style this Mind wears.' },
  memories: { icon: Database, label: 'Protected memories', detail: 'Appended as new records. Nothing you already hold is deleted, rewritten, or duplicated.' },
};

const KEEP_MINE = 'keep-mine';
const USE_IMPORTED = 'use-imported';

// `chosenName` reads as "Chosen name" rather than as a field id. The field
// names come off the wire, so the split is generic instead of a lookup table
// that would silently fall back to a camelCase id the day a group grows a field.
const fieldLabel = (key) => key
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/^./, (first) => first.toUpperCase());

/** A group value rendered for comparison. Objects read as labelled lines. */
function GroupValue({ value, empty = 'Nothing set' }) {
  if (value === null || value === undefined) return <span className="text-port-text-muted">{empty}</span>;
  if (typeof value !== 'object') return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  const rows = Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== '');
  if (rows.length === 0) return <span className="text-port-text-muted">{empty}</span>;
  return (
    <dl className="space-y-1">
      {rows.map(([key, entry]) => (
        <div key={key}>
          <dt className="text-port-text-muted">{fieldLabel(key)}</dt>
          <dd className="whitespace-pre-wrap break-words">{typeof entry === 'number' ? formatCount(entry) : String(entry)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Import a sealed Mind bundle (#7622).
 *
 * Two steps on purpose. **Open** decrypts and shows what the file carries
 * beside what this install holds — the server writes nothing for it, so opening
 * the wrong file costs nothing. **Apply** is the only write, and it takes one
 * whole-group choice per group: keep mine, or use the imported one. There is no
 * field-level merge anywhere in this flow, because half of one personality and
 * half of another is a third personality nobody authored.
 */
export default function PersistentMindImportPanel() {
  const idPrefix = useId();
  const [file, setFile] = useState(null);
  // Bumped after a successful apply to REMOUNT the file input. Clearing `file`
  // only clears the label: the <input> keeps its DOM value, so re-picking the
  // same file fires no change event and the panel looks stuck.
  const [fileInputKey, setFileInputKey] = useState(0);
  const [bundleText, setBundleText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [preview, setPreview] = useState(null);
  const [choices, setChoices] = useState({});
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [applied, setApplied] = useState(null);

  // Any new file or passphrase invalidates the open bundle: the choices below
  // describe THAT preview, and silently carrying them to another file is how a
  // confirm applies something the user never looked at.
  const resetPreview = () => {
    setPreview(null);
    setChoices({});
    setApplied(null);
    setError(null);
  };

  const pickFile = async (event) => {
    const picked = event.target.files?.[0] || null;
    resetPreview();
    setFile(picked);
    setBundleText('');
    if (!picked) return;
    // `size` is bytes and the cap is characters. A bundle is base64 + JSON, so
    // the two are equal in practice, and where they are not this errs toward
    // rejecting early — the server bound is the authority either way.
    if (picked.size > MIND_BUNDLE_MAX_CHARS) {
      setError('That file is larger than a Mind bundle can be. Check that you picked the right file.');
      return;
    }
    setBundleText(await picked.text());
  };

  const openBundle = async () => {
    if (pending || !bundleText || passphrase.length < MIND_BUNDLE_PASSPHRASE_MIN_CHARS) return;
    setPending('preview');
    setError(null);
    setApplied(null);
    await api.previewPersistentMindBundle({ bundle: bundleText, passphrase })
      .then((result) => {
        setPreview(result);
        // Default every group to "keep mine". An import must never be the
        // thing that replaces a personality the user did not re-affirm.
        setChoices(Object.fromEntries(result.groups.map(({ group }) => [group, KEEP_MINE])));
      })
      .catch((nextError) => {
        setPreview(null);
        setError(nextError?.message || 'Could not open that bundle');
      })
      .finally(() => setPending(null));
  };

  const applyBundle = async () => {
    if (pending || !preview) return;
    setPending('apply');
    setError(null);
    await api.applyPersistentMindBundle({ bundle: bundleText, passphrase, choices })
      .then((result) => {
        setApplied(result);
        setPreview(null);
        setChoices({});
        // The secret has done its job; do not leave it sitting in the form.
        setPassphrase('');
        setBundleText('');
        setFile(null);
        setFileInputKey((current) => current + 1);
      })
      .catch((nextError) => setError(nextError?.message || 'Could not apply that bundle'))
      .finally(() => setPending(null));
  };

  const taking = Object.values(choices).filter((choice) => choice === USE_IMPORTED).length;
  const canOpen = Boolean(bundleText) && passphrase.length >= MIND_BUNDLE_PASSPHRASE_MIN_CHARS;

  return (
    <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-import-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="mind-import-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text">
            <Upload size={17} aria-hidden="true" /> Open a Mind bundle
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-port-text-muted">Bring a Mind here from another PortOS install. You see exactly what the file carries beside what this install already holds, and nothing is written until you confirm.</p>
        </div>
        <span className="rounded-full border border-port-border px-2.5 py-1 text-xs text-port-text-muted">Whole groups — never a merge</span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-file`} className="flex items-center gap-2 text-xs font-medium text-port-text"><FileUp size={14} aria-hidden="true" /> Bundle file</label>
          <input
            key={fileInputKey}
            id={`${idPrefix}-file`}
            type="file"
            accept={MIND_BUNDLE_FILE_EXTENSION}
            disabled={Boolean(pending)}
            onChange={pickFile}
            className="mt-2 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text file:mr-3 file:rounded file:border-0 file:bg-port-accent/10 file:px-3 file:py-1 file:text-xs file:text-port-accent disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-port-text-muted">{file ? `Ready: ${file.name}` : `The ${MIND_BUNDLE_FILE_EXTENSION} file you exported on the other install.`}</p>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-import-passphrase`} className="flex items-center gap-2 text-xs font-medium text-port-text"><Lock size={14} aria-hidden="true" /> Bundle passphrase</label>
          <input
            id={`${idPrefix}-import-passphrase`}
            type="password"
            value={passphrase}
            disabled={Boolean(pending)}
            autoComplete="off"
            onChange={(event) => { setPassphrase(event.target.value); resetPreview(); }}
            className="mt-2 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-port-text-muted">The passphrase used when this bundle was sealed.</p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-port-text-muted">Opening a bundle only reads it — nothing on this install changes.</p>
        <button
          type="button"
          onClick={openBundle}
          disabled={Boolean(pending) || !canOpen}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded border border-port-accent px-4 text-sm font-medium text-port-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Upload size={16} className={pending === 'preview' ? 'animate-pulse' : ''} aria-hidden="true" /> {pending === 'preview' ? 'Opening…' : 'Open bundle'}
        </button>
      </div>

      {error && (
        <div className="mt-4">
          <Banner tone="error" title="Bundle refused">{error}</Banner>
        </div>
      )}

      {applied && (
        <div className="mt-4">
          <Banner tone="success" title="Bundle applied">
            {applied.applied.length > 0 ? `Used the imported ${applied.applied.join(', ')}.` : 'Nothing was changed — every group kept this install\'s value.'}
            {/* `skipped` stands on its own: importing a bundle whose memories
                you already hold adds nothing, and a bare "used the imported
                memories" would read as though records had arrived. */}
            {applied.memories.imported > 0 && ` Added ${formatCount(applied.memories.imported)} memories.`}
            {applied.memories.skipped > 0 && ` ${formatCount(applied.memories.skipped)} were already here and were skipped.`}
          </Banner>
        </div>
      )}

      {preview && (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-port-text-muted">
            Sealed {formatDateTime(preview.createdAt, 'at an unknown time')} · carries {preview.scopes.join(', ')}. Choose one side per group.
          </p>

          {preview.groups.map(({ group, identical, additive, incoming, current }) => {
            const { icon: Icon, label, detail } = GROUP_PRESENTATION[group] || { icon: Brain, label: group, detail: '' };
            const name = `${idPrefix}-choice-${group}`;
            return (
              <fieldset key={group} className="rounded border border-port-border bg-port-bg/30 p-3">
                <legend className="flex items-center gap-2 px-1 text-sm font-medium text-port-text"><Icon size={15} aria-hidden="true" /> {label}</legend>
                <p className="text-xs text-port-text-muted">{detail}</p>

                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <label htmlFor={`${name}-mine`} className={`cursor-pointer rounded border p-3 text-xs transition-colors ${choices[group] === KEEP_MINE ? 'border-port-accent bg-port-accent/5' : 'border-port-border'}`}>
                    <span className="flex items-center gap-2 font-medium text-port-text">
                      <input id={`${name}-mine`} type="radio" name={name} value={KEEP_MINE} checked={choices[group] === KEEP_MINE} disabled={Boolean(pending)} onChange={() => setChoices((prev) => ({ ...prev, [group]: KEEP_MINE }))} className="h-4 w-4 accent-port-accent" />
                      {additive ? 'Skip them' : 'Keep mine'}
                    </span>
                    <span className="mt-2 block text-port-text">
                      {additive
                        ? <>This install keeps its {formatCount(current.protectedCount, { fallback: '0' })} protected memories and adds nothing.</>
                        : <GroupValue value={current} />}
                    </span>
                  </label>

                  <label htmlFor={`${name}-theirs`} className={`cursor-pointer rounded border p-3 text-xs transition-colors ${choices[group] === USE_IMPORTED ? 'border-port-accent bg-port-accent/5' : 'border-port-border'}`}>
                    <span className="flex items-center gap-2 font-medium text-port-text">
                      <input id={`${name}-theirs`} type="radio" name={name} value={USE_IMPORTED} checked={choices[group] === USE_IMPORTED} disabled={Boolean(pending)} onChange={() => setChoices((prev) => ({ ...prev, [group]: USE_IMPORTED }))} className="h-4 w-4 accent-port-accent" />
                      {additive ? 'Import them' : 'Use imported'}
                    </span>
                    <span className="mt-2 block text-port-text">
                      {additive
                        ? <>Appends {formatCount(incoming.importable, { fallback: '0' })} new memories{incoming.alreadyHere > 0 ? ` (${formatCount(incoming.alreadyHere)} already here, skipped)` : ''}. Nothing you hold is removed.</>
                        : <GroupValue value={incoming} />}
                    </span>
                  </label>
                </div>

                {identical && (
                  <p className="mt-2 text-xs text-port-text-muted">{additive ? 'This bundle adds no memories you do not already have.' : 'Both sides are identical — either choice leaves this unchanged.'}</p>
                )}
              </fieldset>
            );
          })}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-port-text-muted">
              {taking === 0
                ? 'Every group is set to keep this install\'s value — confirming would change nothing.'
                : `Confirming replaces ${formatCount(taking)} group${taking === 1 ? '' : 's'} on this install. This cannot be undone from here.`}
            </p>
            <button
              type="button"
              onClick={applyBundle}
              disabled={Boolean(pending) || taking === 0}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded bg-port-accent px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={16} className={pending === 'apply' ? 'animate-pulse' : ''} aria-hidden="true" /> {pending === 'apply' ? 'Applying…' : 'Apply these choices'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
