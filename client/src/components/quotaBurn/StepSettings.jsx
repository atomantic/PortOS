/**
 * A burn step's PER-INVOCATION overrides, and the effective settings they add up
 * to.
 *
 * The step references a scheduled task the user already configured, so every
 * control here is a three-state one: INHERIT the task's saved setting, or pin
 * something else for this burn only. Nothing written here ever edits the task —
 * that is what the "view / edit" link beside the picker is for.
 *
 * Effective values (and the audit mode) are stated ABOVE the controls rather
 * than left to be inferred: a burn spends real subscription quota unattended,
 * and "what will actually run" must be readable before Run Now or the next
 * cycle, not reconstructed from two pages.
 *
 * The audit-mode and agent-option vocabulary is imported from the Schedule tab's
 * own constants, not restated — one catalog, rendered twice.
 */

import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import EffortSelect from '../cos/EffortSelect';
import { AGENT_OPTIONS } from '../cos/constants';
import { fileIssuesEffective, managedAgentOptionsFor } from '../cos/tabs/schedule/scheduleConstants';
import { effectiveQuotaBurnSettings, QUOTA_BURN_TASK_REF_KIND, taskSourceHref } from '../../lib/quotaBurnTasks';
import { effortAwareModelOptions, effortLevelsForProvider, effortSurvivingModel } from '../../utils/providers';
import { inputClass } from './fields';

const INHERIT = '';

/** A tri-state boolean as a `<select>` value: inherit, on, off. */
const booleanValue = (value) => (value === undefined || value === null ? INHERIT : String(value === true));
const parseBooleanValue = (raw) => (raw === INHERIT ? undefined : raw === 'true');

