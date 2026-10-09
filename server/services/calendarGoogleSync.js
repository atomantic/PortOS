import { v4 as uuidv4 } from '../lib/uuid.js';
import { createHash } from 'crypto';
import { getAccount, updateSyncStatus, updateSubcalendars, mergeDiscoveredSubcalendars } from './calendarAccounts.js';
import { mutateCache, logCalendarTouchpoints, recordCalendarActivity } from './calendarSync.js';
import { getAllProviders } from './providers.js';
import { getSettings } from './settings.js';
import { pickCliProvider, runCliProviderPrompt } from '../lib/cliProviderRun.js';
import { extractJson } from '../lib/jsonExtract.js';
import { selectMeetingUrl } from '../lib/meetingUrl.js';
import { ServerError } from '../lib/errorHandler.js';

// Google Calendar sync is driven through an MCP-capable CLI provider — the
// prompt asks the model to call the `mcp__claude_ai_Google_Calendar__*` tools.
// Only CLI providers wired to that MCP can satisfy it (API chat providers
// can't invoke MCP tools), so the picker is restricted to CLI providers and
// the allowedTools flag is passed through as a per-call extra arg.
const CALENDAR_MCP_ALLOWED_TOOLS = 'mcp__claude_ai_Google_Calendar__*';

function md5(str) {
  return createHash('md5').update(str).digest('hex').slice(0, 12);
}

