import { useEffect, useState } from 'react';

// Edit state and write handlers for a task type's own schedule (pause, cadence,
// perpetual, recheck). Shared by the Schedule drawer and the Workflow timeline
// editor so both write the same fields with the same rules. `runUpdate(patch)`
// persists one patch and resolves `false` (or rejects) when the save failed.
export default function useTaskScheduleEdit({ config, runUpdate }) {
  const [selectedType, setSelectedType] = useState(config.type);
  const [cronEditing, setCronEditing] = useState(false);
  const [recheckEditing, setRecheckEditing] = useState(false);
  const [cronDirty, setCronDirty] = useState(false);
  const [recheckDirty, setRecheckDirty] = useState(false);

  useEffect(() => {
    setSelectedType(config.type);
  }, [config.type]);

  const handleTypeChange = async (newType) => {
    if (newType === 'cron') {
      // Open the editor rather than saving: the cadence isn't chosen until an
      // expression is committed (handleCronSave writes both fields together).
      setCronEditing(true);
      setSelectedType('cron');
      return;
    }
    setCronEditing(false);
    setSelectedType(newType);
    const ok = await runUpdate({ type: newType, cronExpression: null, autoStart: false }).catch(() => false);
    if (ok === false) setSelectedType(config.type);
  };

  // Perpetual is orthogonal to the cadence — toggling it never touches `type`,
  // so a Scheduled task keeps its expression and an On-Demand one stays manual.
  // No local optimistic state to roll back, so this awaits bare like
  // handleToggleEnabled rather than attaching its own rejection handler.
  const handlePerpetualToggle = () => runUpdate({
    perpetual: !config.perpetual,
    ...(config.type === 'on-demand' && !config.perpetual ? { autoStart: config.autoStart ?? false } : {}),
  });

  const handleAutoStartChange = (autoStart) => runUpdate({ autoStart }).catch(() => {});

  const handleCronSave = async (expr) => {
    const ok = await runUpdate({ type: 'cron', cronExpression: expr }).catch(() => false);
    if (ok !== false) setCronEditing(false);
  };

  const handleCronCancel = () => {
    setCronEditing(false);
    setSelectedType(config.type);
  };

  const handleRecheckCronSave = async (expr) => {
    const ok = await runUpdate({ recheckCron: expr }).catch(() => false);
    if (ok !== false) setRecheckEditing(false);
  };

  // recheckCron has no empty CronInput state, so "back to the default
  // interval-based recheck" is its own action (null clears the override).
  const handleRecheckReset = async () => {
    const ok = await runUpdate({ recheckCron: null }).catch(() => false);
    if (ok !== false) setRecheckEditing(false);
  };

  const isPaused = !config.enabled;
  const handleToggleEnabled = () => runUpdate({ enabled: isPaused });

  return {
    selectedType,
    cronEditing,
    setCronEditing,
    setCronDirty,
    recheckEditing,
    setRecheckEditing,
    setRecheckDirty,
    isPaused,
    rechecksOnDemand: config.perpetual && selectedType === 'on-demand' && config.autoStart !== false,
    hasUnsavedSchedule: selectedType !== config.type || cronDirty || recheckDirty,
    handleTypeChange,
    handlePerpetualToggle,
    handleAutoStartChange,
    handleCronSave,
    handleCronCancel,
    handleRecheckCronSave,
    handleRecheckReset,
    handleToggleEnabled,
  };
}