export default function StepSettings({ job, entry, providers, idPrefix, onChange }) {
  const overrides = job.overrides || {};
  const params = overrides.params || {};
  const saved = entry?.config || null;
  const effective = effectiveQuotaBurnSettings(job, saved);

  const setOverride = (key, value) => onChange({ ...job, overrides: { ...overrides, [key]: value || null } });
  // A param set back to "Inherit" is DELETED rather than written as null: the
  // server merges the bag over the task's saved metadata, so a null would pin
  // the key to null instead of letting the task's own value through.
  const setParam = (key, value) => {
    const next = { ...params };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange({ ...job, overrides: { ...overrides, params: next } });
  };

  // Falls back to the family's first eligible binary rather than to nothing: an
  // unpinned step runs on whatever the family resolves, so that provider's model
  // ladder and effort tiers are the ones to offer. Without the fallback the
  // model and effort controls simply vanished for every step that inherits.
  const selectedProvider = providers.find((provider) => provider.id === effective.providerId) || providers[0] || null;
  const availableModels = selectedProvider ? effortAwareModelOptions(selectedProvider, effective.model) : [];
  const effortLevels = selectedProvider ? effortLevelsForProvider(selectedProvider, effective.model) : null;

  const handleModelChange = (raw) => {
    const nextModel = raw || null;
    // A pinned effort the new model does not offer is dropped rather than saved
    // onto a model that cannot honor it.
    const surviving = overrides.effort && selectedProvider
      ? effortSurvivingModel(selectedProvider, nextModel, overrides.effort)
      : overrides.effort;
    onChange({ ...job, overrides: { ...overrides, model: nextModel, effort: surviving || null } });
  };

  const auditCapable = saved?.fileIssuesCapable === true;
  const filesIssues = fileIssuesEffective(saved, params);
  const managed = auditCapable ? managedAgentOptionsFor(saved, params) : (saved?.managedAgentOptions || []);
  const agentOptionsShown = entry && !entry.programmatic;

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-400">
        <span className="text-gray-500">Effective: </span>
        {effective.providerId || 'family default provider'}
        {' · '}{effective.model || 'task default model'}
        {effective.effort ? ` · ${effective.effort} effort` : ''}
        {auditCapable ? ` · ${filesIssues ? 'files issues, changes no code' : 'does the work'}` : ''}
        {entry && (
          <>
            {' · '}
            <Link to={taskSourceHref(entry)} className="inline-flex items-center gap-0.5 text-port-accent hover:underline">
              {entry.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM ? 'View / edit the job' : 'View / edit the task'}
              <ExternalLink size={10} aria-hidden="true" />
            </Link>
          </>
        )}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label htmlFor={`${idPrefix}-provider`} className="block text-xs text-gray-400">
          Provider
          <select
            id={`${idPrefix}-provider`}
            className={inputClass}
            value={overrides.providerId || INHERIT}
            onChange={(event) => setOverride('providerId', event.target.value)}
          >
            <option value={INHERIT}>Inherit ({saved?.providerId || 'family default'})</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
            ))}
          </select>
        </label>

        <label htmlFor={`${idPrefix}-model`} className="block text-xs text-gray-400">
          Model
          <select
            id={`${idPrefix}-model`}
            className={inputClass}
            value={overrides.model || INHERIT}
            onChange={(event) => handleModelChange(event.target.value)}
          >
            <option value={INHERIT}>Inherit ({saved?.model || 'task default'})</option>
            {availableModels.map((option) => {
              const value = typeof option === 'string' ? option : option.id;
              return <option key={value} value={value}>{typeof option === 'string' ? option : (option.name || option.id)}</option>;
            })}
            {/* A pin the current provider no longer lists still has to render as
                itself, or the select silently reports a different model than the
                one that will run. */}
            {overrides.model && !availableModels.some((option) => (typeof option === 'string' ? option : option.id) === overrides.model) && (
              <option value={overrides.model}>{overrides.model}</option>
            )}
          </select>
        </label>

        {effortLevels?.length > 0 && (
          <label htmlFor={`${idPrefix}-effort`} className="block text-xs text-gray-400">
            Thinking effort
            <EffortSelect
              id={`${idPrefix}-effort`}
              provider={selectedProvider}
              model={effective.model}
              value={overrides.effort || INHERIT}
              onChange={(effort) => setOverride('effort', effort)}
              className={inputClass}
            />
          </label>
        )}

        {auditCapable && (
          <label htmlFor={`${idPrefix}-file-issues`} className="block text-xs text-gray-400">
            Audit mode
            <select
              id={`${idPrefix}-file-issues`}
              className={inputClass}
              value={booleanValue(params.fileIssues)}
              onChange={(event) => setParam('fileIssues', parseBooleanValue(event.target.value))}
            >
              <option value={INHERIT}>
                Inherit ({fileIssuesEffective(saved) ? 'file issues only' : 'do the work'})
              </option>
              <option value="true">File issues only</option>
              <option value="false">Do the work</option>
            </select>
          </label>
        )}

        {agentOptionsShown && AGENT_OPTIONS.map(({ field, label, description }) => (
          <label key={field} htmlFor={`${idPrefix}-${field}`} className="block text-xs text-gray-400">
            {label}
            <select
              id={`${idPrefix}-${field}`}
              className={inputClass}
              disabled={managed.includes(field)}
              value={managed.includes(field) ? INHERIT : booleanValue(params[field])}
              title={managed.includes(field) ? `${label} is managed by this task in its current mode` : description}
              onChange={(event) => setParam(field, parseBooleanValue(event.target.value))}
            >
              <option value={INHERIT}>
                {managed.includes(field)
                  ? 'Managed by the task'
                  : `Inherit (${saved?.taskMetadata?.[field] === true ? 'on' : 'off'})`}
              </option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </label>
        ))}
      </div>

      {/* A programmatic task's run parameters live on the task itself (they are
          per-type, and PortOS executes them directly). Showing them read-only
          keeps the burn honest about what it will do without growing a second
          editor for a shape only Scheduled Tasks knows. */}
      {entry?.programmatic && (
        <p className="text-[11px] text-gray-500">
          Run parameters come from the scheduled task:{' '}
          {Object.keys(effective.params).length
            ? Object.entries(effective.params).map(([key, value]) => `${key}=${value}`).join(' · ')
            : 'none set'}.
        </p>
      )}
    </div>
  );
}
