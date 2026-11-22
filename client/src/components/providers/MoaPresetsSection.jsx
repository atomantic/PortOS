import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Layers, Plus, Trash2 } from 'lucide-react';
import { createMoaPreset, deleteMoaPreset, listMoaPresets, updateMoaPreset } from '../../services/apiMoaPresets';
import { filterSelectableModels } from '../../utils/providers';
import { formatCount } from '../../utils/formatters';
import { FormField } from '../ui/FormField';
import CollapsibleListItem from '../ui/CollapsibleListItem';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import CopyableId from '../ui/CopyableId';
import ListLoadError from '../ui/ListLoadError';

/**
 * Mixture of Agents presets on /ai/presets (#17386): named groups of 1–5
 * reference models that advise one aggregator model. A preset runs wherever a
 * provider id is accepted, as `moa:<id>`. The editor is the deep-linkable
 * route `/ai/presets/moa/:moaId` (`new` creates).
 *
 * The fixed text MoA adds to every request is shown verbatim from the server
 * (`instructions`), so nothing reaches a model that the user cannot read here.
 */

const BASE = '/ai/presets';
const PRIVACY_OPTIONS = [
  { value: 'off', label: 'Off — advisor text shown and injected as written' },
  { value: 'display', label: 'Display — scrub secrets and PII from advisor text shown in results' },
  { value: 'full', label: 'Full — also scrub before the aggregator sees it' },
];
const blankMember = () => ({ providerId: '', model: '' });
const blankDraft = () => ({
  name: '', description: '', referenceModels: [blankMember(), blankMember()], aggregator: blankMember(),
  privacyFilter: 'off', advisorMaxTokens: 1024, enabled: true,
});

const toDraft = (preset) => ({
  name: preset.name,
  description: preset.description ?? '',
  referenceModels: preset.referenceModels.map((m) => ({ providerId: m.providerId, model: m.model ?? '', temperature: m.temperature })),
  aggregator: { providerId: preset.aggregator.providerId, model: preset.aggregator.model ?? '' },
  privacyFilter: preset.privacyFilter,
  advisorMaxTokens: preset.advisorMaxTokens,
  enabled: preset.enabled,
});

// Absent model = the provider's default; an untouched temperature stays absent.
const memberPayload = ({ providerId, model, temperature }, { withTemperature }) => ({
  providerId,
  ...(model ? { model } : {}),
  ...(withTemperature && temperature !== undefined && temperature !== '' ? { temperature: Number(temperature) } : {}),
});

const toPayload = (draft) => ({
  name: draft.name.trim(),
  description: draft.description.trim(),
  referenceModels: draft.referenceModels.map((m) => memberPayload(m, { withTemperature: true })),
  aggregator: memberPayload(draft.aggregator, { withTemperature: false }),
  privacyFilter: draft.privacyFilter,
  advisorMaxTokens: Number(draft.advisorMaxTokens),
  enabled: draft.enabled,
});

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white';
const buttonClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent transition-colors disabled:opacity-50';

function MemberFields({ label, member, apiProviders, onChange, withTemperature }) {
  const provider = apiProviders.find((p) => p.id === member.providerId);
  const models = filterSelectableModels(provider?.models || []);
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end">
      <FormField label={`${label} provider`}>
        <select className={inputClass} value={member.providerId} onChange={(e) => onChange({ ...member, providerId: e.target.value, model: '' })}>
          <option value="">Choose an API provider…</option>
          {apiProviders.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
          {member.providerId && !provider && <option value={member.providerId}>{member.providerId} (unavailable)</option>}
        </select>
      </FormField>
      <FormField label="Model">
        <select className={inputClass} value={member.model} onChange={(e) => onChange({ ...member, model: e.target.value })}>
          <option value="">{provider?.defaultModel ? `Provider default (${provider.defaultModel})` : 'Provider default'}</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
          {member.model && !models.includes(member.model) && <option value={member.model}>{member.model}</option>}
        </select>
      </FormField>
      {withTemperature ? (
        <FormField label="Temp">
          <input
            type="number" min="0" max="2" step="0.1" placeholder="default" className={`${inputClass} sm:w-24`}
            value={member.temperature ?? ''}
            onChange={(e) => onChange({ ...member, temperature: e.target.value === '' ? undefined : e.target.value })}
          />
        </FormField>
      ) : <span aria-hidden="true" />}
    </div>
  );
}

