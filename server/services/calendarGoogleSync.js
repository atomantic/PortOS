import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { getAccount, updateSyncStatus, updateSubcalendars, mergeDiscoveredSubcalendars } from './calendarAccounts.js';
import { loadCache, saveCache } from './calendarSync.js';
import { safeJSONParse } from '../lib/fileUtils.js';

function md5(str) {
  return createHash('md5').update(str).digest('hex').slice(0, 12);
}

export function normalizeGoogleEvent(event, subcalendarId, subcalendarName) {
  const startDateTime = event.start?.dateTime;
  const startDate = event.start?.date;
  const endDateTime = event.end?.dateTime;
  const endDate = event.end?.date;
  const isAllDay = !startDateTime && !!startDate;

  return {
    id: uuidv4(),
    externalId: `gcal-${md5(event.id || uuidv4())}`,
    apiId: event.id || '',
    title: event.summary || '(No title)',
    description: event.description || '',
    location: event.location || '',
    startTime: startDateTime || (startDate ? `${startDate}T00:00:00` : null),
    endTime: endDateTime || (endDate ? `${endDate}T00:00:00` : null),
    isAllDay,
    isCancelled: event.status === 'cancelled',
    subcalendarId,
    subcalendarName,
    source: 'google-calendar',
    syncMethod: 'push',
    syncedAt: new Date().toISOString()
  };
}

export function getSyncDateRange(pastDays = 7, futureDays = 30) {
  const now = new Date();
  const pastDate = new Date(now);
  pastDate.setDate(pastDate.getDate() - pastDays);
  const futureDate = new Date(now);
  futureDate.setDate(futureDate.getDate() + futureDays);
  return { pastDate, futureDate };
}

export async function pushSyncEvents(accountId, calendarId, calendarName, rawEvents, io) {
  const account = await getAccount(accountId);
  if (!account) throw new Error('Account not found');

  const cache = await loadCache(accountId);
  const normalized = rawEvents.map(e => normalizeGoogleEvent(e, calendarId, calendarName));

  // Build map of existing events for this subcalendar
  const existingMap = new Map(
    cache.events
      .filter(e => e.externalId && e.subcalendarId === calendarId)
      .map(e => [e.externalId, e])
  );

  let newCount = 0;
  let updatedCount = 0;
  const incomingIds = new Set();

  for (const event of normalized) {
    incomingIds.add(event.externalId);
    if (existingMap.has(event.externalId)) {
      // Update mutable fields
      const existing = existingMap.get(event.externalId);
      existing.title = event.title;
      existing.description = event.description;
      existing.location = event.location;
      existing.startTime = event.startTime;
      existing.endTime = event.endTime;
      existing.isAllDay = event.isAllDay;
      existing.isCancelled = event.isCancelled;
      existing.syncedAt = event.syncedAt;
      updatedCount++;
    } else {
      cache.events.push(event);
      newCount++;
    }
  }

  // Prune events for this subcalendar that are no longer present
  const before = cache.events.length;
  cache.events = cache.events.filter(e =>
    e.subcalendarId !== calendarId || incomingIds.has(e.externalId)
  );
  const pruned = before - cache.events.length;

  await saveCache(accountId, cache);
  await updateSyncStatus(accountId, 'success');

  io?.emit('calendar:sync:completed', {
    accountId,
    calendarId,
    calendarName,
    newEvents: newCount,
    updated: updatedCount,
    pruned,
    status: 'success'
  });

  console.log(`📅 Google push sync for ${calendarName}: ${newCount} new, ${updatedCount} updated, ${pruned} pruned`);
  return { newEvents: newCount, updated: updatedCount, pruned, total: cache.events.length, status: 'success' };
}

const mcpSyncLock = new Map();

