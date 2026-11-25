import CronInput from '../../../CronInput';
import CollapsibleSection from '../../../ui/CollapsibleSection';
import { FormField } from '../../../ui/FormField';
import { describeCron } from '../../../../utils/cronHelpers.js';
import { INTERVAL_DESCRIPTIONS, ON_DEMAND_PERPETUAL_LABEL, ON_DEMAND_PERPETUAL_DESCRIPTION } from './scheduleConstants';

// Interval Type select plus the cron editor that opens for a Scheduled task.
export default function TaskCadenceFields({ config, edit, updating }) {
  const { selectedType, cronEditing } = edit;
  return (
    <>
      <FormField label="Interval Type" labelClassName="text-sm text-gray-400 block mb-2">
        <select
          value={selectedType}
          onChange={(e) => edit.handleTypeChange(e.target.value)}
          disabled={updating}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
        >
          <option value="on-demand">{config.perpetual && config.autoStart !== false ? ON_DEMAND_PERPETUAL_LABEL : 'On Demand (manual trigger only)'}</option>
          <option value="cron">Scheduled (cron)</option>
        </select>
        {selectedType === 'on-demand' && (
          <p className="text-xs text-gray-500 mt-1">{config.perpetual && config.autoStart !== false ? ON_DEMAND_PERPETUAL_DESCRIPTION : INTERVAL_DESCRIPTIONS[selectedType]}</p>
        )}
      </FormField>

      {selectedType === 'cron' && (cronEditing || config.type === 'cron') && (
        <CollapsibleSection
          label="Edit schedule"
          summary={describeCron(config.cronExpression)}
          open={cronEditing}
          onOpenChange={(open) => {
            if (open || config.type === 'cron') edit.setCronEditing(open);
          }}
          size="bar"
          keepMounted
        >
          <CronInput
            value={config.cronExpression || '0 7 * * *'}
            onSave={edit.handleCronSave}
            onDirtyChange={edit.setCronDirty}
            onCancel={edit.handleCronCancel}
          />
        </CollapsibleSection>
      )}
    </>
  );
}
