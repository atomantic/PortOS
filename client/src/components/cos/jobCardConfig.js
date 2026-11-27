import { ON_DEMAND_INTERVAL } from '../../utils/cronHelpers';
import { normalizeJobSchedule } from './JobScheduleFields';

export const JOB_TYPE_OPTIONS = [
  { value: 'agent', label: 'AI Agent' },
  { value: 'shell', label: 'Shell Command' }
];

// App scope, provider/model override, and prompt template only apply to
// AI-agent jobs — shell/script jobs run a fixed command and never reach the
// AI runner.
export const isAgentJobType = (type) => type !== 'shell' && type !== 'script';

// Interval-mode job with the no-recurrence cadence: never due, never scheduled,
// runnable only from the Run-now button. Cron mode overrides it — a job switched
// to Cron keeps whatever cadence it last had. Mirrors isOnDemandJob on the server.
export const isOnDemandSchedule = (job) =>
  !job?.cronExpression && !job?.cronSchedule && job?.interval === ON_DEMAND_INTERVAL;

export const BRIEFING_CONFIG_OPTIONS = [
  { key: 'dailyJoke', label: 'Daily Joke', desc: 'Include a short joke to start the day' },
  { key: 'dailyQuote', label: 'Daily Quote', desc: 'Include an inspirational quote related to focus areas' },
  { key: 'dailyImage', label: 'Daily Image', desc: 'Generate an image via Stable Diffusion (requires image gen API)' }
];

export function normalizeJobPayload(formData) {
  const payload = { ...formData };
  if (isAgentJobType(payload.type)) {
    payload.command = null;
    payload.triggerAction = null;
  } else {
    // App scope only applies to AI-agent jobs (the scope drives the agent's
    // workspace). Shell/script jobs always run in the PortOS root, so clear any
    // appId left over from when the job was an agent type — otherwise the saved
    // job shows a misleading app badge while executing in root.
    payload.appId = null;
    // Provider/model/effort overrides only apply to AI-agent jobs — clear any
    // leftover selection so a shell/script job doesn't carry a misleading AI badge.
    payload.providerId = null;
    payload.model = null;
    payload.effort = null;
    if (payload.executionOptions !== undefined) payload.executionOptions = {};
    payload.dataInputs = [];
    // The configuration form exists to parameterize a PROMPT. A shell/script job
    // has none, so its values would reach nothing — clear them rather than leave
    // a saved job advertising knobs that do nothing.
    payload.formFields = [];
    payload.formValues = {};
  }
  // Empty app picker selection ('') → null so a PUT actively un-scopes the job
  // back to global (undefined would be dropped from JSON and updateJob would
  // preserve the old scope). The schema maps '' → null too; sending null directly
  // is unambiguous across create and update.
  if (!payload.appId) payload.appId = null;
  return normalizeJobSchedule(payload);
}