export async function mcpSyncAccount(accountId, io) {
  if (mcpSyncLock.has(accountId)) return { error: 'MCP sync already in progress', status: 409 };

  const account = await getAccount(accountId);
  if (!account) return { error: 'Account not found', status: 404 };
  if (account.type !== 'google-calendar') return { error: 'Not a Google Calendar account', status: 400 };

  const enabledCalendars = (account.subcalendars || []).filter(sc => sc.enabled && !sc.dormant);
  if (enabledCalendars.length === 0) return { error: 'No enabled subcalendars', status: 400 };

  mcpSyncLock.set(accountId, true);
  io?.emit('calendar:sync:started', { accountId, method: 'mcp' });
  console.log(`📅 Starting MCP sync for ${account.name} (${enabledCalendars.length} calendars)`);

  const { pastDate, futureDate } = getSyncDateRange();
  const timeMin = pastDate.toISOString();
  const timeMax = futureDate.toISOString();

  const calendarList = enabledCalendars.map(sc => `- Calendar: "${sc.name}", ID: "${sc.calendarId}"`).join('\n');

  const prompt = `You have access to Google Calendar MCP tools. Fetch events from the following calendars for the date range ${timeMin} to ${timeMax}.

${calendarList}

For EACH calendar, call gcal_list_events with the calendarId, timeMin, and timeMax. Use maxResults=250.

After fetching ALL calendars, output ONLY a single JSON object (no markdown fences, no explanation) with this exact structure:
{"calendars":[{"calendarId":"...","calendarName":"...","events":[...raw events from gcal_list_events response...]}]}

Include the full events arrays as returned by gcal_list_events. Output NOTHING else — just the JSON.`;

  const result = await runClaudeMcp(prompt, io, accountId).catch(err => {
    console.error(`❌ MCP sync failed for ${account.name}: ${err.message}`);
    return { error: err.message };
  });

  mcpSyncLock.delete(accountId);

  if (result.error) {
    io?.emit('calendar:sync:failed', { accountId, error: result.error, method: 'mcp' });
    await updateSyncStatus(accountId, 'error');
    return { error: result.error, status: 502 };
  }

  // Parse Claude's output and push events
  const parsed = parseCalendarJson(result.output);
  if (!parsed) {
    const errMsg = 'Failed to parse calendar data from Claude response';
    io?.emit('calendar:sync:failed', { accountId, error: errMsg, method: 'mcp' });
    await updateSyncStatus(accountId, 'error');
    console.error(`❌ ${errMsg}`);
    return { error: errMsg, status: 502 };
  }

  let totalNew = 0;
  let totalUpdated = 0;
  let totalPruned = 0;
  const results = [];

  for (const cal of parsed.calendars) {
    if (!cal.calendarId || !Array.isArray(cal.events)) continue;
    const syncResult = await pushSyncEvents(accountId, cal.calendarId, cal.calendarName || cal.calendarId, cal.events, null);
    totalNew += syncResult.newEvents;
    totalUpdated += syncResult.updated;
    totalPruned += syncResult.pruned;
    results.push({ calendarId: cal.calendarId, calendarName: cal.calendarName, ...syncResult });
  }

  await updateSyncStatus(accountId, 'success');
  io?.emit('calendar:sync:completed', { accountId, newEvents: totalNew, updated: totalUpdated, pruned: totalPruned, status: 'success', method: 'mcp' });
  console.log(`📅 MCP sync complete for ${account.name}: ${totalNew} new, ${totalUpdated} updated, ${totalPruned} pruned across ${results.length} calendars`);

  return { newEvents: totalNew, updated: totalUpdated, pruned: totalPruned, calendars: results, status: 'success' };
}

function parseCalendarJson(output) {
  // Try to extract JSON from Claude's response
  // Look for {"calendars":...} pattern
  const jsonMatch = output.match(/\{[\s\S]*"calendars"\s*:\s*\[[\s\S]*\]\s*\}/);
  if (jsonMatch) {
    const parsed = safeJSONParse(jsonMatch[0], null);
    if (parsed?.calendars) return parsed;
  }
  // Try parsing the entire output as JSON
  const parsed = safeJSONParse(output, null);
  if (parsed?.calendars) return parsed;
  return null;
}

export async function mcpDiscoverCalendars(accountId, io) {
  const account = await getAccount(accountId);
  if (!account) return { error: 'Account not found', status: 404 };
  if (account.type !== 'google-calendar') return { error: 'Not a Google Calendar account', status: 400 };

  console.log(`📅 Discovering Google calendars for ${account.name} via MCP`);
  io?.emit('calendar:sync:progress', { accountId, message: 'Discovering calendars via Claude...' });

  const prompt = `You have access to Google Calendar MCP tools. Call gcal_list_calendars to list all available calendars. If there are more pages (nextPageToken), fetch all pages.

Output ONLY a JSON array (no markdown fences, no explanation) of calendar objects with this structure:
[{"id":"...","name":"...","color":"..."}]

For each calendar, use:
- id: the calendar id field
- name: summaryOverride or summary
- color: backgroundColor

Output NOTHING else — just the JSON array.`;

  const result = await runClaudeMcp(prompt, io, accountId).catch(err => {
    console.error(`❌ Calendar discovery failed: ${err.message}`);
    return { error: err.message };
  });

  if (result.error) {
    return { error: result.error, status: 502 };
  }

  // Parse the calendar list from Claude's output
  const match = result.output.match(/\[[\s\S]*\]/);
  if (!match) return { error: 'Failed to parse calendar list from Claude response', status: 502 };

  const calendars = safeJSONParse(match[0], null);
  if (!Array.isArray(calendars)) return { error: 'Invalid calendar list format', status: 502 };

  // Merge with existing subcalendars (preserve enabled/dormant state)
  const merged = mergeDiscoveredSubcalendars(account.subcalendars, calendars);

  await updateSubcalendars(accountId, merged);

  console.log(`📅 Discovered ${calendars.length} calendars for ${account.name}`);
  return { calendars: merged, status: 'success' };
}

function runClaudeMcp(prompt, io, accountId) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '-', '--allowedTools', 'mcp__claude_ai_Google_Calendar__*'];
    const claudeProcess = spawn(process.env.CLAUDE_PATH || 'claude', args, {
      cwd: process.cwd(),
      shell: false,
      env: (() => { const e = { ...process.env }; delete e.CLAUDECODE; return e; })()
    });

    let output = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      claudeProcess.kill('SIGTERM');
      reject(new Error('MCP sync timed out after 5 minutes'));
    }, 300000);

    claudeProcess.stdin.write(prompt);
    claudeProcess.stdin.end();

    claudeProcess.stdout?.on('data', (data) => {
      output += data.toString();
    });

    claudeProcess.stderr?.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      // Emit progress for UI feedback
      if (text.includes('gcal_list_events')) {
        io?.emit('calendar:sync:progress', { accountId, message: 'Fetching calendar events...' });
      }
    });

    claudeProcess.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !output) {
        reject(new Error(stderr.slice(0, 500) || `Claude exited with code ${code}`));
      } else {
        resolve({ output: output.trim(), exitCode: code });
      }
    });

    claudeProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}
