#!/usr/bin/env node
/**
 * CLI: Create a JIRA ticket using PortOS JIRA service
 *
 * Usage:
 *   node scripts/jira-create-ticket.js --app <appName> --summary "Title" [options]
 *
 * Options:
 *   --app          App name (looks up JIRA config from apps.json)
 *   --summary      Ticket summary/title (required)
 *   --description  Ticket description (defaults to summary)
 *   --type         Issue type: Task, Bug, Story, Spike (default: from app config or Task)
 *   --points       Story points (default: 1)
 *   --sprint       Use current active sprint (default: true)
 *   --no-sprint    Skip sprint assignment
 *   --epic         Override epic key (default: from app config)
 *   --assignee     Override assignee (default: from app config)
 *
 * Example:
 *   node scripts/jira-create-ticket.js --app portos --summary "Research MXF video" --points 1
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Import services directly
const jiraService = await import(join(rootDir, 'server/services/jira.js'));

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { sprint: true, points: 1 };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--app': parsed.app = args[++i]; break;
      case '--summary': parsed.summary = args[++i]; break;
      case '--description': parsed.description = args[++i]; break;
      case '--type': parsed.type = args[++i]; break;
      case '--points': parsed.points = parseInt(args[++i]) || 1; break;
      case '--sprint': parsed.sprint = true; break;
      case '--no-sprint': parsed.sprint = false; break;
      case '--epic': parsed.epic = args[++i]; break;
      case '--assignee': parsed.assignee = args[++i]; break;
      case '--help': case '-h':
        console.log(`Usage: node scripts/jira-create-ticket.js --app <name> --summary "Title" [options]
  --app          App name (required, looks up JIRA config)
  --summary      Ticket title (required)
  --description  Ticket description
  --type         Issue type (Task, Bug, Story, Spike)
  --points       Story points (default: 1)
  --no-sprint    Skip sprint assignment
  --epic         Override epic key
  --assignee     Override assignee`);
        process.exit(0);
    }
  }
  return parsed;
}

async function loadAppConfig(appName) {
  const appsFile = join(rootDir, 'data/apps.json');
  const content = await fs.readFile(appsFile, 'utf-8');
  const data = JSON.parse(content);
  const apps = Object.values(data.apps || data);

  const app = apps.find(a => a.name?.toLowerCase() === appName.toLowerCase());
  if (!app) {
    const names = apps.filter(a => a.name).map(a => a.name).join(', ');
    console.error(`❌ App "${appName}" not found. Available apps: ${names}`);
    process.exit(1);
  }

  if (!app.jira?.enabled) {
    console.error(`❌ JIRA integration not enabled for app "${appName}"`);
    process.exit(1);
  }

  return app;
}

async function getActiveSprintId(instanceId, boardId) {
  if (!boardId) return null;

  const sprints = await jiraService.getActiveSprints(instanceId, boardId);
  if (!sprints.length) {
    console.log('⚠️  No active sprints found');
    return null;
  }

  // Prefer sprint with "Sprint NN" name pattern (not ProServe etc.)
  const castSprint = sprints.find(s => /^Sprint \d+/.test(s.name));
  const sprint = castSprint || sprints[0];
  console.log(`📋 Sprint: ${sprint.name} (id: ${sprint.id})`);
  return sprint.id;
}

async function main() {
  const args = parseArgs();

  if (!args.app || !args.summary) {
    console.error('❌ --app and --summary are required. Use --help for usage.');
    process.exit(1);
  }

  const app = await loadAppConfig(args.app);
  const jira = app.jira;

  // Resolve sprint ID if needed
  let sprintId = null;
  if (args.sprint && jira.boardId) {
    sprintId = await getActiveSprintId(jira.instanceId, jira.boardId);
  }

  const ticketData = {
    projectKey: jira.projectKey,
    summary: args.summary,
    description: args.description || args.summary,
    issueType: args.type || jira.issueType || 'Task',
    assignee: args.assignee || jira.assignee || undefined,
    storyPoints: args.points,
    epicKey: args.epic || jira.epicKey || undefined,
    labels: jira.labels || [],
    sprint: sprintId || undefined
  };

  console.log(`🎫 Creating ${ticketData.issueType} in ${ticketData.projectKey}...`);

  const result = await jiraService.createTicket(jira.instanceId, ticketData);

  console.log(`✅ ${result.ticketId}`);
  console.log(`🔗 ${result.url}`);

  // Output JSON for programmatic use
  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