export function normalizeGoogleEvent(event, subcalendarId, subcalendarName) {
  const startDateTime = event.start?.dateTime;
  const startDate = event.start?.date;
  const endDateTime = event.end?.dateTime;
  const endDate = event.end?.date;
  const isAllDay = !startDateTime && !!startDate;

  // Normalize organizer/attendees to the shared { name, email } shape used by
  // the Outlook path so Tribe touchpoint matching (#2033) works uniformly. The
  // "self" attendee's responseStatus is surfaced as myStatus for the
  // declined-event filter.
  const attendees = (event.attendees || []).map((a) => ({
    name: a.displayName || '',
    email: a.email || '',
    status: a.responseStatus || '',
  }));
  const self = (event.attendees || []).find((a) => a.self);
  const myStatus = self?.responseStatus === 'declined' ? 'declined' : undefined;

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
    // Three-state (see `lib/meetingUrl.js`): a string to cache, `null` to
    // clear, or `undefined` when this producer never described conferencing at
    // all. Only the chosen URL is ever retained — never the surrounding
    // conference object, its passwords, or its dial-in codes (#6289).
    meetingUrl: selectMeetingUrl(event),
    organizer: event.organizer === undefined ? undefined : event.organizer
      ? { name: event.organizer.displayName || '', email: event.organizer.email || '' }
      : null,
    attendees: event.attendees === undefined ? undefined : attendees,
    myStatus,
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

/**
 * Upsert a subcalendar's events into the local cache.
 *
 * `options.prune` (default true) removes cached events for this subcalendar
 * that the incoming batch didn't mention — correct only when `rawEvents` is the
 * COMPLETE set for the range. A caller working from a possibly-truncated payload
 * (a CLI that exited non-zero mid-stream, or a source that still had event
 * pages left) must pass `prune: false`, or the
 * missing tail reads as "these events were deleted upstream" and destroys real
 * calendar data. `options.status` labels the resulting sync for the UI.
 *
 * `options.dateRange` ({ pastDate, futureDate }) declares that `rawEvents` only
 * covers that window: pruning is then limited to cached events overlapping it,
 * so history older than the window and events beyond it are never mistaken for
 * upstream deletions.
 */
export async function pushSyncEvents(accountId, calendarId, calendarName, rawEvents, io, options = {}) {
  const { prune: shouldPrune = true, status = 'success', dateRange = null } = options;
  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });

  const normalized = rawEvents.map(e => normalizeGoogleEvent(e, calendarId, calendarName));

  const { newCount, updatedCount, pruned, total } = await mutateCache(accountId, (cache, currentAccount) => {
    const subcalendar = currentAccount.subcalendars?.find(sc => sc.calendarId === calendarId);
    if (subcalendar && (!subcalendar.enabled || subcalendar.dormant)) {
      throw new ServerError('Subcalendar is disabled', { status: 409 });
    }
    // Heal legacy duplicates in this subcalendar, retaining the first local id.
    const existingMap = new Map();
    cache.events = cache.events.filter(event => {
      if (!event.externalId || event.subcalendarId !== calendarId) return true;
      if (existingMap.has(event.externalId)) return false;
      existingMap.set(event.externalId, event);
      return true;
    });

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
        // Refresh the identity fields too so an event already in cache gains
        // organizer/attendees for Tribe touchpoint matching and an up-to-date
        // declined status (#2033) — not just newly-added events.
        if (event.organizer !== undefined) existing.organizer = event.organizer;
        if (event.attendees !== undefined) {
          existing.attendees = event.attendees;
          existing.myStatus = event.myStatus;
        }
        // `undefined` means this producer never described the event's
        // conferencing — a legacy push, or an MCP payload predating the field —
        // so the cached link stands. Anything else is the current snapshot:
        // replace it, or clear it to null when the meeting no longer has one.
        // Without this gate an older client silently drops a working Join action.
        if (event.meetingUrl !== undefined) existing.meetingUrl = event.meetingUrl;
        existing.syncedAt = event.syncedAt;
        updatedCount++;
      } else {
        // A newly cached event always carries the key, so `meetingUrl` is absent
        // from the cache only for records written before this shipped.
        const retained = { ...event, organizer: event.organizer ?? null, attendees: event.attendees ?? [], meetingUrl: event.meetingUrl ?? null };
        cache.events.push(retained);
        existingMap.set(event.externalId, retained);
        newCount++;
      }
    }

    // Prune events for this subcalendar that are no longer present. Skipped when
    // the caller can't vouch that `rawEvents` is complete (see options.prune).
    let pruned = 0;
    if (shouldPrune) {
      const before = cache.events.length;
      const winStart = dateRange ? dateRange.pastDate.getTime() : null;
      const winEnd = dateRange ? dateRange.futureDate.getTime() : null;
      const inSyncedWindow = (e) => {
        if (!dateRange) return true;
        const start = Date.parse(e.startTime || e.endTime);
        const end = Date.parse(e.endTime || e.startTime);
        // Bounds are exclusive like Google's timeMin/timeMax; unparseable/missing
        // times can't be proven outside the window.
        return (Number.isNaN(start) || start < winEnd) && (Number.isNaN(end) || end > winStart);
      };
      cache.events = cache.events.filter(e =>
        e.subcalendarId !== calendarId || incomingIds.has(e.externalId) || !inSyncedWindow(e)
      );
      pruned = before - cache.events.length;
    }

    return { newCount, updatedCount, pruned, total: cache.events.length };
  });
  await updateSyncStatus(accountId, status);

  // Auto-log Tribe touchpoints from this subcalendar batch (#2033) — secondary
  // effect, must not fail the sync; idempotent on event id.
  await logCalendarTouchpoints(accountId, normalized).catch((err) =>
    console.error(`🤝 Tribe auto-log failed for account ${accountId}: ${err.message}`));

  // Populate the human-activity timeline (#2150) — secondary effect, must NOT
  // fail the sync. Google calendars sync through this push path (not
  // calendarSync.syncAccount), so the activity hook is wired here too, mirroring
  // the touchpoint call above. Idempotent on (source, dedupe_key). Machine-local.
  await recordCalendarActivity(account, normalized).catch((err) =>
    console.error(`🗓️  Activity ingest failed for account ${accountId}: ${err.message}`));

  io?.emit('calendar:sync:completed', {
    accountId,
    calendarId,
    calendarName,
    newEvents: newCount,
    updated: updatedCount,
    pruned,
    status
  });

  console.log(`📅 Google push sync for ${calendarName}: ${newCount} new, ${updatedCount} updated, ${pruned} pruned${shouldPrune ? '' : ' (prune skipped — partial payload)'}`);
  return { newEvents: newCount, updated: updatedCount, pruned, total, status };
}

/**
 * Make an MCP-relayed raw event AUTHORITATIVE about its conferencing (#6289).
 *
 * The MCP prompt asks for Google's `events.list` items verbatim, and Google
 * simply OMITS `hangoutLink` / `conferenceData` on an event that has no
 * conference. Relayed unchanged, that omission hits `selectMeetingUrl` as "this
 * producer never described conferencing" and the cached link is preserved — so
 * a meeting whose organizer removed the video call would keep a dead Join
 * button forever, with no sync able to clear it. Stamping explicit nulls says
 * what a complete Google response actually means, matching what the direct-API
 * mapper emits for the same reason.
 *
 * Only a COMPLETE calendar earns this (see `incompleteReason`). A partial one —
 * the CLI died mid-stream, or the source still had event pages — is relayed
 * untouched, so a truncated event that lost its conference fields reads as
 * "unknown" rather than "cleared", the same rule that stops it from driving a
 * prune. Clearing a link is destructive too.
 */
