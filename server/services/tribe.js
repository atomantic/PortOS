import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureSchema, query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import * as calendarSync from './calendarSync.js';

const DEFAULT_RING_CADENCE = {
  support: 7,
  core: 21,
  tribe: 45,
  village: 90,
};

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isoDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  return String(tags).split(',').map((tag) => tag.trim()).filter(Boolean);
}

function rowToPerson(row) {
  return {
    id: row.id,
    name: row.name,
    relationship: row.relationship || '',
    ring: row.ring || 'tribe',
    cadenceDays: row.cadence_days ?? DEFAULT_RING_CADENCE[row.ring] ?? 45,
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

function rowToTouchpoint(row) {
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

function rowToMemoryLink(row) {
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
       CASE ring WHEN 'support' THEN 1 WHEN 'core' THEN 2 WHEN 'tribe' THEN 3 WHEN 'village' THEN 4 ELSE 5 END,
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
