/**
 * Toast wording for a resume/relaunch result, shared by the two dialogs that
 * dispatch one — Resume (`cos/tabs/AgentsTab.jsx`) and Relaunch
 * (`cos/tabs/RelaunchAgentModal.jsx`).
 *
 * The server (`resumeAgent` in `server/services/agentManagement.js`) answers with a
 * `mode` naming what it did to the task, plus `spawned` / `spawnHold` saying
 * whether it also STARTED it: a resumed task is force-spawned when an agent slot is
 * free, so `requeued` usually means running, not waiting. Two ways to get that
 * wrong, and both surfaces can get them wrong identically — hence one helper:
 * saying "queued" for a run that already started reads as the click not having
 * taken, and saying "queued" with no reason sends the user hunting the task list
 * for why it didn't start.
 *
 * `messages` is keyed by mode, each entry `{ queued, running? }`. A mode with no
 * `running` variant is one that deliberately queues NOTHING (`already-active`,
 * `superseded`), so it can never be reported as started. `fallback` covers a mode
 * this build has no wording for — an unmapped mode must never fall through to a
 * message claiming work was queued.
 */
export function agentResumeMessage(result, messages, fallback) {
  const entry = messages[result?.mode];
  const base = (result?.spawned && entry?.running) || entry?.queued || fallback;
  return result?.spawnHold ? `${base} — ${result.spawnHold}` : base;
}
