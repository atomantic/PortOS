/**
 * Tribe — relationship/CRM graph (PostgreSQL: tribe_people, tribe_touchpoints,
 * tribe_memory_links).
 *
 * INTENTIONALLY MACHINE-LOCAL — not federated. See ADR
 * docs/decisions/2026-06-26-tribe-and-universe-runs-local.md (#1724). It mirrors
 * the deliberate "relationship data is instance-local" boundary already drawn by
 * memorySync.js (memory NODES federate; memory_links do not), and is coupled to
 * machine-local domains: tribe_memory_links extends the non-federated memory_links
 * layer, and tribe_touchpoints carry per-machine calendar-account refs
 * (calendar_account_id / calendar_event_id). There is no sync hook here by design;
 * adding one is a conscious act (revisit the ADR + the guard in
 * sharing/peerSync.test.js).
 */
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureSchema, query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { cadenceStatus } from '../lib/tribeCadence.js';
import * as calendarSync from './calendarSync.js';

// Default check-in cadence (days) per ring. Mirrored on the client in
// `client/src/pages/Tribe.jsx` (the RINGS array's `cadenceDays`); the SQL column
// default is a flat 45 (`cadence_days` in db.js / init-db.sql) because the
// ring-aware default is resolved here before insert. Keep all three in sync.
export const DEFAULT_RING_CADENCE = {
  support: 7,
  core: 21,
  tribe: 45,
  village: 90,
  // `external` is for people outside the active tribe (former contacts, a nemesis):
  // no care cadence is owed, so this default is a neutral yearly nudge and the UI
  // excludes external people from the care queue entirely.
  external: 365,
};