function withExplicitConferenceFields(event) {
  return { ...event, organizer: event?.organizer ?? null, attendees: event?.attendees ?? [], hangoutLink: event?.hangoutLink ?? null, conferenceData: event?.conferenceData ?? null };
}

const mcpSyncLock = new Map();

export async function mcpSyncAccount(accountId, io) {
  if (mcpSyncLock.has(accountId)) throw new ServerError('MCP sync already in progress', { status: 409 });

  mcpSyncLock.set(accountId, true);
  try {
    return await runMcpSyncAccount(accountId, io);
  } finally {
    mcpSyncLock.delete(accountId);
  }
}

async function runMcpSyncAccount(accountId, io) {
  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });
  if (account.type !== 'google-calendar') throw new ServerError('Not a Google Calendar account', { status: 400 });

  const enabledCalendars = (account.subcalendars || []).filter(sc => sc.enabled && !sc.dormant);
  if (enabledCalendars.length === 0) throw new ServerError('No enabled subcalendars', { status: 400 });

  io?.emit('calendar:sync:started', { accountId, method: 'mcp' });
  console.log(`📅 Starting MCP sync for ${account.name} (${enabledCalendars.length} calendars)`);

  const { pastDate, futureDate } = getSyncDateRange();
  const timeMin = pastDate.toISOString();
  const timeMax = futureDate.toISOString();

  const calendarList = enabledCalendars.map(sc => `- Calendar: "${sc.name}", ID: "${sc.calendarId}"`).join('\n');

  const prompt = `You have access to Google Calendar MCP tools. Fetch events from the following calendars for the date range ${timeMin} to ${timeMax}.

${calendarList}

For EACH calendar, call gcal_list_events with the calendarId, timeMin, and timeMax. Use maxResults=250. If a response carries a nextPageToken, call gcal_list_events again with the same calendarId, timeMin and timeMax plus pageToken set to that token, and repeat until a response carries no nextPageToken. Concatenate the events of every page into one array for that calendar.

After fetching ALL calendars, output ONLY a single JSON object (no markdown fences, no explanation) with this exact structure:
{"calendars":[{"calendarId":"...","calendarName":"...","timeMin":"...","timeMax":"...","complete":true,"nextPageToken":null,"events":[...raw events from every page...]}]}

Per calendar, "timeMin" and "timeMax" echo the exact values you queried with. Set "complete" to true ONLY when you fetched every page and the final response carried no nextPageToken; otherwise set "complete" to false and "nextPageToken" to the last token you still hold. Never claim completeness you did not verify.

Include the full events arrays as returned by gcal_list_events, with every field each event carries — do NOT abbreviate, summarize, or drop fields. In particular keep "conferenceData" and "hangoutLink" exactly as returned, and omit them only when the event itself does not have them. Output NOTHING else — just the JSON.`;

  const runSync = async () => {
    const result = await runConfiguredMcp(prompt, io, accountId);

    // A non-zero CLI exit that still printed something is a PARTIAL sync: the
    // JSON may be cut off mid-array, so every calendar it does describe is
    // treated as incomplete. Upsert what arrived, but never prune from it —
    // absent events mean "the CLI died", not "deleted upstream".
    const { partial: cliPartial, stderrTail } = result;
    const cliReason = stderrTail || `CLI exited with code ${result.exitCode}`;

    // Parse Claude's output and push events
    const parsed = parseCalendarJson(result.output.split(prompt).join(''));
    if (!parsed) {
      // Carry the stderr tail so the failure names WHY the CLI produced no
      // usable JSON instead of a bare, undiagnosable parse error.
      const reason = stderrTail ? `: ${stderrTail}` : '';
      throw new ServerError(`Failed to parse calendar data from Claude response${reason}`, { status: 502 });
    }

    // A zero exit proves the CLI finished, NOT that the source handed over every
    // page: each calendar must vouch for itself (#10869). Only a calendar that
    // does earns the prune and the authoritative metadata clear.
    const requestedIds = new Map(enabledCalendars.map(sc => [sc.calendarId, sc.name]));
    const returnedCounts = new Map();
    for (const cal of parsed.calendars) returnedCounts.set(cal.calendarId, (returnedCounts.get(cal.calendarId) || 0) + 1);
    const context = { requestedIds, duplicateIds: new Set([...returnedCounts].filter(([, n]) => n > 1).map(([id]) => id)), timeMin, timeMax };
    const incompleteReasons = [];

    let totalNew = 0;
    let totalUpdated = 0;
    let totalPruned = 0;
    const results = [];

    for (const cal of parsed.calendars) {
      if (!cal.calendarId || !Array.isArray(cal.events)) continue;
      const calendarName = cal.calendarName || cal.calendarId;
      const why = cliPartial ? 'the CLI did not exit cleanly' : incompleteReason(cal, context);
      if (why && !cliPartial) incompleteReasons.push(`"${calendarName}": ${why}`);
      const complete = !why;
      const syncResult = await pushSyncEvents(
        accountId,
        cal.calendarId,
        calendarName,
        complete ? cal.events.map(withExplicitConferenceFields) : cal.events,
        null,
        { prune: complete, status: complete ? 'success' : 'partial', dateRange: { pastDate, futureDate } },
      );
      totalNew += syncResult.newEvents;
      totalUpdated += syncResult.updated;
      totalPruned += syncResult.pruned;
      results.push({ calendarId: cal.calendarId, calendarName: cal.calendarName, complete, ...(why ? { reason: why } : {}), ...syncResult });
    }

    // A requested calendar the response never described was not reconciled at all.
    if (!cliPartial) {
      for (const [id, name] of requestedIds) {
        if (!returnedCounts.has(id)) incompleteReasons.push(`"${name || id}": missing from the response`);
      }
    }

    const partial = cliPartial || incompleteReasons.length > 0;
    const status = partial ? 'partial' : 'success';
    const reason = cliPartial ? cliReason : summarizeReasons(incompleteReasons);

    await updateSyncStatus(accountId, status);
    io?.emit('calendar:sync:completed', {
      accountId,
      newEvents: totalNew,
      updated: totalUpdated,
      pruned: totalPruned,
      status,
      method: 'mcp',
      ...(partial ? { reason } : {}),
    });
    if (partial) {
      console.warn(`⚠️ MCP sync PARTIAL for ${account.name}: ${reason} — ${totalNew} new, ${totalUpdated} updated, ${totalPruned} pruned across ${results.length} calendars`);
    } else {
      console.log(`📅 MCP sync complete for ${account.name}: ${totalNew} new, ${totalUpdated} updated, ${totalPruned} pruned across ${results.length} calendars`);
    }

    return {
      newEvents: totalNew,
      updated: totalUpdated,
      pruned: totalPruned,
      calendars: results,
      status,
      ...(partial ? { reason } : {}),
    };
  };

  return runSync().catch(async (error) => {
    console.error(`❌ MCP sync failed for ${account.name}: ${error.message}`);
    io?.emit('calendar:sync:failed', { accountId, error: error.message, method: 'mcp' });
    await updateSyncStatus(accountId, 'error').catch(() => {});
    throw error instanceof ServerError ? error : new ServerError(error.message, { status: 502 });
  });
}

