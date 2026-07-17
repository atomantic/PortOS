const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Normalize the `deleted` + `deletedAt` tombstone fields on a raw record.
 * Used by every sanitizer that participates in soft-delete / peer sync
 * (`sanitizeTemplate` for universes, `sanitizeSeries`, `sanitizeIssue`) so
 * the shape of a tombstone is identical regardless of which file owns the
 * record. The invariants are:
 *   1. when `deleted=false`, `deletedAt` is always `null` — never a stray
 *      timestamp from a corrupted payload.
 *   2. `deletedAt` is a NON-EMPTY string when present; empty/whitespace
 *      strings normalize to `null` so a malformed payload (`{ deleted: true,
 *      deletedAt: '' }`) doesn't persist a useless tombstone marker.
 */
export function sanitizeSoftDeleteFields(raw) {
  const deleted = raw?.deleted === true;
  const deletedAt = deleted && isNonEmptyStr(raw?.deletedAt) ? raw.deletedAt : null;
  return { deleted, deletedAt };
}

// Single source of truth for what fields cross the federated-peer wire.
//
// Two transports carry universe / series / issue records between peers:
//
//   1. The 60s snapshot loop in `server/services/dataSync.js` — sends the full
//      per-category state every cycle for LWW reconciliation.
//   2. The per-record push pipeline in `server/services/sharing/peerSync.js` —
//      sends one record (+ asset manifest) when a subscription fires after a
//      local edit.
//
// Both transports MUST agree on which fields are wire-safe and which are
// peer-local (ephemeral state, transcripts, render history that's too large
// to round-trip). The helpers here are the single decision point — change
// them and every transport updates together.

/**
 * Wire-safe projection of a single record. Normalizes soft-delete fields so
 * the on-disk shape is irrelevant to the wire hash — a legacy record without
 * `deleted` / `deletedAt` and a freshly-rewritten record with
 * `{ deleted: false, deletedAt: null }` carry the same logical content and
 * MUST produce the same checksum. Without this, the 60s snapshot loop would
 * see a permanent checksum mismatch between an upgraded peer and a not-yet-
 * upgraded peer for the same live records (the merge LWW would no-op because
 * `updatedAt` is equal, so the files never converge and sync churns forever).
 *
 * Per-record field stripping (e.g. dropping `runHistory` from issue stages
 * once it grows too large for sync) goes here when the time comes — the
 * function exists today so the new push path has the same callsite as the
 * snapshot path, and so the next "should this field cross the wire?"
 * decision lands in one place.
 */
