/**
 * Managed-app workspace lookup and JIRA ticket prompt support.
 */

import { join } from 'path';
import { PATHS, readJSONFile, expandHome } from '../../lib/fileUtils.js';
import { runPromptThroughProvider } from '../promptRunner.js';
import { getActiveProvider } from '../providers.js';
import * as jiraService from '../jira.js';
import { emitLog } from '../cosEvents.js';

const ROOT_DIR = PATHS.root;

/**
 * Get the workspace path for an app, or `null` when it can't be resolved.
 *
 * This used to substitute the PortOS repo root for every failure — registry
 * missing, app not found, app carrying no `repoPath` — which made an
 * unresolvable app indistinguishable from a working one: the agent quietly
 * wrote its files into the PortOS checkout and nothing said otherwise
 * (issue #3180). A downstream existence check can't recover that case either,
 * because the substituted root is a real directory.
 *
 * So this returns an explicit `null` sentinel and lets each caller decide
 * whether "no workspace" is legal for it (per the sentinel-and-validate rule in
 * AGENTS.md — absent must not collapse into a valid-looking value). The reason
 * is logged here, where it's known.
 *
 * @returns {Promise<string|null>} the app's repoPath, or null if unresolvable
 */
export async function getAppWorkspace(appName) {
  const appsFile = join(ROOT_DIR, 'data/apps.json');
  const unresolved = (why) => { console.warn(`⚠️ ${why} — no agent workspace resolved`); return null; };

  const data = await readJSONFile(appsFile, null);
  if (!data) return unresolved(`No apps registry at ${appsFile}`);

  // Handle both object format { apps: { id: {...} } } and array format [...]
  const apps = data.apps || data;

  const app = Array.isArray(apps)
    ? apps.find(a => a.name === appName || a.id === appName)
    // Object format - keys are app IDs
    : (apps[appName] || Object.values(apps).find(a => a.name === appName));

  if (!app) return unresolved(`App '${appName}' not found in apps registry`);
  if (!app.repoPath) return unresolved(`App '${appName}' has no repoPath`);
  // Expand here, not just at the spawn boundary. Callers do more with this than
  // spawn into it: agentLifecycle persists it as an agent's `sourceWorkspace`,
  // and the worktree cleanup/merge paths later hand that value to a child
  // process as its cwd. Node never shell-expands `~`, so returning the raw
  // tilde form would let a task start (the spawn path expands) and then strand
  // its worktree and branch when cleanup runs against a path that doesn't exist.
  return expandHome(app.repoPath);
}

/**
 * Get full app data for a task (including jira config).
 * Returns the app object or null if not found.
 */
export async function getAppDataForTask(task) {
  const appName = task?.metadata?.app;
  if (!appName) return null;

  const appsFile = join(ROOT_DIR, 'data/apps.json');
  const data = await readJSONFile(appsFile, null);
  if (!data) return null;

  const apps = data.apps || data;

  if (Array.isArray(apps)) {
    return apps.find(a => a.name === appName || a.id === appName) || null;
  }

  return apps[appName] || Object.values(apps).find(a => a.name === appName) || null;
}

/**
 * Generate a concise JIRA ticket title from a task description using AI.
 * Falls back to truncated description on failure.
 */
export async function generateJiraTitle(description) {
  const fallback = `[CoS] ${(description || 'Automated task').substring(0, 120)}`;

  const provider = await getActiveProvider().catch(() => null);
  if (!provider) return fallback;

  const model = provider.defaultModel || provider.models?.[0];
  if (!model) return fallback;

  const prompt = `Generate a concise JIRA ticket title (max 80 chars) for this task. Output ONLY the title text, nothing else.\n\nTask: ${description}`;

  // Best-effort title — failures are non-fatal (the task still gets the
  // truncated-description fallback). 30s is the legacy cap; titles should
  // be near-instant, and a slow model shouldn't block task creation.
  const result = await runPromptThroughProvider({
    provider, prompt, source: 'jira-title', model, timeout: 30000,
  }).catch(err => {
    console.warn(`⚠️ JIRA title generation failed: ${err.message}`);
    return null;
  });
  if (!result) return fallback;

  const title = (result.text || '').trim().replace(/^["']|["']$/g, '');
  return title || fallback;
}

/**
 * Create a JIRA ticket for a task if the app has JIRA integration enabled.
 * Non-blocking — returns null on failure.
 * @returns {Promise<{ticketId: string, ticketUrl: string, summary: string}|null>}
 */
export async function createJiraTicketForTask(task, app) {
  const jira = app?.jira;
  if (!jira?.enabled || !jira.instanceId || !jira.projectKey) return null;

  const summary = await generateJiraTitle(task.description);
  const description = [
    `Automated task created by PortOS Chief of Staff.`,
    ``,
    `*Task ID:* ${task.id}`,
    `*Priority:* ${task.priority || 'MEDIUM'}`,
    `*App:* ${app.name || task.metadata?.app || 'unknown'}`,
    ``,
    `{quote}`,
    task.description || '',
    `{quote}`
  ].join('\n');

  const result = await jiraService.createTicket(jira.instanceId, {
    projectKey: jira.projectKey,
    summary,
    description,
    issueType: jira.issueType || 'Task',
    labels: jira.labels || [],
    assignee: jira.assignee,
    epicKey: jira.epicKey
  }).catch(err => {
    emitLog('warn', `Failed to create JIRA ticket: ${err.message}`, { taskId: task.id, app: app.name });
    return null;
  });

  if (!result?.ticketId) return null;

  emitLog('success', `Created JIRA ticket ${result.ticketId}`, {
    taskId: task.id,
    ticketId: result.ticketId,
    ticketUrl: result.url
  });

  return { ticketId: result.ticketId, ticketUrl: result.url, summary };
}
