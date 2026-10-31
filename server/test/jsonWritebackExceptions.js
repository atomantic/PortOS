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
    "key": "auth.js :: SESSIONS_FILE",
    "reason": "Rebuildable: a lost session file only signs browsers out (login mints new sessions); it never grants access."
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
    "key": "clinvar.js :: CLINVAR_INDEX",
    "reason": "Cache-only: syncClinvar rebuilds the index and its metadata wholesale from the NCBI download; reads never feed a write."
  },
  {
    "key": "codexSummaryRepair.js :: metaPath",
    "reason": "No failed-read write-back: an unreadable or non-object metadata file returns null before the repair write."
  },
  {
    "key": "contactsSync.js :: cachePath ( )",
    "reason": "Cache-only: each sync replaces the whole contact cache from the source; the tolerant read only serves the UI."
  },
  {
    "key": "contactsSync.js :: statePath ( )",
    "reason": "Rebuildable status: a lost last-run record only resets the displayed run status; the next sync rewrites it."
  },
  {
    "key": "cosAgentCompletionIndex.js :: orderFilePath ( )",
    "reason": "Derived projection: an absent or corrupt file reads as empty and is backfilled from the archive metadata."
  },
  {
    "key": "cosReports.js :: reportFile",
    "reason": "No write-back cycle: reports are generated from agent records and written whole; getReport only projects a stored report."
  },
  {
    "key": "errorLogTriage.js :: stateFile",
    "reason": "No failed-read write-back: readState reads strictly (strict:true), so a corrupt store throws instead of resetting the cursors; only an absent file seeds the empty state."
  },
  {
    "key": "imageTo3d/sourceKeying.js :: preparedCacheMetadataPath ( targetPath )",
    "reason": "Cache-only: source bytes and the explicit keying/framing request rebuild the prepared image metadata."
  },
  {
    "key": "imessageSync.js :: stateFilePath ( )",
    "reason": "Rebuildable cursor: losing it re-reads recent messages, and the imsg:<guid> dedupe key makes the replay idempotent."
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
    "key": "localModelAssessmentStore.js :: assessmentsFile ( )",
    "reason": "Non-lossy: saveAssessment quarantines an unreadable store to a .corrupt-<ts> sibling before writing, and deleteAssessment refuses."
  },
  {
    "key": "meatspaceDailyLog.js :: DAILY_LOG_FILE",
    "reason": "No non-strict write-back: UI reads stay tolerant, but mutateDailyLog is the only writer and always reads with strict: true before atomicWrite.",
    "issue": "#8032"
  },
  {
    "key": "meatspacePostDrillCache.js :: CACHE_FILE",
    "reason": "Cache-only: a lost drill cache costs one refill."
  },
  {
    "key": "mediaSketches.js :: jsonPathFor ( key )",
    "reason": "No write-back cycle: the read projects the canvas; explicit save replaces the complete canvas supplied by the user."
  },
  {
    "key": "messageSync.js :: filePath",
    "reason": "Rebuildable cache: the per-account message cache and sync cursor are re-fetched from the provider; an unreadable cache reads as empty."
  },
  {
    "key": "modelCapabilityTestStore.js :: storeFile ( )",
    "reason": "Non-lossy: saveResult quarantines an unreadable store to a .corrupt-<ts> sibling before writing, and deleteResult refuses."
  },
  {
    "key": "ollamaSafetensorsImport.js :: markerPath ( tempRoot )",
    "reason": "Rebuildable canary: the staging marker lives in an OS temp import directory. An unreadable marker rewritten with only the new phase loses its model id, which the sweep treats like a marker-less directory: age-gated cleanup of re-downloadable weights, never a user record."
  },
  {
    "key": "pm2.js :: dumpPath",
    "reason": "No failed-read write-back: dropFromSavedList returns before the write when the dump is absent, unparseable, or not an array."
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
    "key": "runtimeUpdateReview.js :: CACHE_FILE",
    "reason": "Regenerable machine-local status cache: an unreadable file leaves update checks unverified until fresh observations rebuild it; it contains no user-authored records."
  },
  {
    "key": "settings.js :: SETTINGS_FILE",
    "reason": "Tolerant loadRaw serves display reads; partial writers must read strictly and refuse (fix in #12451, which also covers .env). Remove this entry if the scan stops reporting the pair.",
    "issue": "#12451"
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
    "key": "signalSync.js :: stateFilePath ( )",
    "reason": "Rebuildable cursor: losing it re-reads recent messages, and the signal:<messageId> dedupe key makes the replay idempotent."
  },
  {
    "key": "spotifySync.js :: stateFilePath ( )",
    "reason": "Rebuildable cursor: losing it re-polls the recently-played window, and the spotify:<played_at>:<trackId> dedupe key makes the replay idempotent."
  },
  {
    "key": "sprites/reference.js :: join ( candidatesDir , `${ name . replace ( /\\.png$/ , \"\" ) }.generation.json` )",
    "reason": "No same-record write-back cycle: listing reads generation sidecars, generation writes new candidate names; approval reads provenance strictly."
  },
  {
    "key": "superColliderRuntime.js :: evidencePath",
    "reason": "Authoritative rebuild: each probe writes a complete new evidence record from its own render; the tolerant read only feeds the status verdict and never a write.",
    "issue": "#9412"
  },
  {
    "key": "supersededLedger.js :: ledgerPath ( cosDir )",
    "reason": "Rebuildable verdict cache: a missing or malformed ledger fails open to re-analysis of the affected branches."
  },
  {
    "key": "taste-questionnaire.js :: TASTE_PROFILE_FILE",
    "reason": "No non-strict write-back: the tolerant read serves display only; every mutation reads with readJSONFile strict:true via readProfileForMutation."
  },
  {
    "key": "tools.js :: toolPath ( id )",
    "reason": "No failed-read write-back: updateTool returns on null; registerTool is an explicit complete replacement."
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
  },
  {
    "key": "youtubeSync.js :: stateFilePath ( )",
    "reason": "Rebuildable cursor: losing it re-reads recent history, and the yt:<videoId>:<localDay> dedupe key makes the replay idempotent."
  }
];
