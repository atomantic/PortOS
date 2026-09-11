// Reviewed lifecycle exceptions from #6970–#6976. Keys are service-relative
// module + normalized first argument, never source positions. See JSON_WRITEBACK.md.
export const JSON_WRITEBACK_EXCEPTIONS = [
  {
    "key": "agentRunReconciler.js :: path",
    "reason": "No failed-read write-back: repair planning and its final re-read skip null run metadata."
  },
  {
    "key": "agentRunTracking.js :: metaPath",
    "reason": "No failed-read write-back: completion returns on null before metadata or output writes."
  },
  {
    "key": "askConversations.js :: pathFor ( id )",
    "reason": "No non-strict write-back: mutations use the strict default; only the listing sweep passes strict:false and skips unreadable members."
  },
  {
    "key": "backup.js :: manifestPath",
    "reason": "No write-back cycle: snapshot generation builds manifests from snapshot files; listing and restore only consume them."
  },
  {
    "key": "claudeChangelog.js :: STATE_FILE",
    "reason": "Cache-only: feed polling replaces the feed cache and its polling/seen cursors; there is no user-edit writer."
  },
  {
    "key": "imageTo3d/sourceKeying.js :: preparedCacheMetadataPath ( targetPath )",
    "reason": "Cache-only: source bytes and the explicit keying/framing request rebuild the prepared image metadata."
  },
  {
    "key": "insightsService.js :: NARRATIVE_FILE",
    "reason": "No non-strict write-back: display getter is tolerant; narrative refresh reads strictly before retaining prior text and timestamp."
  },
  {
    "key": "insightsService.js :: THEMES_FILE",
    "reason": "Authoritative rebuild: theme extraction replaces the cache from source evidence without retaining prior fields."
  },
  {
    "key": "meatspace.js :: GOALS_FILE",
    "reason": "No failed-read write-back: legacy birth-date migration skips unreadable input; birth-date mirror mutations preflight with a strict read."
  },
  {
    "key": "mediaSketches.js :: jsonPathFor ( key )",
    "reason": "No write-back cycle: the read projects the canvas; explicit save replaces the complete canvas supplied by the user."
  },
  {
    "key": "postRunStore.js :: SESSIONS_FILE",
    "reason": "No non-strict write-back: loadFileSessions defaults strict=true and all mutation callers retain that default; tolerant reads cannot feed persistence."
  },
  {
    "key": "postRunStore.js :: TRAINING_FILE",
    "reason": "No non-strict write-back: loadFileTraining defaults strict=true and all mutation callers retain that default; tolerant reads cannot feed persistence."
  },
  {
    "key": "providerQuotaShare.js :: PROVIDER_QUOTAS_FILE",
    "reason": "No non-strict write-back: readLocalQuotaCards only projects UI cards; the quota merge writer reads strictly."
  },
  {
    "key": "sharing/buckets.js :: bucketJsonPath",
    "reason": "No non-strict write-back: the UI identity projection is tolerant; registration checks identity strictly before publishing."
  },
  {
    "key": "sharing/exporter.js :: bucketBlobIndexPath ( bucketPath )",
    "reason": "Cache-only: source path, mtime and size map to hashes rebuilt from authoritative source bytes, without records or tombstones."
  },
  {
    "key": "sharing/manifest.js :: join ( bucketPath , \"manifests\" , filename )",
    "reason": "No write-back cycle: transport manifests are input-only; exports build new manifests from authoritative records."
  },
  {
    "key": "sprites/reference.js :: join ( candidatesDir , `  ${ name . replace ( /\\.png$/ , \"\" ) } .generation.json ` )",
    "reason": "No same-record write-back cycle: listing reads generation sidecars, generation writes new candidate names; approval reads provenance strictly."
  },
  {
    "key": "tools.js :: toolPath ( id )",
    "reason": "No failed-read write-back: updateTool returns on null; registerTool is an explicit complete replacement."
  },
  {
    "key": "timeCapsule.js :: snapshotFile",
    "reason": "Immutable snapshots: createSnapshot writes a new UUID from freshly collected data; getSnapshot only displays existing snapshots and never writes its fallback back."
  },
  {
    "key": "twinEnrichment.js :: CHRONOTYPE_OBSERVED_FILE",
    "reason": "Authoritative rebuild: activity rows rebuild the complete chronotype histogram without retaining previous fields."
  },
  {
    "key": "usageBackfill.js :: correction . metadataPath",
    "reason": "No failed-read write-back: null metadata skips this correction, preserving bytes for repair and retry."
  },
  {
    "key": "usageReconciler.js :: metadataPath",
    "reason": "No failed-read write-back: null metadata skips marker persistence; accounting is owned by the usage ledger."
  },
  {
    "key": "weeklyDigest.js :: path",
    "reason": "Authoritative rebuild: generation replaces the target week from agent records; reads display or compare a previous week, not a write-back base."
  }
];
