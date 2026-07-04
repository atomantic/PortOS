import { useState, memo } from 'react';
import AppIcon from '../../../AppIcon';
import CronInput from '../../../CronInput';
import { AGENT_OPTIONS, ISSUE_AUTHOR_FILTER_OPTIONS, ISSUE_AUTHOR_FILTER_TASK_TYPES, SWARM_COUNT_OPTIONS, SWARM_TASK_TYPES, toggleAppMetadataOverride, agentOptionButtonClass } from '../../constants';
import { isCronExpression, describeCron } from '../../../../utils/cronHelpers';
import ToggleSwitch from '../../../ToggleSwitch';
import { INTERVAL_LABELS } from './scheduleConstants';

const AppOverrideRow = memo(function AppOverrideRow({ app, taskType, globalIntervalType, globalTaskMetadata, managedAgentOptions, override, onUpdate }) {
  const [updating, setUpdating] = useState(false);
  const [cronEditing, setCronEditing] = useState(false);
  const isEnabled = override?.enabled === true;
  const currentInterval = override?.interval || null;
  const hasCron = isCronExpression(currentInterval);

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
    const taskMetadata = toggleAppMetadataOverride(override?.taskMetadata, globalTaskMetadata, field);
    await onUpdate(app.id, taskType, { taskMetadata }).catch(() => {});
    setUpdating(false);
  };

  // claim-issue per-app author filter. '' = inherit the global default; any
  // other value writes a per-app override. The server replaces taskMetadata
  // wholesale, so preserve the app's other override keys (worktree, etc.).
  const handleIssueAuthorFilterChange = async (value) => {
    setUpdating(true);
    const next = { ...(override?.taskMetadata || {}) };
    if (value === '') delete next.issueAuthorFilter;
    else next.issueAuthorFilter = value;
    const taskMetadata = Object.keys(next).length ? next : null;
    await onUpdate(app.id, taskType, { taskMetadata }).catch(() => {});
    setUpdating(false);
  };

  // claim-issue per-app swarm override. '' = inherit the global default; '0'
  // = explicit off; 2..6 = swarm with that many agents. Sent as a Number: the
  // server's sanitizer KEEPS an explicit 0 (it's how a per-app override turns
  // swarm off even when the global default has it on) and 2..6; only 1 /
  // out-of-range / non-integer are dropped. Inherit is the absent key (deleted
  // above), distinct from a stored 0.
  const handleSwarmCountChange = async (raw) => {
    setUpdating(true);
    const next = { ...(override?.taskMetadata || {}) };
    if (raw === '') delete next.swarmCount;
    else next.swarmCount = Number(raw);
    const taskMetadata = Object.keys(next).length ? next : null;
    await onUpdate(app.id, taskType, { taskMetadata }).catch(() => {});
    setUpdating(false);
  };

  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3 py-2 px-3 rounded hover:bg-port-card/30">
      <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto sm:flex-1">
        <AppIcon icon={app.icon || 'package'} appId={app.id} hasAppIcon={!!app.appIconPath} size={16} className="text-gray-400 shrink-0" />
        <span className="text-sm text-white truncate flex-1">{app.name}</span>
        <div className="sm:hidden">
          <ToggleSwitch
            enabled={isEnabled}
            onChange={handleToggle}
            disabled={updating}
            size="sm"
            ariaLabel={`${isEnabled ? 'Disable' : 'Enable'} ${taskType} for ${app.name}`}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <select
            value={cronEditing || hasCron ? 'cron' : (currentInterval || '')}
            onChange={(e) => handleIntervalChange(e.target.value)}
            disabled={updating}
            className="bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white min-w-[120px] min-h-[40px]"
          >
            <option value="">Inherit ({INTERVAL_LABELS[globalIntervalType] || globalIntervalType})</option>
            <option value="rotation">Rotation</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="once">Once</option>
            <option value="on-demand">On Demand</option>
            <option value="cron">Cron</option>
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
          {AGENT_OPTIONS.map(({ field, label, shortLabel }) => {
            const effective = override?.taskMetadata?.[field] ?? globalTaskMetadata?.[field] ?? false;
            const hasOverride = override?.taskMetadata?.[field] !== undefined;
            const managed = managedAgentOptions?.includes(field);
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

        {ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType) && (
          <select
            value={override?.taskMetadata?.issueAuthorFilter || ''}
            onChange={(e) => handleIssueAuthorFilterChange(e.target.value)}
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

        <div className="hidden sm:block">
          <ToggleSwitch
            enabled={isEnabled}
            onChange={handleToggle}
            disabled={updating}
            size="sm"
            ariaLabel={`${isEnabled ? 'Disable' : 'Enable'} ${taskType} for ${app.name}`}
          />
        </div>
      </div>
    </div>
  );
});

export default AppOverrideRow;
