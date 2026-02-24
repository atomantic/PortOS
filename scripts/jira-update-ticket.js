#!/usr/bin/env node
/**
 * CLI: Update a JIRA ticket using PortOS JIRA service
 *
 * Usage:
 *   node scripts/jira-update-ticket.js --app <appName> --ticket CONTECH-123 [options]
 *
 * Options:
 *   --app          App name (looks up JIRA config from apps.json)
 *   --ticket       Ticket key (e.g. CONTECH-4006) (required)
 *   --summary      Update ticket summary/title
 *   --description  Update ticket description
 *   --comment      Add a comment to the ticket
 *   --points       Update story points
 *   --assignee     Update assignee
 *   --labels       Update labels (comma-separated)
 *   --transition   Transition ticket status (name like "In Review", "Done", or numeric ID)
 *   --transitions  List available transitions for the ticket
 *   --delete       Delete the ticket
 *
 * Examples:
 *   node scripts/jira-update-ticket.js --app grace --ticket CONTECH-4006 --summary "New title"
 *   node scripts/jira-update-ticket.js --app grace --ticket CONTECH-4006 --comment "tone is actually used"
 *   node scripts/jira-update-ticket.js --app grace --ticket CONTECH-4006 --transitions
 *   node scripts/jira-update-ticket.js --app grace --ticket CONTECH-4006 --transition "Done"
 *   node scripts/jira-update-ticket.js --app grace --ticket CONTECH-4006 --delete
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
  const parsed = {};

  for (let i = 0; i < args.length; i++) {
    const requireValue = (flag) => {
      if (i + 1 >= args.length) {
        console.error(`❌ Missing value for ${flag}`);
        process.exit(1);
      }
      return args[++i];
    };
    switch (args[i]) {
      case '--app': parsed.app = requireValue('--app'); break;
      case '--ticket': parsed.ticket = requireValue('--ticket'); break;
      case '--summary': parsed.summary = requireValue('--summary'); break;
      case '--description': parsed.description = requireValue('--description'); break;
      case '--comment': parsed.comment = requireValue('--comment'); break;
      case '--points': parsed.points = parseInt(requireValue('--points'), 10) || undefined; break;
      case '--assignee': parsed.assignee = requireValue('--assignee'); break;
      case '--labels': parsed.labels = requireValue('--labels').split(',').map(l => l.trim()); break;
      case '--transition': parsed.transition = requireValue('--transition'); break;
      case '--transitions': parsed.listTransitions = true; break;
      case '--delete': parsed.delete = true; break;
      case '--help': case '-h':
        console.log(`Usage: node scripts/jira-update-ticket.js --app <name> --ticket <key> [options]
  --app          App name (required, looks up JIRA config)
  --ticket       Ticket key, e.g. CONTECH-4006 (required)
  --summary      Update ticket title
  --description  Update ticket description
  --comment      Add a comment to the ticket
  --points       Update story points
  --assignee     Update assignee
  --labels       Update labels (comma-separated)
  --transition   Move ticket to status (name like "Done" or numeric ID)
  --transitions  List available transitions for the ticket
  --delete       Delete the ticket`);
        process.exit(0);
    }
  }
  return parsed;
}

async function loadAppConfig(appName) {
  const appsFile = join(rootDir, 'data/apps.json');
  const content = await fs.readFile(appsFile, 'utf-8');
  const { safeJSONParse } = await import(join(rootDir, 'server/lib/fileUtils.js'));
  const data = safeJSONParse(content, {});
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

async function main() {
  const args = parseArgs();

  if (!args.app || !args.ticket) {
    console.error('❌ --app and --ticket are required. Use --help for usage.');
    process.exit(1);
  }

  const app = await loadAppConfig(args.app);
  const jira = app.jira;

  // List available transitions
  if (args.listTransitions) {
    const transitions = await jiraService.getTransitions(jira.instanceId, args.ticket);
    console.log(`📋 Available transitions for ${args.ticket}:`);
    for (const t of transitions) {
      console.log(`  ${t.id} → ${t.name}${t.to ? ` (to: ${t.to})` : ''}`);
    }
    return;
  }

  // Delete ticket
  if (args.delete) {
    console.log(`🗑️  Deleting ${args.ticket}...`);
    await jiraService.deleteTicket(jira.instanceId, args.ticket);
    console.log(`✅ ${args.ticket} deleted`);
    return;
  }

  const fieldIds = {
    storyPoints: 'customfield_10106',
  };

  // Build fields update payload
  const fields = {};
  if (args.summary) fields.summary = args.summary;
  if (args.description) fields.description = args.description;
  if (args.assignee) fields.assignee = { name: args.assignee };
  if (args.labels) fields.labels = args.labels;
  if (args.points) fields[fieldIds.storyPoints] = args.points;

  const hasFieldUpdates = Object.keys(fields).length > 0;
  const hasComment = !!args.comment;
  const hasTransition = !!args.transition;

  if (!hasFieldUpdates && !hasComment && !hasTransition) {
    console.error('❌ Nothing to update. Provide at least one of: --summary, --description, --comment, --points, --assignee, --labels, --transition, --delete, --transitions');
    process.exit(1);
  }

  // Update fields
  if (hasFieldUpdates) {
    const updatedFields = Object.keys(fields).join(', ');
    console.log(`✏️  Updating ${args.ticket} (${updatedFields})...`);
    const result = await jiraService.updateTicket(jira.instanceId, args.ticket, fields);
    console.log(`✅ ${result.ticketId} updated — ${result.url}`);
  }

  // Add comment
  if (hasComment) {
    console.log(`💬 Adding comment to ${args.ticket}...`);
    await jiraService.addComment(jira.instanceId, args.ticket, args.comment);
    console.log(`✅ Comment added to ${args.ticket}`);
  }

  // Transition ticket
  if (hasTransition) {
    // Resolve transition by name or use as numeric ID
    let transitionId = args.transition;
    if (!/^\d+$/.test(transitionId)) {
      const transitions = await jiraService.getTransitions(jira.instanceId, args.ticket);
      const match = transitions.find(t => t.name.toLowerCase() === transitionId.toLowerCase());
      if (!match) {
        const available = transitions.map(t => `"${t.name}" (${t.id})`).join(', ');
        console.error(`❌ Transition "${transitionId}" not found. Available: ${available}`);
        process.exit(1);
      }
      transitionId = match.id;
    }
    console.log(`🔄 Transitioning ${args.ticket} → ${args.transition}...`);
    await jiraService.transitionTicket(jira.instanceId, args.ticket, transitionId);
    console.log(`✅ ${args.ticket} transitioned to ${args.transition}`);
  }
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
