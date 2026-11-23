import { AGENT_OPTIONS, BRANCHES_PER_AGENT_DEFAULT, BRANCHES_PER_AGENT_OPTIONS, BRANCHES_PER_AGENT_TASK_TYPES, DEPFREE_MODE_DEFAULT, DEPFREE_MODE_OPTIONS, DEPFREE_MODE_TASK_TYPES, depfreeModeOption, LOG_TRIAGE_CAPS, LOG_TRIAGE_TASK_TYPES, RELEASE_OPTIONS, RELEASE_OPTIONS_TASK_TYPES, STALL_NUDGE_OPTION, SWARM_COUNT_OPTIONS, SWARM_TASK_TYPES } from '../../constants';
import MetadataToggleRow from './MetadataToggleRow';
import TaskOverrides from './TaskOverrides';
import { fileIssuesEffective, managedAgentOptionsFor, toggleFileIssuesMetadata, toggleMetadataField } from './scheduleConstants';

// `onMetadataChange(field, value)` writes one taskMetadata key and `runUpdate(patch)`
// writes a whole patch; both hold the parent's in-flight-save lock.
export default function SwarmAndAgentOptionsSection({ taskType, config, updating, activeCount, onMetadataChange, runUpdate }) {
  // ON unless explicitly false, so it reads from the same rule the server's
  // nudge gate applies (sessionController.js).
  const stallNudgeEnabled = config.taskMetadata?.stallNudge !== false;

  return (
    <TaskOverrides label="Swarm, branches & agent options" activeCount={activeCount}>
      {SWARM_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`swarm-count-${taskType}`} className="text-sm text-gray-400 block mb-2">Swarm Mode</label>
          <select
            id={`swarm-count-${taskType}`}
            value={config.taskMetadata?.swarmCount || 0}
            onChange={(e) => onMetadataChange('swarmCount', Number(e.target.value))}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {SWARM_COUNT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {SWARM_COUNT_OPTIONS.find(o => o.value === (config.taskMetadata?.swarmCount || 0))?.description}.
            {' '}Mirrors slashdo <code>/do:next --swarm</code> — each run partitions independent issues, fans out one worktree agent per issue, and serializes the merges. GitHub/GitLab issue trackers only.
          </p>
        </div>
      )}

      {BRANCHES_PER_AGENT_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`branches-per-agent-${taskType}`} className="text-sm text-gray-400 block mb-2">Branches per agent</label>
          <select
            id={`branches-per-agent-${taskType}`}
            value={config.taskMetadata?.branchesPerAgent || BRANCHES_PER_AGENT_DEFAULT}
            onChange={(e) => onMetadataChange('branchesPerAgent', Number(e.target.value))}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {BRANCHES_PER_AGENT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {BRANCHES_PER_AGENT_OPTIONS.find(o => o.value === (config.taskMetadata?.branchesPerAgent || BRANCHES_PER_AGENT_DEFAULT))?.description}.
            {' '}Branches are prioritized deterministically; the next drain picks up the remainder after this batch progresses.
          </p>
        </div>
      )}

      {LOG_TRIAGE_TASK_TYPES.has(taskType) && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3">
          {LOG_TRIAGE_CAPS.map((cap) => {
            const value = Number.isInteger(config.taskMetadata?.[cap.field]) ? config.taskMetadata[cap.field] : cap.defaultValue;
            // A hand-edited in-range value outside the preset list still shows.
            const options = cap.options.some((opt) => opt.value === value) ? cap.options : [...cap.options, { value, label: String(value) }];
            return (
              <div key={cap.field}>
                <label htmlFor={`${cap.field}-${taskType}`} className="text-sm text-gray-400 block mb-2">{cap.label}</label>
                <select
                  id={`${cap.field}-${taskType}`}
                  value={value}
                  onChange={(e) => onMetadataChange(cap.field, Number(e.target.value))}
                  disabled={updating}
                  className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
                >
                  {options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">{cap.description}.</p>
              </div>
            );
          })}
        </div>
      )}

      {DEPFREE_MODE_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`depfree-mode-${taskType}`} className="text-sm text-gray-400 block mb-2">Removal bar</label>
          <select
            id={`depfree-mode-${taskType}`}
            value={config.taskMetadata?.depfreeMode || DEPFREE_MODE_DEFAULT}
            onChange={(e) => onMetadataChange('depfreeMode', e.target.value)}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {DEPFREE_MODE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {depfreeModeOption(config.taskMetadata?.depfreeMode)?.description}.
            {' '}Mirrors slashdo <code>/do:depfree</code> / <code>--heavy</code> / <code>--extreme</code>; the model and effort pins above decide what runs it.
          </p>
        </div>
      )}

      {RELEASE_OPTIONS_TASK_TYPES.has(taskType) && (
        <div>
          <span className="text-sm text-gray-400 block mb-2">Release Options</span>
          <div className="space-y-2">
            {RELEASE_OPTIONS.map(({ field, label, description }) => {
              const enabled = config.taskMetadata?.[field] !== false;
              return (
                <MetadataToggleRow
                  key={field}
                  label={label}
                  description={description}
                  enabled={enabled}
                  disabled={updating}
                  ariaLabel={`${enabled ? 'Disable' : 'Enable'} ${label.toLowerCase()}`}
                  onToggle={() => onMetadataChange(field, !enabled)}
                />
              );
            })}
          </div>
        </div>
      )}

      {config.fileIssuesCapable && (
        <MetadataToggleRow
          label="File issues only"
          description="When on, the agent reads the code and files tracker issues — it does not change source. When off, it implements the highest-value fix."
          enabled={fileIssuesEffective(config)}
          disabled={updating}
          ariaLabel={fileIssuesEffective(config) ? 'File issues only (on)' : 'File issues only (off)'}
          onToggle={() => runUpdate({
            taskMetadata: toggleFileIssuesMetadata(config.taskMetadata, !fileIssuesEffective(config), config.doWorkRequiresWorktree),
          })}
        />
      )}

      <div>
        <span className="text-sm text-gray-400 block mb-2">Agent Options</span>
        <div className="space-y-2">
          {AGENT_OPTIONS.map(({ field, label, description }) => {
            const enabled = config.taskMetadata?.[field] ?? false;
            const managed = managedAgentOptionsFor(config).includes(field);
            const lockedHint = `${label} is managed internally by this task — the agent's prompt handles it.`;
            return (
              <MetadataToggleRow
                key={field}
                label={label}
                badge={managed && <span className="text-[10px] px-1 py-0.5 bg-gray-600/30 text-gray-400 rounded">managed</span>}
                description={managed ? lockedHint : description}
                enabled={enabled}
                disabled={updating}
                locked={managed}
                ariaLabel={managed ? `${label} (managed by task)` : `${enabled ? 'Disable' : 'Enable'} ${label.toLowerCase()}`}
                title={managed ? lockedHint : undefined}
                onToggle={() => runUpdate({ taskMetadata: toggleMetadataField(config.taskMetadata, field) })}
              />
            );
          })}
          <MetadataToggleRow
            label={STALL_NUDGE_OPTION.label}
            description={STALL_NUDGE_OPTION.description}
            enabled={stallNudgeEnabled}
            disabled={updating}
            ariaLabel={`${stallNudgeEnabled ? 'Disable' : 'Enable'} ${STALL_NUDGE_OPTION.label.toLowerCase()}`}
            onToggle={() => onMetadataChange('stallNudge', !stallNudgeEnabled)}
          />
        </div>
      </div>
    </TaskOverrides>
  );
}
