/**
 * JIRA Status Report Service
 * Generates weekly status reports from JIRA for JIRA-enabled projects
 */

import { writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { getInstances, createJiraClient } from './jira.js';
import { getActiveApps } from './apps.js';
import { callProviderAISimple } from '../lib/aiProvider.js';
import { getActiveProvider, getAllProviders } from './providers.js';

const REPORTS_DIR = join(PATHS.data, 'jira-reports');

function mapIssue(issue, baseUrl) {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    statusCategory: issue.fields.status.statusCategory?.name,
    priority: issue.fields.priority?.name,
    issueType: issue.fields.issuetype?.name,
    assignee: issue.fields.assignee?.displayName || 'Unassigned',
    storyPoints: issue.fields.customfield_10106,
    updated: issue.fields.updated,
    url: `${baseUrl}/browse/${issue.key}`
  };
}

async function getSprintTickets(instance, projectKey) {
  const client = createJiraClient(instance);
  const jql = `project = "${projectKey}" AND assignee = currentUser() AND sprint in openSprints() ORDER BY status ASC, priority DESC, updated DESC`;

  const response = await client.get('/rest/api/2/search', {
    params: {
      jql,
      fields: 'summary,status,priority,issuetype,assignee,updated,created,customfield_10106,resolution',
      maxResults: 100
    }
  });

  return (response.data?.issues || []).map(issue => ({
    ...mapIssue(issue, instance.baseUrl),
    created: issue.fields.created,
    resolved: issue.fields.resolution?.name || null
  }));
}

async function getRecentlyCompleted(instance, projectKey) {
  const client = createJiraClient(instance);
  const jql = `project = "${projectKey}" AND assignee = currentUser() AND status changed to Done AFTER -7d ORDER BY updated DESC`;

  const response = await client.get('/rest/api/2/search', {
    params: {
      jql,
      fields: 'summary,status,priority,issuetype,assignee,updated,customfield_10106,resolutiondate',
      maxResults: 50
    }
  });

  return (response.data?.issues || []).map(issue => ({
    ...mapIssue(issue, instance.baseUrl),
    resolvedAt: issue.fields.resolutiondate
  }));
}

const TICKET_SUMMARY_FIELDS = ['key', 'summary', 'priority', 'assignee', 'storyPoints', 'url'];
function ticketSummary(ticket, extraFields = []) {
  const obj = {};
  for (const f of [...TICKET_SUMMARY_FIELDS, ...extraFields]) {
    if (ticket[f] !== undefined) obj[f] = ticket[f];
  }
  return obj;
}

/**
 * Generate a narrative status summary using AI.
 * Produces a human-readable summary suitable for status calls/emails,
 * with ticket keys inline so the UI can link them.
 * Falls back to a plain bullet list if AI is unavailable.
 */
