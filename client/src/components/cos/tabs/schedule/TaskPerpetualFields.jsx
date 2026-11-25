import CronInput from '../../../CronInput';
import ToggleSwitch from '../../../ToggleSwitch';
import InfoTooltip from '../../../ui/InfoTooltip';
import { PERPETUAL_DESCRIPTION } from './scheduleConstants';

// Perpetual toggle, its automatic-start switch and the recheck cadence.
export default function TaskPerpetualFields({ config, edit, updating }) {
  const { selectedType, rechecksOnDemand, recheckEditing } = edit;
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-400">Perpetual</span>
          <InfoTooltip label="What does Perpetual do?">
            {PERPETUAL_DESCRIPTION}. It applies to either cadence: an On-Demand
            perpetual task starts manually when automatic starts are off, and a Scheduled
            one starts its drain on the cron slot and rechecks on the same schedule.
          </InfoTooltip>
        </div>
        <ToggleSwitch
          enabled={!!config.perpetual}
          onChange={edit.handlePerpetualToggle}
          disabled={updating}
          ariaLabel={config.perpetual ? 'Disable perpetual drain' : 'Enable perpetual drain'}
        />
      </div>

      {config.perpetual && selectedType === 'cron' && (
        <p className="text-xs text-gray-500">
          Each cron slot starts a drain that runs back-to-back while actionable work remains;
          once it parks, the same schedule gates the next attempt.
        </p>
      )}

      {config.perpetual && selectedType === 'on-demand' && (
        <label className="flex items-center justify-between gap-3 text-sm text-gray-400">
          Automatic starts and rechecks
          <input type="checkbox" checked={config.autoStart !== false} disabled={updating}
            onChange={event => edit.handleAutoStartChange(event.target.checked)} />
        </label>
      )}
      {config.perpetual && selectedType === 'on-demand' && config.autoStart === false && (
        <p className="text-xs text-gray-500">Run Now starts a drain until no actionable work remains. No timer starts or resumes it.</p>
      )}

      {rechecksOnDemand && (
        <div>
          <span className="text-sm text-gray-400 block mb-2">Recheck Cadence</span>
          {(recheckEditing || config.recheckCron) ? (
            <CronInput
              value={config.recheckCron || '0 9 * * *'}
              onDirtyChange={edit.setRecheckDirty}
              onSave={edit.handleRecheckCronSave}
              onCancel={() => edit.setRecheckEditing(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => edit.setRecheckEditing(true)}
              disabled={updating}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-left text-sm text-gray-300 hover:border-gray-500"
            >
              Daily (default) — click to set a custom recheck schedule
            </button>
          )}
          {config.recheckCron && (
            <button
              type="button"
              onClick={edit.handleRecheckReset}
              disabled={updating}
              className="mt-2 inline-flex min-h-[44px] items-center rounded border border-port-border px-3 py-2 text-sm text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50"
            >
              Use the default daily recheck
            </button>
          )}
          <p className="text-xs text-gray-500 mt-1">
            Runs back-to-back while actionable work remains, then parks and re-probes on this schedule.
            The check is programmatic (no LLM) — e.g. claim-issue counts open, claimable issues; an issue
            the agent tags <code>needs-input</code> is excluded so the drain converges.
          </p>
        </div>
      )}
    </>
  );
}