export function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function isoDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  return String(tags).split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function rowToPerson(row) {
  return {
    id: row.id,
    name: row.name,
    relationship: row.relationship || '',
    ring: row.ring || 'tribe',
    // cadence_days is NOT NULL DEFAULT 45, so it's always present on a real row.
    cadenceDays: row.cadence_days,
    lastContact: isoDate(row.last_contact_on),
    channel: row.channel || '',
    energy: row.energy || 'steady',
    tags: row.tags || [],
    nextMove: row.next_move || '',
    notes: row.notes || '',
    touchpointCount: Number(row.touchpoint_count || 0),
    linkedMemoryCount: Number(row.linked_memory_count || 0),
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

export function rowToTouchpoint(row) {
  return {
    id: row.id,
    personId: row.person_id,
    happenedAt: isoDateTime(row.happened_at),
    channel: row.channel || '',
    summary: row.summary || '',
    source: row.source || 'user',
    calendarAccountId: row.calendar_account_id || null,
    calendarEventId: row.calendar_event_id || null,
    metadata: row.metadata || {},
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

export function rowToMemoryLink(row) {
  return {
    personId: row.person_id,
    memoryId: row.memory_id,
    note: row.note || '',
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    memory: row.memory_id ? {
      id: row.memory_id,
      type: row.type,
      summary: row.summary,
      content: row.content,
      category: row.category,
      tags: row.memory_tags || [],
      createdAt: row.memory_created_at?.toISOString?.() ?? row.memory_created_at,
    } : null,
  };
}

async function ensureReady() {
  await ensureSchema();
}

// Cadence health for a person — the server-side entry point into the shared,
// authoritative cadence rules in server/lib/tribeCadence.js (mirrored to the
// client). Kept as a named re-export so existing callers/tests importing
// `personCadenceStatus` from this service stay stable while the rules live in
// exactly one place. See tribeCadence.js for the state semantics.
export const personCadenceStatus = cadenceStatus;

// Care summary for the dashboard widget + proactive alert: who in the active
// tribe (external excluded) is overdue or has no touchpoint yet, most-overdue
// first. `missing` (never contacted) sorts above any dated-overdue person.
export async function getCareSummary(limit = 5) {
  const people = await listPeople();
  const tribe = people.filter((person) => person.ring !== 'external');
  const overdue = [];
  for (const person of tribe) {
    const status = personCadenceStatus(person);
    if (status.state === 'overdue' || status.state === 'missing') {
      overdue.push({ person, status });
    }
  }
  // missing (daysOverdue null) first, then by daysOverdue desc, then by name.
  overdue.sort((a, b) => {
    const aMissing = a.status.daysOverdue == null;
    const bMissing = b.status.daysOverdue == null;
    if (aMissing !== bMissing) return aMissing ? -1 : 1;
    if (!aMissing && b.status.daysOverdue !== a.status.daysOverdue) {
      return b.status.daysOverdue - a.status.daysOverdue;
    }
    return String(a.person.name).localeCompare(String(b.person.name));
  });
  return {
    hasPeople: tribe.length > 0,
    peopleCount: tribe.length,
    overdueCount: overdue.length,
    overdue: overdue.slice(0, Math.max(0, limit)).map(({ person, status }) => ({
      id: person.id,
      name: person.name,
      ring: person.ring,
      channel: person.channel,
      lastContact: person.lastContact,
      state: status.state,
      daysOverdue: status.daysOverdue,
    })),
  };
}

export async function listPeople(options = {}) {
  await ensureReady();
  const conditions = ['deleted = FALSE'];
  const params = [];
  let idx = 1;
  if (options.ring && options.ring !== 'all') {
    conditions.push(`ring = $${idx++}`);
    params.push(options.ring);
  }
  if (options.search) {
    conditions.push(`(
      name ILIKE $${idx} OR relationship ILIKE $${idx} OR channel ILIKE $${idx}
      OR next_move ILIKE $${idx} OR notes ILIKE $${idx} OR array_to_string(tags, ' ') ILIKE $${idx}
    )`);
    params.push(`%${options.search}%`);
    idx++;
  }

  const result = await query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM tribe_touchpoints t WHERE t.person_id = p.id) AS touchpoint_count,
       (SELECT COUNT(*) FROM tribe_memory_links ml WHERE ml.person_id = p.id) AS linked_memory_count
     FROM tribe_people p
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE ring WHEN 'support' THEN 1 WHEN 'core' THEN 2 WHEN 'tribe' THEN 3 WHEN 'village' THEN 4 WHEN 'external' THEN 5 ELSE 6 END,
       COALESCE(last_contact_on, DATE '1900-01-01') ASC,
       name ASC`,
    params,
  );
  return result.rows.map(rowToPerson);
}

export async function getPerson(id) {
  await ensureReady();
  const result = await query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM tribe_touchpoints t WHERE t.person_id = p.id) AS touchpoint_count,
       (SELECT COUNT(*) FROM tribe_memory_links ml WHERE ml.person_id = p.id) AS linked_memory_count
     FROM tribe_people p
     WHERE p.id = $1 AND p.deleted = FALSE`,
    [id],
  );
  return result.rows[0] ? rowToPerson(result.rows[0]) : null;
}

export async function createPerson(data) {
  await ensureReady();
  const id = data.id || uuidv4();
  const ring = data.ring || 'tribe';
  const cadenceDays = data.cadenceDays ?? DEFAULT_RING_CADENCE[ring] ?? 45;
  const result = await query(
    `INSERT INTO tribe_people (
      id, name, relationship, ring, cadence_days, last_contact_on, channel,
      energy, tags, next_move, notes, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    RETURNING *, 0 AS touchpoint_count, 0 AS linked_memory_count`,
    [
      id,
      data.name,
      data.relationship || '',
      ring,
      cadenceDays,
      data.lastContact || null,
      data.channel || '',
      data.energy || 'steady',
      normalizeTags(data.tags),
      data.nextMove || '',
      data.notes || '',
    ],
  );
  return rowToPerson(result.rows[0]);
}

export async function updatePerson(id, updates) {
  await ensureReady();
  const current = await getPerson(id);
  if (!current) return null;
  const next = { ...current, ...updates };
  const result = await query(
    `UPDATE tribe_people
     SET name = $2,
         relationship = $3,
         ring = $4,
         cadence_days = $5,
         last_contact_on = $6,
         channel = $7,
         energy = $8,
         tags = $9,
         next_move = $10,
         notes = $11,
         updated_at = NOW()
     WHERE id = $1 AND deleted = FALSE
     RETURNING *,
       (SELECT COUNT(*) FROM tribe_touchpoints t WHERE t.person_id = tribe_people.id) AS touchpoint_count,
       (SELECT COUNT(*) FROM tribe_memory_links ml WHERE ml.person_id = tribe_people.id) AS linked_memory_count`,
    [
      id,
      next.name,
      next.relationship || '',
      next.ring || 'tribe',
      next.cadenceDays ?? DEFAULT_RING_CADENCE[next.ring] ?? 45,
      next.lastContact || null,
      next.channel || '',
      next.energy || 'steady',
      normalizeTags(next.tags),
      next.nextMove || '',
      next.notes || '',
    ],
  );
  return result.rows[0] ? rowToPerson(result.rows[0]) : null;
}

export async function deletePerson(id) {
  await ensureReady();
  const result = await query(
    `UPDATE tribe_people
     SET deleted = TRUE, deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND deleted = FALSE
     RETURNING id`,
    [id],
  );
  return result.rowCount > 0;
}

export async function listTouchpoints(personId, limit = 50) {
  await ensureReady();
  const result = await query(
    `SELECT * FROM tribe_touchpoints
     WHERE person_id = $1
     ORDER BY happened_at DESC
     LIMIT $2`,
    [personId, limit],
  );
  return result.rows.map(rowToTouchpoint);
}

export async function createTouchpoint(personId, data = {}) {
  await ensureReady();
  const person = await getPerson(personId);
  if (!person) throw new ServerError('Person not found', { status: 404 });

  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO tribe_touchpoints (
        id, person_id, happened_at, channel, summary, source,
        calendar_account_id, calendar_event_id, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        data.id || uuidv4(),
        personId,
        data.happenedAt || new Date().toISOString(),
        data.channel || '',
        data.summary || '',
        data.source || 'user',
        data.calendarAccountId || null,
        data.calendarEventId || null,
        data.metadata || {},
      ],
    );

    await client.query(
      `UPDATE tribe_people
       SET last_contact_on = GREATEST(COALESCE(last_contact_on, DATE '1900-01-01'), $2::date),
           channel = CASE WHEN $3::text = '' THEN channel ELSE $3::text END,
           updated_at = NOW()
       WHERE id = $1`,
      [personId, data.happenedAt || new Date().toISOString(), data.channel || ''],
    );
    return rowToTouchpoint(result.rows[0]);
  });
}

