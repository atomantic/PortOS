import { useState, memo } from 'react';
import AppIcon from '../../../AppIcon';
import CronInput from '../../../CronInput';
import { AGENT_OPTIONS, BRANCHES_PER_AGENT_DEFAULT, BRANCHES_PER_AGENT_OPTIONS, BRANCHES_PER_AGENT_TASK_TYPES, ISSUE_AUTHOR_FILTER_OPTIONS, ISSUE_AUTHOR_FILTER_TASK_TYPES, PR_COMPLETION_OPTIONS, pinnedPrCompletion, prCompletionOption, SWARM_COUNT_OPTIONS, SWARM_TASK_TYPES, toggleAppMetadataOverride, agentOptionButtonClass } from '../../constants';
import AppProviderPin from '../../AppProviderPin';
import { isCronExpression, describeCron } from '../../../../utils/cronHelpers';
import ToggleSwitch from '../../../ToggleSwitch';
import useFieldDraft from '../../../../hooks/useFieldDraft';
import { INTERVAL_LABELS, setMetadataOverride } from './scheduleConstants';

const AppOverrideRow = memo(function AppOverrideRow({ app, taskType, globalIntervalType, globalTaskMetadata, managedAgentOptions, fileIssuesCapable, defaultFileIssues, doWorkRequiresWorktree, inheritedProviderText, providers, providersLoaded = true, override, onUpdate }) {
  const [updating, setUpdating] = useState(false);
  const [cronEditing, setCronEditing] = useState(false);
  const isEnabled = override?.enabled === true;
  // The row's toggle is the app's ON/OFF switch for this scheduled task, not a
  // "use my overrides" flag — every other control on the row is inert until it
  // is on. Say so in the accessible name and the tooltip, since the switch
  // itself carries no visible state text.
  const enabledToggleLabel = `${taskType} enabled for ${app.name}: ${isEnabled ? 'on' : 'off'}`;
  const enabledToggleTitle = isEnabled
    ? `${taskType} runs for ${app.name} on the schedule set here. Turn off to stop scheduling it for this app.`
    : `${taskType} does not run for ${app.name}. Turn on to schedule it for this app.`;
  const currentInterval = override?.interval || null;
  const hasCron = isCronExpression(currentInterval);
  // Same effective-value rule the AGENT_OPTIONS buttons use: this app's override
  // wins, else the global config. No PR, nothing to decide about one.
  const opensPR = (override?.taskMetadata?.openPR ?? globalTaskMetadata?.openPR) === true;

  // A per-app provider/model pin OUTRANKS the task's own provider pin at spawn,
  // for every task type (#4783) — so an app carrying one runs on a provider the
  // card above never mentions. Edit it here, where the task provider is chosen,
  // through the same control Edit App → Automation uses.
  const handlePinChange = async (patch) => {
    setUpdating(true);
    await onUpdate(app.id, taskType, patch).catch(() => {});
    setUpdating(false);
  };

  const handleToggle = async () => {
    setUpdating(true);
    await onUpdate(app.id, taskType, { enabled: !isEnabled, interval: currentInterval }).catch(() => {});
    setUpdating(false);
  };

  const handleIntervalChange = async (newInterval) => {
    if (newInterval === 'cron') {
      setCronEditing(true);
      return;
    }
    setCronEditing(false);
    setUpdating(true);
    const interval = newInterval === '' ? null : newInterval;
    await onUpdate(app.id, taskType, { enabled: isEnabled, interval }).catch(() => {});
    setUpdating(false);
  };

  const handleCronSave = async (expr) => {
    setUpdating(true);
    await onUpdate(app.id, taskType, { enabled: isEnabled, interval: expr }).catch(() => {});
    setCronEditing(false);
    setUpdating(false);
  };

  const handleMetaToggle = async (field) => {
    setUpdating(true);
    let taskMetadata = toggleAppMetadataOverride(override?.taskMetadata, globalTaskMetadata, field);
    const nextFileIssues = field === 'fileIssues'
      ? (taskMetadata?.fileIssues ?? globalTaskMetadata?.fileIssues ?? defaultFileIssues)
      : null;
    if (field === 'fileIssues' && nextFileIssues === true && taskMetadata) {
      taskMetadata = { ...taskMetadata, useWorktree: false, openPR: false, simplify: false };
    } else if (field === 'fileIssues' && nextFileIssues === false && doWorkRequiresWorktree && taskMetadata) {
      taskMetadata = { ...taskMetadata, useWorktree: true };
    }
    await onUpdate(app.id, taskType, { taskMetadata }).catch(() => {});
    setUpdating(false);
  };

  // Per-app override for one non-boolean knob. '' = inherit the global default
  // (see setMetadataOverride for the set-or-clear rule).
  const handleOverrideChange = async (field, value) => {
    setUpdating(true);
    const taskMetadata = setMetadataOverride(override?.taskMetadata, field, value);
    await onUpdate(app.id, taskType, { taskMetadata }).catch(() => {});
    setUpdating(false);
  };

  // Swarm count goes as a Number: the server's sanitizer KEEPS an explicit 0
  // (how a per-app override turns swarm off even when the global default has it
  // on) and 2..6; only 1 / out-of-range / non-integer are dropped. Inherit is
  // the absent key, distinct from a stored 0.
  const handleSwarmCountChange = (raw) => handleOverrideChange('swarmCount', raw === '' ? '' : Number(raw));
  const handleBranchesPerAgentChange = (raw) => handleOverrideChange('branchesPerAgent', raw === '' ? '' : Number(raw));

  // Comma-separated free text for the issueExcludeLabels override — an array
  // field, so it doesn't fit the scalar '' = inherit select pattern the other
  // overrides use. An empty BOX clears the override (inherits the global
  // list) — but a blank box is also what an EXPLICIT `[]` override renders
  // as (nothing to join), so the two states are visually identical in the
  // text field alone. The "None" checkbox below disambiguates: it reflects
  // (and sets) the explicit-empty-array override distinctly from "no
  // override key at all," letting an app opt OUT of every inherited
  // exclusion — e.g. reclaim `good first issue` for this app's own
  // automation — which a merely-blank box could never express.
  const excludeLabelsExplicitlyEmpty = Array.isArray(override?.taskMetadata?.issueExcludeLabels)
    && override.taskMetadata.issueExcludeLabels.length === 0;
  const excludeLabelsDraft = useFieldDraft(
    (override?.taskMetadata?.issueExcludeLabels || []).join(', '),
    (next) => {
      const trimmed = next.trim();
      const value = trimmed === '' ? '' : trimmed.split(',').map((s) => s.trim()).filter(Boolean);
      return handleOverrideChange('issueExcludeLabels', value);
    }
  );

  const enabledToggle = (
    <>
      <span className="text-[10px] uppercase tracking-wide text-gray-500">Enabled</span>
      <ToggleSwitch
        enabled={isEnabled}
        onChange={handleToggle}
        disabled={updating}
        size="sm"
        ariaLabel={enabledToggleLabel}
      />
    </>
  );

  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3 py-2 px-3 rounded hover:bg-port-card/30">
      <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto sm:flex-1">
        <AppIcon icon={app.icon || 'package'} appId={app.id} hasAppIcon={!!app.appIconPath} size={16} className="text-gray-400 shrink-0" />
        <span className="text-sm text-white truncate flex-1">{app.name}</span>
        <div className="sm:hidden flex items-center gap-1.5 shrink-0" title={enabledToggleTitle}>{enabledToggle}</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <select
            aria-label="Interval"
            value={cronEditing || hasCron ? 'cron' : (currentInterval || '')}
            onChange={(e) => handleIntervalChange(e.target.value)}
            disabled={updating}
            className="bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white min-w-[120px] min-h-[40px]"
          >
            <option value="">Inherit ({INTERVAL_LABELS[globalIntervalType] || globalIntervalType})</option>
            <option value="on-demand">On Demand</option>
            <option value="cron">Scheduled</option>
          </select>
          {cronEditing ? (
            <CronInput
              value={hasCron ? currentInterval : '0 7 * * *'}
              onSave={handleCronSave}
              onCancel={() => setCronEditing(false)}
            />
          ) : hasCron ? (
            <button
              onClick={() => setCronEditing(true)}
              className="px-2 py-1 text-xs text-gray-400 font-mono bg-port-bg border border-port-border rounded hover:border-port-accent cursor-pointer"
              title={describeCron(currentInterval)}
            >
              {currentInterval}
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          {fileIssuesCapable && (() => {
            const effective = override?.taskMetadata?.fileIssues ?? globalTaskMetadata?.fileIssues ?? defaultFileIssues === true;
            const hasOverride = override?.taskMetadata?.fileIssues !== undefined;
            return (
              <button
                key="fileIssues"
                onClick={() => handleMetaToggle('fileIssues')}
                disabled={updating}
                aria-pressed={effective}
                aria-label={`File issues only: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
                className={`text-xs px-2 py-1.5 rounded transition-colors shrink-0 min-h-[40px] min-w-[40px] border ${agentOptionButtonClass(effective, hasOverride)}`}
                title={`File issues only: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
              >
                Iss
              </button>
            );
          })()}
          {AGENT_OPTIONS.map(({ field, label, shortLabel }) => {
            const effective = override?.taskMetadata?.[field] ?? globalTaskMetadata?.[field] ?? false;
            const hasOverride = override?.taskMetadata?.[field] !== undefined;
            const fileIssuesOn = (override?.taskMetadata?.fileIssues ?? globalTaskMetadata?.fileIssues ?? defaultFileIssues) === true;
            const managed = managedAgentOptions?.includes(field)
              || (fileIssuesCapable && fileIssuesOn && ['useWorktree', 'openPR', 'simplify'].includes(field))
              || (doWorkRequiresWorktree && !fileIssuesOn && field === 'useWorktree');
            const titleText = managed
              ? `${label}: managed internally by ${taskType}`
              : `${label}: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`;
            return (
              <button
                key={field}
                onClick={() => handleMetaToggle(field)}
                disabled={updating || managed}
                aria-pressed={effective}
                aria-label={managed
                  ? `${label}: managed by task`
                  : `${label}: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
                className={`text-xs px-2 py-1.5 rounded transition-colors shrink-0 min-h-[40px] min-w-[40px] border ${agentOptionButtonClass(effective, hasOverride)} ${managed ? 'opacity-50 cursor-not-allowed' : ''}`}
                title={titleText}
              >
                {shortLabel}
              </button>
            );
          })}
        </div>

        {/* Bounded so the two selects stay a row item next to the other per-app
            knobs instead of stretching across the wrapped flex line. */}
        <div className="w-full sm:w-auto sm:min-w-[240px] sm:max-w-[360px] sm:flex-1">
          <AppProviderPin
            providers={providers}
            loading={!providersLoaded}
            providerId={override?.providerId}
            model={override?.model}
            onChange={handlePinChange}
            disabled={updating}
            label={`Provider for ${app.name}`}
            inheritLabel={`Inherit (${inheritedProviderText})`}
            compact
          />
        </div>

        {opensPR && (
          <select
            value={pinnedPrCompletion(override?.taskMetadata)}
            onChange={(e) => handleOverrideChange('prCompletion', e.target.value)}
            disabled={updating}
            aria-label={`After opening PR for ${app.name}`}
            title="What happens to the PR this app's runs open"
            className="bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white min-w-[120px] min-h-[40px]"
          >
            <option value="">Inherit ({prCompletionOption(pinnedPrCompletion(globalTaskMetadata))?.label || 'app default'})</option>
            {PR_COMPLETION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}

        {ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType) && (
          <select
            value={override?.taskMetadata?.issueAuthorFilter || ''}
            onChange={(e) => handleOverrideChange('issueAuthorFilter', e.target.value)}
            disabled={updating}
            aria-label={`Issue author filter for ${app.name}`}
            title="Which open issues this app may claim"
            className="bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white min-w-[120px] min-h-[40px]"
          >
            <option value="">Inherit ({ISSUE_AUTHOR_FILTER_OPTIONS.find(o => o.value === (globalTaskMetadata?.issueAuthorFilter || 'self'))?.label})</option>
            {ISSUE_AUTHOR_FILTER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}

        {ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType) && (
          <span className="flex items-center gap-1">
            <input
              type="text"
              value={excludeLabelsDraft.value}
              onChange={excludeLabelsDraft.onChange}
              onBlur={excludeLabelsDraft.onBlur}
              disabled={updating}
              aria-label={`Labels to leave for humans for ${app.name}`}
              title={`Comma-separated labels to skip when auto-claiming (blank inherits: ${(globalTaskMetadata?.issueExcludeLabels || []).join(', ') || 'none'})`}
              placeholder="Inherit"
              className="bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white min-w-[140px] min-h-[40px]"
            />
            <label htmlFor={`exclude-labels-none-${app.id}-${taskType}`} className="flex items-center gap-1 text-[10px] text-gray-500 whitespace-nowrap" title="Explicitly claim ALL labels for this app, ignoring the global exclusion list — a blank box alone means inherit, this means override to none">
              <input
                type="checkbox"
                id={`exclude-labels-none-${app.id}-${taskType}`}
                checked={excludeLabelsExplicitlyEmpty}
                onChange={(e) => handleOverrideChange('issueExcludeLabels', e.target.checked ? [] : '')}
                disabled={updating}
              />
              None
            </label>
          </span>
        )}

        {SWARM_TASK_TYPES.has(taskType) && (
          <select
            value={override?.taskMetadata?.swarmCount ?? ''}
            onChange={(e) => handleSwarmCountChange(e.target.value)}
            disabled={updating}
            aria-label={`Swarm mode for ${app.name}`}
            title="How many independent issues this app claims in parallel per run"
            className="bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white min-w-[120px] min-h-[40px]"
          >
            <option value="">Inherit ({SWARM_COUNT_OPTIONS.find(o => o.value === (globalTaskMetadata?.swarmCount || 0))?.label})</option>
            {SWARM_COUNT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}

        {BRANCHES_PER_AGENT_TASK_TYPES.has(taskType) && (
          <select
            value={override?.taskMetadata?.branchesPerAgent ?? ''}
            onChange={(e) => handleBranchesPerAgentChange(e.target.value)}
            disabled={updating}
            aria-label={`Branches per agent for ${app.name}`}
            title="How many prioritized branches this app's coordinator receives per run"
            className="bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white min-w-[120px] min-h-[40px]"
          >
            <option value="">Inherit ({BRANCHES_PER_AGENT_OPTIONS.find(o => o.value === (globalTaskMetadata?.branchesPerAgent || BRANCHES_PER_AGENT_DEFAULT))?.label})</option>
            {BRANCHES_PER_AGENT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}

        <div className="hidden sm:flex items-center gap-1.5" title={enabledToggleTitle}>{enabledToggle}</div>

      </div>
    </div>
  );
});

export default AppOverrideRow;
