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
    // Network-scoped identity claims (#34, decided on #10) — the durable-handle
    // truth for matching an external counterpart (a Beeper participant today;
    // any future network-scoped source tomorrow) to a Tribe person. `kind`
    // distinguishes what TYPE of identifier `handle` is: 'phone' for a
    // phone-shaped handle (E.164-normalized, `network` left '' since the same
    // phone means the same person regardless of which network reported it) or
    // 'handle' for a network-specific username (network-scoped, so `network`
    // is required).
    //
    // `kind='beeper-user'` (#96) OVERLOADS the same three columns for the
    // participants Beeper reports neither a phone nor a username for: it
    // carries the participant's `beeper_conversations.account_id` in
    // `network` and its raw `beeper_participants.source_user_id` in `handle`.
    // That is Beeper's own per-account `User.id` — stable across resweeps,
    // where the mirror's `conversation_id` is a PortOS UUID re-minted by every
    // purge — so a hand-made link recorded here outlives a purge + resweep
    // that deletes the `beeper_participants` cache row (`ON DELETE CASCADE`
    // off `beeper_conversations`). The ACCOUNT is the scope, not the network:
    // two bridge accounts on one network mint independent user-id spaces. The
    // overload is deliberate — no new column, no widened UNIQUE, and the same
    // `(kind, network, handle)` lookup serves it — and the writer/reader pair
    // lives in `server/services/beeperTribe.js` (`beeperUserScopeFor`).
    // A `source_user_id` is opaque, so it is stored RAW: unlike a phone or a
    // username it is never normalized by `server/lib/tribeMatch.js`.
    //
    // This also leaves room for a later `kind='email'` /
    // consolidation of the legacy tribe_people.emails[]/phones[] arrays into
    // this table without a second schema decision (deferred, #10 decision 7 —
    // not done here). A handle is lowercased, trimmed, leading '@' stripped
    // before it reaches this table (see server/lib/tribeMatch.js).
    // ON DELETE CASCADE: a HARD delete of a Tribe person also removes their
    // claimed identities, so a later re-link starts clean rather than
    // colliding on UNIQUE (kind, network, handle) with a stale row. The app's
    // only delete path (tribe.deletePerson) is a SOFT delete (`deleted =
    // TRUE`), which this cascade does NOT fire on — resolvePersonByIdentity
    // and resolveParticipantPerson (server/services/beeperTribe.js) instead
    // filter `tribe_people.deleted = FALSE` explicitly, and linkIdentity /
    // linkParticipant refuse to claim/link a soft-deleted personId.
    `CREATE TABLE IF NOT EXISTS tribe_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id UUID NOT NULL REFERENCES tribe_people(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      network TEXT NOT NULL DEFAULT '',
      handle TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (kind, network, handle)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_identities_person ON tribe_identities (person_id)`,
];
