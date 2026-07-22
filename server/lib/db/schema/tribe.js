// Tribe / relationship-CRM DDL (#2033, #2150, #2151) — people, touchpoints,
// and memory links. Machine-local (never federated). Extracted verbatim from
// ensureSchemaImpl() in server/lib/db.js (#2832); idempotent, runs on every boot.
export const tribeDdl = [
    `CREATE TABLE IF NOT EXISTS tribe_people (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      relationship TEXT DEFAULT '',
      ring VARCHAR(32) NOT NULL DEFAULT 'tribe',
      cadence_days INTEGER NOT NULL DEFAULT 45,
      last_contact_on DATE,
      channel TEXT DEFAULT '',
      energy VARCHAR(32) NOT NULL DEFAULT 'steady',
      tags TEXT[] DEFAULT '{}',
      next_move TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    // Known emails/handles for a person — the deterministic key that maps a
    // calendar attendee / message counterpart back to this tracked person so
    // touchpoints can be auto-logged (#2033).
    `ALTER TABLE tribe_people ADD COLUMN IF NOT EXISTS emails TEXT[] DEFAULT '{}'`,
    // Known phone handles for a person — the deterministic key that maps an
    // iMessage/Signal handle (E.164, e.g. +15551234567) back to this tracked
    // person so touchpoints can be auto-logged (#2151). Mirrors emails[].
    `ALTER TABLE tribe_people ADD COLUMN IF NOT EXISTS phones TEXT[] DEFAULT '{}'`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_people_live ON tribe_people (deleted, ring, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_people_tags ON tribe_people USING gin (tags)`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_people_emails ON tribe_people USING gin (emails)`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_people_phones ON tribe_people USING gin (phones)`,
    `CREATE TABLE IF NOT EXISTS tribe_touchpoints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id UUID NOT NULL REFERENCES tribe_people(id) ON DELETE CASCADE,
      happened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      channel TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      source VARCHAR(32) NOT NULL DEFAULT 'user',
      calendar_account_id TEXT,
      calendar_event_id TEXT,
      dedupe_key TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Idempotency key for auto-logged touchpoints (calendar event id / message
    // thread+day). Partial unique index so re-syncs never double-log a person
    // for the same event/thread-day; NULL for hand-logged user touchpoints.
    `ALTER TABLE tribe_touchpoints ADD COLUMN IF NOT EXISTS dedupe_key TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_touchpoints_person ON tribe_touchpoints (person_id, happened_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_touchpoints_calendar ON tribe_touchpoints (calendar_account_id, calendar_event_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tribe_touchpoints_dedupe ON tribe_touchpoints (person_id, dedupe_key) WHERE dedupe_key IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS tribe_memory_links (
      person_id UUID NOT NULL REFERENCES tribe_people(id) ON DELETE CASCADE,
      memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (person_id, memory_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_memory_links_memory ON tribe_memory_links (memory_id)`,
];
