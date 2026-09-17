import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import CollapsibleSection from '../ui/CollapsibleSection';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { FormField } from '../ui/FormField';
import useConfirmDelete from '../../hooks/useConfirmDelete';
import * as api from '../../services/api';
import { invalidateProviderCatalog } from '../../hooks/useProviderCatalog';
import { formatCount } from '../../utils/formatters';

/**
 * Credential-bootstrap apps (#7564 → #7567): the launch wrappers a composite
 * id's `+<slug>` suffix names — `<command> <args…> <harness-name> [<separator>]
 * <harness args>`. One table in settings, edited whole: every save is the full
 * map back to `PUT /api/providers/bootstraps`, and the compose popover shows
 * its bootstrap select on the next open because the catalog is invalidated.
 *
 * Collapsed and empty-state-only until one exists: most installs never need a
 * wrapper, and a wall of fields for a feature nobody asked for is noise under
 * the harness cards.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const INPUT_CLASS = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden';

const EMPTY_DRAFT = Object.freeze({
  slug: '', label: '', command: '', args: '', argsSeparator: '', setupCommand: '', harnessNames: {},
});

/** A stored app as the form edits it: argv as one space-separated line. */
const draftFromApp = (slug, app) => ({
  slug,
  label: app.label || '',
  command: app.command || '',
  args: Array.isArray(app.args) ? app.args.join(' ') : '',
  argsSeparator: app.argsSeparator || '',
  setupCommand: app.setupCommand || '',
  harnessNames: { ...(app.harnessNames || {}) },
});

/** The form back to the wire shape. Blank optional fields are omitted, not sent empty. */
function appFromDraft(draft) {
  const args = draft.args.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  const harnessNames = Object.fromEntries(Object.entries(draft.harnessNames)
    .map(([id, name]) => [id, String(name || '').trim()])
    .filter(([, name]) => name.length > 0));
  return {
    label: draft.label.trim(),
    command: draft.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(draft.argsSeparator.trim() ? { argsSeparator: draft.argsSeparator.trim() } : {}),
    ...(draft.setupCommand.trim() ? { setupCommand: draft.setupCommand.trim() } : {}),
    ...(Object.keys(harnessNames).length > 0 ? { harnessNames } : {}),
  };
}