export function sanitizeRecordForWire(kind, record) {
  // Reject non-objects, arrays (typeof [] === 'object'), and records missing
  // a usable id. Receiver-side merge functions (mergeUniversesFromSync etc.)
  // skip records without an `id`, so including such records here would mean
  // the snapshot checksum reflects content the receiver can never apply —
  // permanent mismatch + churn until both sides clean up the corrupt entries.
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (!isNonEmptyStr(record.id)) return null;
  // Ephemeral records are local-only — scratch universes/series/issues the
  // user (or a test fixture) explicitly marks "don't sync to peers." Filter
  // here so BOTH transports (60s snapshot + per-record push) skip them
  // identically. We never emit `ephemeral` on the wire — the field stays
  // local to whatever instance owns the record, and the wire checksum for
  // non-ephemeral records is byte-stable against pre-flag peers.
  //
  // EXCEPT: tombstones (deleted=true) still cross the wire even when
  // ephemeral=true. If a record was live + shared, then later marked
  // ephemeral, then deleted, peers still have the live copy — they need
  // the tombstone to converge. The strip-below-then-readd-tail dance
  // ensures `ephemeral` never appears in the serialized wire form even
  // when the record carries it on disk.
  if (record.ephemeral === true && record.deleted !== true) return null;
  switch (kind) {
    case 'universe':
    case 'series':
    case 'issue': {
      // Strip the soft-delete fields AND the local-only `ephemeral` flag
      // from the input first, then re-add the soft-delete pair in canonical
      // position at the END. JS object spread preserves key position when
      // *overwriting* an existing key — without this strip, a record where
      // `deleted` happens to sit in a non-tail position would serialize
      // differently from a freshly-rewritten record where it sits at the
      // tail, defeating the byte-stable-checksum invariant the dataSync
      // snapshot loop relies on (computeChecksum uses JSON.stringify, which
      // is key-order sensitive). The `ephemeral` strip protects the same
      // invariant for the tombstone-cross-wire case above: a deleted record
      // that carried `ephemeral: true` on disk MUST hash identically against
      // a pre-flag peer's tombstone for the same record.
      // `importDraft` (issue #727) is a local-only importer-orphan GC marker,
      // analogous to `ephemeral` — strip it here too so it never appears in the
      // serialized wire form and the checksum stays byte-stable against peers
      // that predate the flag. In practice an import-draft record is always
      // `ephemeral: true` and already short-circuits at the top, but stripping
      // unconditionally keeps the invariant robust if the two flags ever
      // diverge.
      const { deleted: _deleted, deletedAt: _deletedAt, ephemeral: _ephemeral, importDraft: _importDraft, ...rest } = record;
      // EPHEMERAL TOMBSTONES — minimize the payload. If a record was
      // created ephemeral and never shared, deleting it would otherwise
      // ship the full content to peers that never had it (just because
      // tombstones cross the wire). Minimize to the structural fields
      // the receiver's sanitizers REQUIRE (otherwise sanitizeTemplate /
      // sanitizeSeries / sanitizeIssue drops the record on the floor
      // and the tombstone never lands) plus the tombstone fields.
      //
      // Required fields by kind, derived from sanitizeTemplate /
      // sanitizeSeries / sanitizeIssue:
      //   universe → name (non-empty string)
      //   series   → name (non-empty string)
      //   issue    → seriesId + title
      // We send a placeholder when the on-disk value is missing — the
      // receiver only uses these to pass the sanitizer; the tombstone
      // fields drive everything downstream.
      if (record.ephemeral === true) {
        const minimized = {
          id: record.id,
          ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
        };
        if (kind === 'universe' || kind === 'series') {
          minimized.name = isNonEmptyStr(record.name) ? record.name : '_';
        } else if (kind === 'issue') {
          // seriesId is REQUIRED by sanitizeIssue on the receiver. Without
          // a placeholder, an ephemeral issue tombstone whose on-disk
          // seriesId got cleared (rare, but possible via hand-edit or a
          // partial-delete race) would be silently dropped on receive and
          // the tombstone would never land — peer keeps the live issue
          // copy forever.
          minimized.seriesId = isNonEmptyStr(record.seriesId) ? record.seriesId : '_';
          minimized.title = isNonEmptyStr(record.title) ? record.title : '_';
        }
        return { ...minimized, ...sanitizeSoftDeleteFields(record) };
      }
      // `styleImageRefs` (universe base "style probe" renders) is WIRE-LOCAL:
      // per-peer, regenerable, and NOT a restorable conflict field
      // (RESTORABLE_FIELDS.universe omits it). Strip it from every universe
      // payload so (1) an older peer that lacks the field in its sanitizer
      // can't drop-then-LWW-strip it back off a newer peer on round-trip, and
      // (2) it never feeds the conflict-journal content hash (contentHashForRecord
      // reuses this projection) — a probe render alone would otherwise register a
      // phantom 3-way divergence whose diff can't mention the field. Stripping
      // here (rather than bumping the `universes` schema version) keeps universe
      // sync flowing to not-yet-upgraded peers: a whole-category gate would
      // 412-reject ALL universe transfers over a low-stakes, one-click-regenerable
      // field. The strip is byte-stable against pre-field peers — they never sent
      // it, so the wire/hash form is unchanged for them.
      if (kind === 'universe') {
        const { styleImageRefs: _styleImageRefs, ...universeRest } = rest;
        return { ...universeRest, ...sanitizeSoftDeleteFields(record) };
      }
      return { ...rest, ...sanitizeSoftDeleteFields(record) };
    }
    case 'mediaCollection': {
      // Strip then re-add soft-delete fields at tail so the byte-stable
      // checksum invariant holds regardless of the on-disk key position.
      // Collections have no `ephemeral` field — unlike universe/series,
      // they are always wire-syncable when non-ephemeral (there is no
      // collection-level ephemeral flag), so no ephemeral minimization path.
      const { deleted: _d, deletedAt: _da, ...rest } = record;
      return { ...rest, ...sanitizeSoftDeleteFields(record) };
    }
    case 'author':
    case 'artist':
    case 'album':
    case 'track':
    case 'creativeDirectorProject':
    case 'moodBoard':
    case 'writersRoomFolder':
    case 'writersRoomExercise':
    case 'musicVideoProject':
    case 'commissionFeedback': {
      // Persona/music/creative-director/mood-board records: like mediaCollection,
      // no `ephemeral` flag — always wire-syncable when present. Strip-then-tail-
      // re-add the soft-delete pair for byte-stable checksums. The whole record
      // is LWW-overwritten on merge (no item-union), so the wire form converges
      // byte-for-byte and feeds the conflict-journal content hash directly (no
      // scalar narrowing in contentHashForRecord). A creativeDirectorProject is
      // larger than a persona (treatment/scenes/runs) but follows the same whole-
      // record LWW contract; a moodBoard (name/description/items) is the same.
      // Writers Room folders + exercises (#1645) are also body-less whole-record
      // LWW kinds with no ephemeral counters — they wire identically (no liveMode
      // strip like writersRoomWork below). A musicVideoProject (#1770:
      // metadata + beat-aligned scenes[]) is the same whole-record LWW contract.
      // A commissionFeedback (#2686: one reaction — commissionId/runId/rating/
      // note/tags/at) is a body-less whole-record LWW record with no local-only
      // fields to strip, so it rides this same group.
      const { deleted: _d, deletedAt: _da, ...rest } = record;
      return { ...rest, ...sanitizeSoftDeleteFields(record) };
    }
    case 'writersRoomWork': {
      // A writersRoomWork is the manifest + decomposed draft-version METADATA in
      // drafts[] (the .md prose bodies ride a separate body manifest). Whole-record
      // LWW like the kinds above, BUT `liveMode.usage` / `liveMode.renderUsage` are
      // LOCAL-ONLY daily-budget counters (per machine, regenerable) — strip them
      // from the wire so (1) they never transit and reset a peer's budget on a
      // whole-record overwrite, and (2) the conflict-journal content hash stays
      // byte-stable across peers regardless of counter state (mirrors the
      // styleImageRefs strip for universes). The user-editable live-mode knobs
      // (enabled/debounceMs/dailyCallBudget/dailyRenderBudget) still sync.
      const { deleted: _d, deletedAt: _da, ...rest } = record;
      if (rest.liveMode && typeof rest.liveMode === 'object' && !Array.isArray(rest.liveMode)) {
        const { usage: _u, renderUsage: _ru, ...liveModeKnobs } = rest.liveMode;
        rest.liveMode = liveModeKnobs;
      }
      return { ...rest, ...sanitizeSoftDeleteFields(record) };
    }
    case 'creativeCommission': {
      // The commission BRIEF federates (#2686) so a synced reaction attaches to
      // the SAME commission on every peer — but `schedule`, `runs`, `assignment`,
      // and `enabled` are MACHINE-LOCAL and MUST NOT transit: a federated schedule
      // (or enabled flag) would arm/double-run the cron on every peer (the whole
      // reason the commission was machine-local pre-#2686), `runs` is per-machine
      // execution history, and `assignment` pins a provider/model that may not
      // exist on the peer. Strip them; the receiver keeps its OWN values on merge
      // (preserveLocalCommissionFields) and a fresh insert lands dormant. `feedback`
      // never rides here either — it federates as its own `commissionFeedback`
      // record kind. The LWW key on the wire is the BRIEF clock (`briefUpdatedAt`),
      // NOT the general `updatedAt` (which local-only edits bump) — so a
      // schedule-only edit can't push a stale brief and a delayed brief edit still
      // wins. Whole-record LWW over what remains (id/name/targetAbility/brief/
      // generation/feedbackWindow), hashed in full by contentHashForRecord.
      const { deleted: _d, deletedAt: _da, schedule: _s, runs: _r, assignment: _a,
        feedback: _f, enabled: _e, briefUpdatedAt: _bu, updatedAt: _ua, ...rest } = record;
      const briefClock = typeof record.briefUpdatedAt === 'string' ? record.briefUpdatedAt
        : (typeof record.updatedAt === 'string' ? record.updatedAt : undefined);
      return { ...rest, ...(briefClock ? { updatedAt: briefClock } : {}), ...sanitizeSoftDeleteFields(record) };
    }
    default:
      return null;
  }
}

