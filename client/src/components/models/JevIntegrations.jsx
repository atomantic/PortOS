import { useState } from 'react';
import { getJevPolicy, updateJevPolicy, updateInstanceFeature } from '../../services/api';
import { useSocketResource } from '../../hooks/useSocketResource';
import { publishInstanceFeatures, useInstanceFeatures } from '../../hooks/useInstanceFeatures';

const POLICY_EVENTS = ['jev:policy'];
const loadPolicy = ({ signal }) => getJevPolicy({ silent: true, signal });

const SOURCES = [
  ['github-issue', 'Issue replies and forge maintenance'],
  ['email', 'Message triage action and priority'],
  ['stacker-news', 'Stacker News classification and risk'],
];
const CONSEQUENCES = { disabled: 'No Jev scoring for this source.', off: 'Compare with chat without changing its answer.', prefer: 'Use local decisions; fall back to chat on abstention or failure.', only: 'Use local decisions; skip unresolved items.' };
const MODES = { disabled: 'Disabled', off: 'Shadow', prefer: 'Prefer local', only: 'Local only' };

export default function JevIntegrations({ registry, status }) {
  const { features, error: featureError } = useInstanceFeatures();
  const feature = features?.find(item => item.id === 'jev');
  const { data: policy, updateData: setPolicy, error, refetch } = useSocketResource(loadPolicy, { events: POLICY_EVENTS });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const save = (patch) => {
    setSaving(true);
    setSaveError('');
    return updateJevPolicy(patch, { silent: true }).then(setPolicy)
      .catch(() => setSaveError('Could not save Jev settings. The previous settings remain displayed.'))
      .finally(() => setSaving(false));
  };
  const toggleFeature = () => {
    setSaving(true);
    setSaveError('');
    return updateInstanceFeature('jev', !feature.enabled, { silent: true })
      .then(result => publishInstanceFeatures(result.features, { groups: result.groups }))
      .catch(() => setSaveError('Could not change Jev enablement.'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="space-y-4 border-t border-port-border pt-4">
      <h3 className="text-sm font-semibold text-white">Runtime and integrations</h3>
      <p className="text-sm text-gray-300" role="status">
        Integrations: {featureError || !feature ? 'unknown' : feature.enabled ? 'enabled' : 'disabled'}.
        {' '}Runtime: {!status ? 'unknown' : status.resident ? 'model loaded' : status.ready ? 'installed, idle' : 'not ready'}.
      </p>
      <button type="button" onClick={toggleFeature} disabled={!feature || !!featureError || saving}
        className="px-3 py-2 text-sm border border-port-border rounded text-port-accent disabled:opacity-50">
        {saving ? 'Saving…' : feature?.enabled ? 'Disable Jev integrations' : 'Enable Jev integrations'}
      </button>
      <p className="text-xs text-gray-400">The model starts on the first scoring request and unloads after ten idle minutes. Disabling integrations prevents new automatic scoring; manual scoring and training remain explicit actions. Use Unload now to release a resident model.</p>
      <p className="text-xs text-gray-400">Shadow compares with the chat provider without changing its answer. Prefer local falls back to chat on abstention or failure. Local only skips unresolved items. Disabled runs no Jev scoring for that source. All sources also require the global switch and an installed model.</p>
      {(error || saveError) && <p role="alert" className="text-xs text-port-warning">{saveError || 'Could not refresh integration settings; displayed settings may be stale.'} <button type="button" onClick={refetch} className="underline">Retry</button></p>}
      {!policy && !error && <p className="text-xs text-gray-400">Loading integration settings…</p>}
      <fieldset disabled={saving || !!error || !policy} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {SOURCES.map(([source, label]) => (
          <div key={source} className="min-w-0">
            <label htmlFor={`jev-source-${source}`} className="block text-xs text-gray-300 mb-1">{label}</label>
            <select id={`jev-source-${source}`} value={policy?.sources?.[source]?.jevMode || 'off'}
              disabled={!policy?.sources?.[source]}
              onChange={event => save({ sources: { [source]: { jevMode: event.target.value } } })}
              className="w-full bg-port-bg border border-port-border rounded p-2 text-sm text-white">
              {Object.entries(MODES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </select>
            <p className="text-xs text-gray-300 mt-1">{CONSEQUENCES[policy?.sources?.[source]?.jevMode] || 'Awaiting saved policy.'}</p>
            {policy && !policy.sources?.[source] && <p className="text-xs text-port-warning">Invalid policy; repair content safety settings.</p>}
            <p className="text-xs text-gray-500 mt-1">Additional margin floor: {policy?.sources?.[source]?.jevMinMargin ?? 'per-decision default'}</p>
          </div>
        ))}
        <div>
          <label htmlFor="jev-scope-enabled" className="block text-xs text-gray-300 mb-1">Issue / PR scope adherence</label>
          <select id="jev-scope-enabled" value={policy?.scopeAdherenceEnabled === false ? 'disabled' : 'enabled'}
            onChange={event => save({ scopeAdherenceEnabled: event.target.value === 'enabled' })}
            className="w-full bg-port-bg border border-port-border rounded p-2 text-sm text-white">
            <option value="enabled">Enabled — on-demand advisory</option><option value="disabled">Disabled</option>
          </select>
        </div>
      </fieldset>
      <p className="text-xs text-gray-400">Scope adherence runs when you click Check scope on an issue or PR: retrieve up to three relevant PRD.md / GOALS.md clauses, then score each change against a clause. It does not block completion. Stacker News uses Jev only to escalate; an allowed / low-risk answer still requires the existing analysis.</p>
      <p className="text-xs text-gray-400">Agent-completion goal fidelity uses a separate chat-model reviewer, with forge verification for merge objectives. Jev does not grade those completions. <a href="/models/code-reviewers" className="text-port-accent underline">Manage completion reviews</a></p>
      <a href="/models/llms/abuse" className="text-xs text-port-accent underline">Advanced source policies and margin overrides</a>
      <details className="text-xs text-gray-300 border border-port-border rounded p-3">
        <summary className="cursor-pointer text-port-accent">Questions, answer options, and decision formula</summary>
        <p className="my-3">Each option receives an entailment probability. Winner = highest entailment; margin = winner minus runner-up. Accept only when margin ≥ max(decision floor, winning option floor, source override); otherwise abstain. Agreement with chat measures consistency, not correctness. Scope adherence has no chat comparison.</p>
        {!registry && <p>Decision definitions unavailable. Refresh the page to retry.</p>}
        {Object.entries(registry || {}).map(([id, definition]) => (
          <div key={id} className="border-t border-port-border py-3 space-y-2">
            <h4 className="font-medium text-white">{definition.label}</h4>
            <p>Decision margin floor: {definition.minMargin}</p>
            <ul className="space-y-2">{definition.options.map(option => (
              <li key={option.value}><strong>{option.value}</strong>: {option.hypothesis} <span className="text-gray-500">(floor {Math.max(definition.minMargin, option.minMargin || 0)})</span></li>
            ))}</ul>
          </div>
        ))}
      </details>
    </div>
  );
}
