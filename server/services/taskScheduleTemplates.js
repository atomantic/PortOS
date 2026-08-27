/** User-defined task templates stored with the task schedule. */

import { emitLog } from './cosEvents.js';
import { loadSchedule, updateSchedule } from './taskScheduleStore.js';

// ============================================================
// Templates
// ============================================================

export async function addTemplateTask(template) {
  const newTemplate = await updateSchedule(async (schedule) => {
    const newTemplate = {
      id: `template-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      name: template.name,
      description: template.description,
      category: template.category || 'custom',
      taskType: template.taskType,
      priority: template.priority || 'MEDIUM',
      metadata: template.metadata || {}
    };

    schedule.templates.push(newTemplate);
    return { result: newTemplate, changed: true };
  });

  emitLog('info', `Added template task: ${newTemplate.name}`, { templateId: newTemplate.id }, '📅 TaskSchedule');
  return newTemplate;
}
export async function getTemplateTasks() {
  const schedule = await loadSchedule();
  return schedule.templates;
}

export async function deleteTemplateTask(templateId) {
  const result = await updateSchedule(async (schedule) => {
    const index = schedule.templates.findIndex(t => t.id === templateId);

    if (index === -1) {
      return { result: { error: 'Template not found' }, changed: false };
    }

    const deleted = schedule.templates.splice(index, 1)[0];
    return { result: { deleted }, changed: true };
  });

  if (result.error) return result;

  emitLog('info', `Deleted template task: ${result.deleted.name}`, { templateId }, '📅 TaskSchedule');
  return { success: true, deleted: result.deleted };
}