/**
 * Wire-safe projection of a top-level state file. The 60s snapshot loop
 * stripped `runs[]` from `universe-builder.json` here inline; centralising it
 * means the per-record push uses the same rule when it bootstraps a peer with
 * the full universe set on first subscribe.
 *
 * Returns `{ kind, data }` so callers can pass the result straight to
 * `computeChecksum` and the receiver-side merge entry points.
 */
export function sanitizeStateForWire(kind, state) {
  if (!state || typeof state !== 'object') return { kind, data: null };
  switch (kind) {
    case 'universe': {
      const universes = Array.isArray(state.universes)
        ? state.universes
            .map((u) => sanitizeRecordForWire('universe', u))
            .filter(Boolean)
        : [];
      // `runs[]` is local LLM run history (transcripts, ephemeral). Each peer
      // keeps its own — never cross the wire.
      return { kind, data: { universes } };
    }
    case 'pipeline': {
      const series = Array.isArray(state.series)
        ? state.series
            .map((s) => sanitizeRecordForWire('series', s))
            .filter(Boolean)
        : [];
      // Cascade ephemeral protection from series to their child issues.
      // `updateSeries` doesn't auto-flip every child issue's `ephemeral` flag
      // when the parent is marked ephemeral, so an unfiltered issues array
      // would leak private issue stages (prose, comic pages, render
      // metadata) even though the parent series itself is filtered out.
      // Build the set of locally-ephemeral series ids by inspecting the
      // raw state.series (NOT the sanitized array — `sanitizeRecordForWire`
      // strips the ephemeral flag on the way out so it can't be used as
      // the gate).
      const ephemeralSeriesIds = Array.isArray(state.series)
        ? new Set(state.series.filter((s) => s?.ephemeral === true).map((s) => s.id))
        : new Set();
      const issues = Array.isArray(state.issues)
        ? state.issues
            .filter((i) => !ephemeralSeriesIds.has(i?.seriesId))
            .map((i) => sanitizeRecordForWire('issue', i))
            .filter(Boolean)
        : [];
      return { kind, data: { series, issues } };
    }
    case 'mediaCollections': {
      const collections = Array.isArray(state.collections)
        ? state.collections
            .map((c) => sanitizeRecordForWire('mediaCollection', c))
            .filter(Boolean)
        : [];
      return { kind, data: { collections } };
    }
    default:
      return { kind, data: null };
  }
}