const hasPageToken = token => token !== undefined && token !== null && token !== '';
const sameInstant = (a, b) => typeof a === 'string' && Date.parse(a) === Date.parse(b);

/**
 * Why one returned calendar cannot be treated as the COMPLETE event set for the
 * requested window, or null when it can (#10869). The CLI exiting 0 only proves
 * the process finished; Google paginates, so a first page alone also exits 0.
 * Only an explicit `complete: true`, no remaining `nextPageToken`, a calendar we
 * asked for (once) and an echo of the requested window together license a prune.
 * Anything missing, legacy or contradictory degrades to upsert-only.
 */
function incompleteReason(cal, { requestedIds, duplicateIds, timeMin, timeMax }) {
  if (!requestedIds.has(cal.calendarId)) return 'calendar was not requested';
  if (duplicateIds.has(cal.calendarId)) return 'calendar was returned more than once';
  if (hasPageToken(cal.nextPageToken)) return 'the source still has more event pages';
  if (cal.complete !== true) return cal.complete === false ? 'the source reported the event list as incomplete' : 'no completion marker';
  if (!sameInstant(cal.timeMin, timeMin) || !sameInstant(cal.timeMax, timeMax)) return 'window metadata is missing or differs from the request';
  return null;
}

function summarizeReasons(reasons) {
  const shown = reasons.slice(0, 3).join('; ');
  return reasons.length > 3 ? `${shown}; and ${reasons.length - 3} more` : shown;
}