function BootstrapForm({ draft, editing, harnesses, busy, onChange, onSubmit, onCancel }) {
  const set = (key) => (e) => onChange({ ...draft, [key]: e.target.value });
  const setHarnessName = (id) => (e) => onChange({ ...draft, harnessNames: { ...draft.harnessNames, [id]: e.target.value } });
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      className="bg-port-bg/60 border border-port-border rounded-lg p-3 space-y-3"
      aria-label={editing ? `Edit bootstrap ${draft.slug}` : 'Add bootstrap'}
    >
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
        <FormField label="Slug *" hint="Lowercase letters, digits, dashes — the `+<slug>` a composite id carries" compact>
          <input id="bootstrap-slug" type="text" value={draft.slug} onChange={set('slug')} disabled={editing} required pattern="[a-z0-9][a-z0-9-]*" className={INPUT_CLASS} placeholder="corp-auth" />
        </FormField>
        <FormField label="Label *" compact>
          <input id="bootstrap-label" type="text" value={draft.label} onChange={set('label')} required className={INPUT_CLASS} placeholder="Corp auth wrapper" />
        </FormField>
        <FormField label="Command *" hint="The wrapper binary" compact>
          <input id="bootstrap-command" type="text" value={draft.command} onChange={set('command')} required className={INPUT_CLASS} placeholder="corp-auth" />
        </FormField>
        <FormField label="Arguments" hint="Space-separated, before the harness name" compact>
          <input id="bootstrap-args" type="text" value={draft.args} onChange={set('args')} className={INPUT_CLASS} placeholder="run" />
        </FormField>
        <FormField label="Args separator" hint="Inserted between the harness name and its own args, e.g. --" compact>
          <input id="bootstrap-separator" type="text" value={draft.argsSeparator} onChange={set('argsSeparator')} className={INPUT_CLASS} placeholder="--" />
        </FormField>
        <FormField label="Setup command" hint="Advisory text shown to you — PortOS never runs it" compact>
          <input id="bootstrap-setup" type="text" value={draft.setupCommand} onChange={set('setupCommand')} className={INPUT_CLASS} placeholder="corp-auth login" />
        </FormField>
      </div>
      <fieldset>
        <legend className="text-xs text-gray-400 mb-1">Harness names the wrapper knows (only where they differ from the binary)</legend>
        <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))]">
          {harnesses.filter((harness) => harness.id !== 'direct').map((harness) => (
            <label key={harness.id} htmlFor={`bootstrap-harness-${harness.id}`} className="text-xs text-gray-400">
              <span className="block mb-0.5">{harness.label}</span>
              <input
                id={`bootstrap-harness-${harness.id}`}
                type="text"
                value={draft.harnessNames[harness.id] || ''}
                onChange={setHarnessName(harness.id)}
                className={INPUT_CLASS}
                placeholder={harness.id === 'claude' ? 'claude-code' : harness.id}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-gray-500 font-mono">
        {draft.command || '<command>'} {draft.args} {'<harness>'} {draft.argsSeparator} {'<harness args>'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="px-3 py-1.5 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50">
          {busy ? 'Saving…' : editing ? 'Save bootstrap' : 'Add bootstrap'}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * @param {object} props
 * @param {object[]} props.harnesses - catalog harness rows, for the per-harness name map.
 * @param {object[]} props.presets - catalog presets, for the "used by" count.
 */
export default function ProviderCredentialBootstraps({ harnesses = [], presets = [] }) {
  // `null` = not fetched yet (or the fetch failed): render the empty hint, never
  // an "add" that would overwrite a table we could not read.
  const [apps, setApps] = useState(null);
  const [draft, setDraft] = useState(null); // null = form closed; { ...EMPTY_DRAFT, editing }
  const [busy, setBusy] = useState(false);
  // Controlled rather than `defaultOpen`: the table arrives after mount, and an
  // uncontrolled section would have already decided to stay collapsed.
  const [open, setOpen] = useState(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  useEffect(() => {
    let active = true;
    api.getProviderBootstraps({ silent: true })
      .then((data) => {
        if (!active) return;
        const table = data?.bootstraps && typeof data.bootstraps === 'object' ? data.bootstraps : {};
        setApps(table);
        setOpen(Object.keys(table).length > 0);
      })
      .catch(() => { if (active) setApps(null); });
    return () => { active = false; };
  }, []);

  const usedBy = useMemo(() => {
    const counts = {};
    for (const preset of presets) {
      if (preset.credentialBootstrapId) counts[preset.credentialBootstrapId] = (counts[preset.credentialBootstrapId] || 0) + 1;
    }
    return counts;
  }, [presets]);

  const entries = Object.entries(apps || {});

  const save = async (next, successMessage) => {
    setBusy(true);
    const result = await api.saveProviderBootstraps(next, { silent: true }).catch((err) => ({ error: err?.message }));
    setBusy(false);
    if (!result || result.error || !result.bootstraps) {
      toast.error(result?.error || 'Could not save the credential bootstraps');
      return false;
    }
    setApps(result.bootstraps);
    invalidateProviderCatalog();
    toast.success(successMessage);
    return true;
  };

  const submit = async () => {
    if (!draft) return;
    const slug = draft.slug.trim();
    if (!SLUG_RE.test(slug)) {
      toast.error('A bootstrap slug is lowercase letters, digits and dashes, starting with a letter or digit');
      return;
    }
    if (!draft.editing && apps && Object.hasOwn(apps, slug)) {
      toast.error(`A bootstrap is already addressed as "${slug}"`);
      return;
    }
    const ok = await save({ ...(apps || {}), [slug]: appFromDraft(draft) }, `Bootstrap "${slug}" saved — compose shows it on the next open`);
    if (ok) setDraft(null);
  };

  const remove = async (slug) => {
    const { [slug]: _removed, ...rest } = apps || {};
    await save(rest, `Bootstrap "${slug}" removed`);
  };

  return (
    <CollapsibleSection
      id="credential-bootstraps"
      icon={KeyRound}
      label="Credential bootstraps"
      summary={entries.length === 0 ? 'None configured' : `${formatCount(entries.length)} configured`}
      open={open}
      onOpenChange={setOpen}
      size="md"
      className="bg-port-card border border-port-border rounded-xl px-4 py-2"
      bodyClassName="space-y-3 pb-2"
    >
      <p className="text-xs text-gray-400">
        A launch wrapper that mints a harness's credential at spawn. Any CLI/TUI combination can run through one
        by adding <code className="font-mono">+&lt;slug&gt;</code> to its composite id, or by picking it in the compose flow.
      </p>
      {apps === null && <Banner tone="warning" size="sm">Could not read the configured bootstraps.</Banner>}
      {entries.length > 0 && (
        <ul className="space-y-2">
          {entries.map(([slug, app]) => (
            <li key={slug} className="bg-port-bg/60 border border-port-border rounded-lg p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-white">{app.label}</span>
                  <code className="ml-2 text-xs font-mono text-gray-500">+{slug}</code>
                  <p className="text-xs text-gray-400 font-mono break-all">
                    {app.command} {(app.args || []).join(' ')} {'<harness>'} {app.argsSeparator || ''}
                  </p>
                  {app.setupCommand && <p className="text-xs text-gray-500">Setup: <code className="font-mono">{app.setupCommand}</code></p>}
                  <p className="text-xs text-gray-500">
                    Used by {formatCount(usedBy[slug] || 0, { fallback: '0' })} preset{(usedBy[slug] || 0) === 1 ? '' : 's'}
                    {app.harnessNames && Object.keys(app.harnessNames).length > 0
                      ? ` · names: ${Object.entries(app.harnessNames).map(([id, name]) => `${id}→${name}`).join(', ')}`
                      : ''}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setDraft({ ...draftFromApp(slug, app), editing: true })}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-port-border text-gray-300 hover:text-white"
                  >
                    <Pencil className="w-3 h-3" aria-hidden="true" /> Edit
                  </button>
                  {!isConfirming(slug) && (
                    <button
                      type="button"
                      onClick={() => requestDelete(slug)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-port-error/50 text-port-error hover:bg-port-error/10"
                    >
                      <Trash2 className="w-3 h-3" aria-hidden="true" /> Remove
                    </button>
                  )}
                </div>
              </div>
              {isConfirming(slug) && (
                <InlineConfirmRow
                  question={`Remove the "${app.label}" bootstrap? Presets that name +${slug} will refuse to run until it is re-added.`}
                  confirmText="Remove bootstrap"
                  autoFocus
                  aria-label={`Confirm removing the ${app.label} bootstrap`}
                  onConfirm={() => confirmDelete(() => remove(slug))}
                  onCancel={cancelDelete}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <BootstrapForm
          draft={draft}
          editing={Boolean(draft.editing)}
          harnesses={harnesses}
          busy={busy}
          onChange={setDraft}
          onSubmit={submit}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <button
          type="button"
          disabled={apps === null}
          onClick={() => setDraft({ ...EMPTY_DRAFT, editing: false })}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white disabled:opacity-50"
        >
          <Plus className="w-4 h-4" aria-hidden="true" /> Add bootstrap
        </button>
      )}
    </CollapsibleSection>
  );
}