function MoaPresetEditor({ preset, apiProviders, maxReferenceModels, instructions, onSaved }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => (preset ? toDraft(preset) : blankDraft()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const setField = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const setReference = (index, member) => setDraft((prev) => ({ ...prev, referenceModels: prev.referenceModels.map((m, i) => (i === index ? member : m)) }));
  const complete = draft.name.trim() && draft.aggregator.providerId && draft.referenceModels.every((m) => m.providerId);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const payload = toPayload(draft);
    const saved = await (preset ? updateMoaPreset(preset.id, payload, { silent: true }) : createMoaPreset(payload, { silent: true }))
      .catch((err) => { setError(err.message); return null; })
      .finally(() => setSaving(false));
    if (!saved) return;
    onSaved(saved);
    navigate(BASE);
  };

  return (
    <form onSubmit={save} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-3">
      <h3 className="text-sm font-semibold text-white">{preset ? `Edit ${preset.name}` : 'New MoA preset'}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <FormField label="Name">
          <input className={inputClass} value={draft.name} maxLength={100} onChange={(e) => setField('name', e.target.value)} />
        </FormField>
        <FormField label="Description">
          <input className={inputClass} value={draft.description} maxLength={500} onChange={(e) => setField('description', e.target.value)} />
        </FormField>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs uppercase tracking-wide text-gray-500">Reference models: advise in parallel, tool-free, once per request</legend>
        {draft.referenceModels.map((member, index) => (
          <div key={index} className="flex gap-2 items-end">
            <div className="flex-1 min-w-0">
              <MemberFields label={`Reference ${index + 1}`} member={member} apiProviders={apiProviders} withTemperature onChange={(m) => setReference(index, m)} />
            </div>
            <button
              type="button" aria-label={`Remove reference model ${index + 1}`} disabled={draft.referenceModels.length <= 1}
              onClick={() => setField('referenceModels', draft.referenceModels.filter((_, i) => i !== index))}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded border border-port-border text-gray-400 hover:text-port-error disabled:opacity-40"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        {draft.referenceModels.length < maxReferenceModels && (
          <button type="button" className={buttonClass} onClick={() => setField('referenceModels', [...draft.referenceModels, blankMember()])}>
            <Plus size={14} aria-hidden="true" /> Add reference model
          </button>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs uppercase tracking-wide text-gray-500">Aggregator: the acting, billed model that writes the answer</legend>
        <MemberFields label="Aggregator" member={draft.aggregator} apiProviders={apiProviders} withTemperature={false} onChange={(m) => setField('aggregator', m)} />
      </fieldset>

      <div className="grid gap-2 sm:grid-cols-2">
        <FormField label="Privacy filter">
          <select className={inputClass} value={draft.privacyFilter} onChange={(e) => setField('privacyFilter', e.target.value)}>
            {PRIVACY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </FormField>
        <FormField label="Advisor max tokens">
          <input type="number" min="64" max="8192" step="64" className={inputClass} value={draft.advisorMaxTokens} onChange={(e) => setField('advisorMaxTokens', e.target.value)} />
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-300">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setField('enabled', e.target.checked)} />
        Run the reference models (unchecked runs the aggregator alone)
      </label>

      {instructions && (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer">Text MoA adds after your prompt</summary>
          <p className="mt-2 text-gray-500">Advisors receive:</p>
          <pre className="whitespace-pre-wrap break-words bg-port-card border border-port-border rounded p-2">{instructions.advisor}</pre>
          <p className="mt-2 text-gray-500">The aggregator receives the advisors&apos; answers in a block after your prompt, then:</p>
          <pre className="whitespace-pre-wrap break-words bg-port-card border border-port-border rounded p-2">{instructions.aggregator}</pre>
          <p className="mt-2 text-gray-500">Each run in Run History holds the exact prompt it was sent.</p>
        </details>
      )}

      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saving || !complete} className="px-3 py-1.5 text-sm rounded bg-port-accent hover:bg-port-accent/80 text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Save preset'}
        </button>
        <Link to={BASE} className={buttonClass}>Cancel</Link>
      </div>
    </form>
  );
}

function MoaPresetCard({ preset, providersById, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const name = (member) => `${providersById[member.providerId]?.name || member.providerId}${member.model ? ` / ${member.model}` : ''}`;
  const remove = async () => {
    setDeleting(true);
    const ok = await deleteMoaPreset(preset.id).then(() => true, () => false);
    setDeleting(false);
    setConfirming(false);
    if (ok) setRemoving(true);
  };

  return (
    <CollapsibleListItem removing={removing} onExited={() => onDeleted(preset.id)}>
    <div className="bg-port-bg border border-port-border rounded-lg p-3 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-white break-words">{preset.name}</h3>
          {preset.providerId && <CopyableId id={preset.providerId} chars={64} />}
          {preset.enabled === false && <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">ADVISORS OFF</span>}
        </div>
        {preset.invalid ? (
          <p className="text-xs text-port-error break-words">This stored preset cannot run: {preset.invalid}</p>
        ) : (
          <>
            {preset.description && <p className="text-xs text-gray-400 break-words">{preset.description}</p>}
            <p className="text-xs text-gray-300 break-words">Aggregator (acting, billed run): {name(preset.aggregator)}</p>
            <p className="text-xs text-gray-400 break-words">
              {formatCount(preset.referenceModels.length)} reference {preset.referenceModels.length === 1 ? 'model advises' : 'models advise'} once per request, each billed as its own run: {preset.referenceModels.map(name).join(', ')}
            </p>
            {preset.refusals?.map((r) => (
              <p key={`${r.role}-${r.index}`} className="text-xs text-port-warning break-words">
                {r.role === 'aggregator' ? 'Aggregator' : `Reference ${r.index + 1}`}: {r.refusal}
              </p>
            ))}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2 shrink-0">
        {!preset.invalid && <Link to={`${BASE}/moa/${preset.id}`} className={buttonClass}>Edit</Link>}
        {preset.id && (confirming ? (
          <ConfirmButtonPair prompt="Delete?" onConfirm={remove} onCancel={() => setConfirming(false)} busy={deleting} responsiveTouchTargets />
        ) : (
          <button type="button" className={buttonClass} onClick={() => setConfirming(true)}>Delete</button>
        ))}
      </div>
    </div>
    </CollapsibleListItem>
  );
}

export default function MoaPresetsSection({ providers = [] }) {
  const { moaId } = useParams();
  const [state, setState] = useState({ status: 'loading', presets: [], maxReferenceModels: 5, instructions: null, error: null });
  const [reloadKey, setReloadKey] = useState(0);
  const sectionRef = useRef(null);

  // The section sits below the preset list; a deep link to an editor brings it into view.
  useEffect(() => {
    if (moaId) sectionRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [moaId]);

  useEffect(() => {
    let active = true;
    listMoaPresets({ silent: true }).then(
      (data) => { if (active) setState({ status: 'ready', presets: data.presets, maxReferenceModels: data.maxReferenceModels, instructions: data.instructions, error: null }); },
      (error) => { if (active) setState((prev) => ({ ...prev, status: 'error', error })); },
    );
    return () => { active = false; };
  }, [reloadKey]);

  const apiProviders = useMemo(() => providers.filter((p) => p.type === 'api' && p.enabled !== false), [providers]);
  const providersById = useMemo(() => Object.fromEntries(providers.map((p) => [p.id, p])), [providers]);
  const editing = moaId === 'new' ? null : state.presets.find((p) => p.id === moaId);
  const showEditor = state.status === 'ready' && (moaId === 'new' || (editing && !editing.invalid));

  const onSaved = (saved) => setState((prev) => ({
    ...prev,
    presets: prev.presets.some((p) => p.id === saved.id) ? prev.presets.map((p) => (p.id === saved.id ? saved : p)) : [...prev.presets, saved],
  }));
  const onDeleted = (id) => setState((prev) => ({ ...prev, presets: prev.presets.filter((p) => p.id !== id) }));

  return (
    <section ref={sectionRef} aria-labelledby="moa-presets-heading" className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="moa-presets-heading" className="text-lg font-semibold text-white flex items-center gap-2">
            <Layers size={18} aria-hidden="true" /> Mixture of Agents
          </h2>
          <p className="text-xs text-gray-400">
            Several API models answer independently; one aggregator writes the final answer. Select a preset anywhere a provider id is accepted, as <code>moa:&lt;id&gt;</code>.
          </p>
        </div>
        {moaId !== 'new' && (
          <Link to={`${BASE}/moa/new`} className={buttonClass}><Plus size={14} aria-hidden="true" /> New MoA preset</Link>
        )}
      </div>

      {state.status === 'error' && <ListLoadError what="MoA presets" error={state.error} onRetry={() => setReloadKey((k) => k + 1)} />}
      {state.status === 'ready' && moaId && moaId !== 'new' && !editing && (
        <p className="text-sm text-port-warning">No MoA preset “{moaId}”. <Link to={BASE} className="underline">Back to presets</Link></p>
      )}
      {showEditor && (
        <MoaPresetEditor
          key={moaId}
          preset={editing}
          apiProviders={apiProviders}
          maxReferenceModels={state.maxReferenceModels}
          instructions={state.instructions}
          onSaved={onSaved}
        />
      )}
      {state.status === 'ready' && state.presets.length === 0 && !showEditor && (
        <p className="text-sm text-gray-500">No MoA presets yet.</p>
      )}
      {state.presets.length > 0 && (
        <div>
          {state.presets.map((preset) => (
            <MoaPresetCard key={preset.id ?? preset.name} preset={preset} providersById={providersById} onDeleted={onDeleted} />
          ))}
        </div>
      )}
    </section>
  );
}