async function generateNarrativeSummary(appName, completed, inProgress, blocked, todo) {
  const sections = [];
  if (completed.length > 0) {
    sections.push(`COMPLETED (last 7 days):\n${completed.map(t => `- ${t.key}: ${t.summary}`).join('\n')}`);
  }
  if (inProgress.length > 0) {
    sections.push(`IN PROGRESS:\n${inProgress.map(t => `- ${t.key}: ${t.summary}`).join('\n')}`);
  }
  if (blocked.length > 0) {
    sections.push(`BLOCKED:\n${blocked.map(t => `- ${t.key}: ${t.summary} [${t.status}]`).join('\n')}`);
  }
  if (todo.length > 0) {
    sections.push(`UP NEXT:\n${todo.slice(0, 10).map(t => `- ${t.key}: ${t.summary}`).join('\n')}`);
  }

  if (sections.length === 0) return '';

  const ticketData = sections.join('\n\n');

  // Collect candidate API providers (active first, then all others)
  const candidates = [];
  const [active, providersResult] = await Promise.all([
    getActiveProvider().catch(() => null),
    getAllProviders().catch(() => ({ providers: [] }))
  ]);
  if (active?.type === 'api') candidates.push(active);
  const allProviders = Array.isArray(providersResult) ? providersResult : (providersResult?.providers || []);
  for (const p of allProviders) {
    if (p.type === 'api' && !candidates.some(c => c.id === p.id)) candidates.push(p);
  }

  if (candidates.length === 0) {
    console.log('📊 No API provider available, using plain ticket list');
    return buildPlainSummary(completed, inProgress, blocked, todo);
  }

  const prompt = `You are writing a personal weekly status update for a status call or email about the ${appName} project. Given the JIRA tickets below, write a concise narrative summary organized into sections.

Rules:
- Use these exact section headers with markdown bold: **Completed:**, **In Progress:**, **Blocked:**, **Up Next:**
- Only include sections that have tickets
- Write each item as a bullet point (- ) that describes what was actually done or is being worked on in plain language
- Include the JIRA ticket key (e.g., PROJ-1234) at the end of each bullet in parentheses so it can be linked
- Combine related tickets into single bullets when they're clearly part of the same effort
- Be concise — this is for a quick status update, not a detailed report
- Write in first person plural ("we") or passive voice, not "I"
- Don't add commentary, intros, or sign-offs — just the bulleted sections

Tickets:
${ticketData}`;

  // Try each provider until one succeeds
  for (const provider of candidates) {
    const aiResult = await callProviderAISimple(provider, provider.lightModel || provider.defaultModel, prompt, {
      temperature: 0.3,
      max_tokens: 1500
    }).catch(err => ({ error: err.message }));

    if (!aiResult.error) return aiResult.text.trim();
    console.log(`📊 Provider ${provider.id} failed: ${aiResult.error}`);
  }

  console.log('📊 All API providers failed, using plain ticket list');
  return buildPlainSummary(completed, inProgress, blocked, todo);
}

function buildPlainSummary(completed, inProgress, blocked, todo) {
  const lines = [];
  if (completed.length > 0) {
    lines.push('**Completed:**');
    for (const t of completed) lines.push(`- ${t.summary} (${t.key})`);
  }
  if (inProgress.length > 0) {
    lines.push('', '**In Progress:**');
    for (const t of inProgress) lines.push(`- ${t.summary} (${t.key})`);
  }
  if (blocked.length > 0) {
    lines.push('', '**Blocked:**');
    for (const t of blocked) lines.push(`- ${t.summary} [${t.status}] (${t.key})`);
  }
  if (todo.length > 0) {
    lines.push('', '**Up Next:**');
    for (const t of todo.slice(0, 10)) lines.push(`- ${t.summary} (${t.key})`);
    if (todo.length > 10) lines.push(`- ...and ${todo.length - 10} more`);
  }
  return lines.join('\n');
}

/**
 * Generate a status report for a single app
 */