export async function createCalendarTouchpoint(personId, { accountId, eventId, summary }) {
  const event = await calendarSync.getEvent(accountId, eventId);
  if (!event) throw new ServerError('Calendar event not found', { status: 404 });
  return createTouchpoint(personId, {
    happenedAt: event.startTime || event.endTime || new Date().toISOString(),
    channel: event.location || 'Calendar',
    summary: summary || event.title || 'Calendar touchpoint',
    source: 'calendar',
    calendarAccountId: accountId,
    calendarEventId: eventId,
    metadata: {
      title: event.title,
      description: event.description,
      location: event.location,
      startTime: event.startTime,
      endTime: event.endTime,
      organizer: event.organizer,
      attendees: event.attendees,
      subcalendarId: event.subcalendarId,
      subcalendarName: event.subcalendarName,
    },
  });
}

export async function listMemoryLinks(personId) {
  await ensureReady();
  const result = await query(
    `SELECT ml.*, m.type, m.summary, m.content, m.category, m.tags AS memory_tags, m.created_at AS memory_created_at
     FROM tribe_memory_links ml
     JOIN memories m ON m.id = ml.memory_id
     WHERE ml.person_id = $1
     ORDER BY ml.created_at DESC`,
    [personId],
  );
  return result.rows.map(rowToMemoryLink);
}

export async function linkMemory(personId, memoryId, note = '') {
  await ensureReady();
  const person = await getPerson(personId);
  if (!person) throw new ServerError('Person not found', { status: 404 });
  const result = await query(
    `INSERT INTO tribe_memory_links (person_id, memory_id, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (person_id, memory_id)
     DO UPDATE SET note = EXCLUDED.note
     RETURNING *`,
    [personId, memoryId, note],
  ).catch((err) => {
    if (err?.code === '23503') throw new ServerError('Memory not found', { status: 404 });
    throw err;
  });
  return result.rows[0];
}

export async function unlinkMemory(personId, memoryId) {
  await ensureReady();
  const result = await query(
    'DELETE FROM tribe_memory_links WHERE person_id = $1 AND memory_id = $2',
    [personId, memoryId],
  );
  return result.rowCount > 0;
}