const isCalendarPayload = value => Array.isArray(value?.calendars) && value.calendars.every(cal =>
  typeof cal?.calendarId === 'string' && cal.calendarId.trim() && Array.isArray(cal.events)
  && cal.events.every(event => event !== null && typeof event === 'object' && !Array.isArray(event)));

function parseCalendarJson(output) {
  const { value } = extractJson(output, { shapePredicate: isCalendarPayload, skipInnerFence: true });
  // The shared extractor can return a parseable nonmatching fallback.
  return isCalendarPayload(value) ? value : null;
}

const isDiscoveredCalendars = value => Array.isArray(value) && value.every(cal =>
  typeof cal?.id === 'string' && cal.id.trim()
  && (cal.name === undefined || typeof cal.name === 'string')
  && (cal.color === undefined || typeof cal.color === 'string'));

export async function mcpDiscoverCalendars(accountId, io) {
  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });
  if (account.type !== 'google-calendar') throw new ServerError('Not a Google Calendar account', { status: 400 });

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

  const result = await runConfiguredMcp(prompt, io, accountId);

  // Discovery REPLACES the stored subcalendar list, so a truncated array would
  // silently drop calendars (and their enabled/goal wiring). A partial payload
  // is never good enough to merge — fail loudly with the CLI's own reason.
  if (result.partial) {
    const reason = result.stderrTail || `CLI exited with code ${result.exitCode}`;
    throw new ServerError(`Calendar discovery returned a partial response — not merging: ${reason}`, { status: 502 });
  }

  const { value: calendars } = extractJson(result.output.split(prompt).join(''), {
    blockType: 'array', shapePredicate: isDiscoveredCalendars, skipInnerFence: true,
  });
  if (calendars === undefined) {
    const reason = result.stderrTail ? `: ${result.stderrTail}` : '';
    throw new ServerError(`Failed to parse calendar list from Claude response${reason}`, { status: 502 });
  }
  if (!isDiscoveredCalendars(calendars)) throw new ServerError('Invalid calendar list format', { status: 502 });

  // Merge with existing subcalendars (preserve enabled/dormant state)
  const merged = mergeDiscoveredSubcalendars(account.subcalendars, calendars);

  await updateSubcalendars(accountId, merged);

  console.log(`📅 Discovered ${calendars.length} calendars for ${account.name}`);
  return { calendars: merged, status: 'success' };
}

async function runConfiguredMcp(prompt, io, accountId) {
  // Resolve the user's configured calendar-sync provider/model (falls back to
  // claude-code — the historical default — when unset). Restricted to CLI
  // providers since the sync relies on MCP tool calling.
  const all = await getAllProviders().catch(() => null);
  const settings = await getSettings().catch(() => ({}));
  const picked = pickCliProvider(all?.providers, settings?.calendarSync || {});
  if (picked.error) {
    throw new ServerError(picked.error, { status: 502 });
  }

  // `--allowedTools mcp__…` is Claude-Code-specific argv. Other CLIs grant MCP
  // access through their own config (codex/antigravity have no such flag), so pass
  // it only to Claude-family providers — appending it to another CLI would
  // make it reject the invocation on an unknown flag.
  const isClaudeFamily = /claude/i.test(picked.provider.command || '') || /claude/i.test(picked.provider.id || '');
  const extraArgs = isClaudeFamily ? ['--allowedTools', CALENDAR_MCP_ALLOWED_TOOLS] : [];

  console.log(`📅 Calendar MCP sync via ${picked.provider.id}${picked.model ? ` (${picked.model})` : ''}`);

  const result = await runCliProviderPrompt({
    provider: picked.provider,
    model: picked.model,
    prompt,
    cwd: process.cwd(),
    extraArgs,
    timeoutMs: 300000,
    onData: (chunk, stream) => {
      // Emit progress for UI feedback when the model starts listing events.
      if (stream === 'stderr' && chunk.includes('gcal_list_events')) {
        io?.emit('calendar:sync:progress', { accountId, message: 'Fetching calendar events...' });
      }
    },
  });

  if (result.error) {
    throw new ServerError(result.error, { status: 502 });
  }
  // `partial` means the CLI exited non-zero but still printed something — the
  // payload may be truncated mid-JSON. Callers MUST NOT let a partial payload
  // drive a destructive operation (see pushSyncEvents' prune option).
  return {
    output: result.text,
    exitCode: result.exitCode,
    partial: result.partial === true,
    stderrTail: result.stderrTail || '',
  };
}