export async function generateReport(appId, app) {
  const jiraConfig = app.jira;
  if (!jiraConfig?.enabled || !jiraConfig.instanceId || !jiraConfig.projectKey) {
    return null;
  }

  const config = await getInstances();
  const instance = config.instances[jiraConfig.instanceId];
  if (!instance) {
    console.error(`❌ JIRA instance ${jiraConfig.instanceId} not found for app ${appId}`);
    return null;
  }

  const [sprintTickets, recentlyCompleted] = await Promise.all([
    getSprintTickets(instance, jiraConfig.projectKey),
    getRecentlyCompleted(instance, jiraConfig.projectKey)
  ]);

  const todo = sprintTickets.filter(t => t.statusCategory === 'To Do');
  const inProgress = sprintTickets.filter(t => t.statusCategory === 'In Progress');
  const done = sprintTickets.filter(t => t.statusCategory === 'Done');

  const totalPoints = sprintTickets.reduce((sum, t) => sum + (t.storyPoints || 0), 0);
  const completedPoints = done.reduce((sum, t) => sum + (t.storyPoints || 0), 0);
  const inProgressPoints = inProgress.reduce((sum, t) => sum + (t.storyPoints || 0), 0);

  // Generate AI-powered narrative status summary
  const blocked = sprintTickets.filter(t =>
    t.status?.toLowerCase().includes('block') ||
    (t.priority === 'Highest' && t.statusCategory === 'To Do')
  );
  const statusSummary = await generateNarrativeSummary(app.name, recentlyCompleted, inProgress, blocked, todo);

  const report = {
    appId,
    appName: app.name,
    projectKey: jiraConfig.projectKey,
    instanceId: jiraConfig.instanceId,
    generatedAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0],
    statusSummary,
    summary: {
      totalTickets: sprintTickets.length,
      todo: todo.length,
      inProgress: inProgress.length,
      done: done.length,
      totalPoints,
      completedPoints,
      inProgressPoints,
      remainingPoints: totalPoints - completedPoints,
      completionRate: sprintTickets.length > 0
        ? Math.round((done.length / sprintTickets.length) * 100)
        : 0,
      recentlyCompletedCount: recentlyCompleted.length
    },
    tickets: {
      todo: todo.map(t => ticketSummary(t)),
      inProgress: inProgress.map(t => ticketSummary(t)),
      done: done.map(t => ticketSummary(t)),
      recentlyCompleted: recentlyCompleted.map(t => ticketSummary(t, ['resolvedAt']))
    }
  };

  await ensureDir(REPORTS_DIR);
  const filename = `${appId}-${report.date}.json`;
  await writeFile(join(REPORTS_DIR, filename), JSON.stringify(report, null, 2));
  console.log(`📊 JIRA status report generated for ${app.name} (${jiraConfig.projectKey})`);

  return report;
}

/**
 * Generate status reports for all JIRA-enabled apps
 */
export async function generateAllReports() {
  const apps = await getActiveApps();
  const jiraApps = apps.filter(app => app.jira?.enabled && app.jira?.instanceId && app.jira?.projectKey);

  if (jiraApps.length === 0) {
    console.log(`📊 No JIRA-enabled apps found for status report generation`);
    return [];
  }

  const results = await Promise.allSettled(
    jiraApps.map(app => generateReport(app.id, app))
  );
  const reports = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  console.log(`📊 Generated ${reports.length} JIRA status reports`);
  return reports;
}

/**
 * Get a stored report by app and date
 */
export async function getReport(appId, date) {
  const filename = `${appId}-${date}.json`;
  const filepath = join(REPORTS_DIR, filename);
  return readJSONFile(filepath, null);
}

/**
 * List all reports, optionally filtered by appId.
 * Returns summary data from each report for display in lists.
 */
export async function listReports(appId = null) {
  await ensureDir(REPORTS_DIR);
  const files = await readdir(REPORTS_DIR);

  const entries = files
    .filter(f => f.endsWith('.json'))
    .filter(f => !appId || f.startsWith(`${appId}-`))
    .map(f => {
      const parts = f.replace('.json', '').split('-');
      const date = parts.slice(-3).join('-');
      const app = parts.slice(0, -3).join('-');
      return { appId: app, date, filename: f };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  const results = await Promise.all(
    entries.map(async entry => {
      const filepath = join(REPORTS_DIR, entry.filename);
      const report = await readJSONFile(filepath, null);
      if (!report) return null;
      return {
        appId: entry.appId,
        date: entry.date,
        appName: report.appName,
        projectKey: report.projectKey,
        generatedAt: report.generatedAt,
        summary: report.summary
      };
    })
  );

  return results.filter(Boolean);
}

/**
 * Get the latest report for an app
 */
export async function getLatestReport(appId) {
  await ensureDir(REPORTS_DIR);
  const files = await readdir(REPORTS_DIR);

  const matching = files
    .filter(f => f.endsWith('.json') && f.startsWith(`${appId}-`))
    .sort()
    .reverse();

  if (matching.length === 0) return null;
  const filepath = join(REPORTS_DIR, matching[0]);
  return readJSONFile(filepath, null);
}
