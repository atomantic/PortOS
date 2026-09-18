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

import { useEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import ProviderModelSelector from '../ProviderModelSelector';
import { AGENT_OPTIONS } from '../cos/constants';
import { fileIssuesEffective, managedAgentOptionsFor } from '../cos/tabs/schedule/scheduleConstants';
import { effectiveQuotaBurnSettings, QUOTA_BURN_TASK_REF_KIND, taskSourceHref } from '../../lib/quotaBurnTasks';
import { effortAwareModelOptions } from '../../utils/providers';
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

  // `onChange` REPLACES the whole job, and the shared selector emits model and
  // effort back to back (its effort-survival rule, and the compose flow applying
  // a route). A second emit built from the `job` PROP — still the pre-change one
  // until the parent's PATCH round-trips — would drop the first, so emits compose
  // against the last value sent instead. The accumulator is released on every
  // commit, whether or not the parent applied the change, so the next
  // interaction always starts from the live prop.
  const emitted = useRef(null);
  useEffect(() => { emitted.current = null; });
  const setOverrides = (patch) => {
    const base = emitted.current || job;
    const next = { ...base, overrides: { ...(base.overrides || {}), ...patch } };
    emitted.current = next;
    onChange(next);
  };

  const setOverride = (key, value) => setOverrides({ [key]: value || null });
  // A param set back to "Inherit" is DELETED rather than written as null: the
  // server merges the bag over the task's saved metadata, so a null would pin
  // the key to null instead of letting the task's own value through.
  const setParam = (key, value) => {
    const next = { ...params };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setOverrides({ params: next });
  };

  // Falls back to the family's first eligible binary rather than to nothing: an
  // unpinned step runs on whatever the family resolves, so that provider's model
  // ladder and effort tiers are the ones to offer. Without the fallback the
  // model and effort controls simply vanished for every step that inherits.
  const selectedProvider = providers.find((provider) => provider.id === effective.providerId) || providers[0] || null;
  const availableModels = selectedProvider ? effortAwareModelOptions(selectedProvider, effective.model) : [];

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
        <div className="sm:col-span-2">
          {/* The step's own pins are three-state, so every select keeps a blank
              "Inherit" row naming what the task would use; `effectiveProviderId`
              is what makes the model list and effort ladder resolve against the
              provider an unpinned step actually runs on. */}
          <ProviderModelSelector
            id={`${idPrefix}-provider`}
            label="Provider"
            modelLabel="Model"
            providers={providers}
            selectedProviderId={overrides.providerId || INHERIT}
            // Only while the step INHERITS: the blank row then also names the
            // provider it actually resolves to. Passing it under a pin would
            // append that pin's name to the "Inherit (…)" label, which reads as
            // the inherited provider being the one currently selected.
            effectiveProviderId={overrides.providerId ? undefined : selectedProvider?.id}
            selectedModel={overrides.model || INHERIT}
            availableModels={availableModels}
            onProviderChange={(providerId) => setOverride('providerId', providerId)}
            onModelChange={(model) => setOverride('model', model)}
            effort={overrides.effort || INHERIT}
            onEffortChange={(effort) => setOverride('effort', effort)}
            emptyProviderOption={`Inherit (${saved?.providerId || 'family default'})`}
            emptyModelOption={`Inherit (${saved?.model || 'task default'})`}
            alwaysShowModel
          />
        </div>

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
