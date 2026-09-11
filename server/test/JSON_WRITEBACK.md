# JSON write-back prevention guard

Run from `server/`: `node_modules/.bin/vitest run jsonWritebackConventions.test.js`.
The guard parses service source only; it never imports services, reads runtime
records, connects to a database, or requires git history to run.

A direct `readJSONFile` call and `atomicWrite` call with the same normalized
first argument in the same service module require either statically strict reads
or an explicit lifecycle exception in `jsonWritebackExceptions.js`. New pairs
fail as unclassified; removed/strict-converted pairs fail as stale exceptions.
Every exception records why a fallback cannot overwrite durable records. Review
that reason against the caller whenever the lifecycle changes. This is a review
inventory guard, not a proof that all exceptional control flow remains safe.

## Syntax and limits

Babel parses real call expressions, including nested arguments, options and
calls inside template interpolations. Comments and strings describing calls do
not count. Path tokens ignore formatting and comments, normalize string quotes,
and preserve literal contents. Keys contain no positions. Literal `strict: true`
in the third argument and `readJSONFileStrict` are strict. A subsequent spread,
computed key, or false/unknown strict property invalidates that proof; an earlier
spread followed by literal strict:true is safe. Mixed strict/non-strict reads of
one path still require classification. Dynamic strict options require manual
caller review, including the strict defaults in Ask and POST run storage.

This is deliberately same-expression, same-module syntax matching, not
whole-program dataflow. It recognizes direct names and named import aliases;
it does not resolve scopes/shadowing, namespace calls, wrapper functions,
aliased path variables, equivalent path-building expressions, or different
parameter names across functions. Same-name locals in unrelated functions can
be false positives. A changed expression can therefore leave this scanner's
coverage; the stale-entry failure calls attention to existing exceptions that
move. There is no blanket module exemption and no assertion that 79 modules
represent every JSON lifecycle in PortOS.

The sibling audits explicitly checked paths outside exact-expression matching:

- Alcohol/Nicotine daily logs go through `loadDailyLog` and `readLocalDailyLog`;
  all mutation callers pass strict:true. MortalLoom response summaries are
  read-only, and its imported destination aliases are preflighted strictly.
- Ask's `pathFor(conversationId)` mutation and `pathFor(id)` listing share a
  strict-by-default loader; only aggregation opts out and skips null records.
- Daily review history uses `reviewDate`, while confirmation uses `date` and a
  strict loader. These expressions deliberately do not compare equal.
- Sprite generation, candidate listing, approval, runtime pointers and run
  records use different local aliases. The media audit made mutable provenance,
  geometry and approval reads strict; source/projection-only fallbacks stay
  documented beside their calls. Candidate sidecars use new generated names.
- Sharing import/export reads include transport input and local merge-target
  aliases; the sync audit hardened the destination reads and annotation sources.
- MeatSpace's goals birth-date mirror gained a same-expression pair during the
  personal audit. It is an additional registry entry beyond the original 94:
  migration skips unreadable input, and mirror mutation preflights strictly.

## Baseline reconciliation

Historical audit at `d7e2fb47d`: **79 modules, 94 path pairs**. All seven sibling
PR classifications were reconciled with their merged source. **73 original
pairs now read strictly; 21 remain explicitly classified**, plus the additional
MeatSpace goals pair above (22 current exceptions). The registry gives the
concrete cache, authoritative-rebuild, or no-unsafe-write-back reason for each.
The table is a historical audit record, not a generated manifest or a fixed
allowlist of modules. Future service pairs are discovered directly at test time.

| Service module | Normalized path expression | Disposition after audits | Classification PR |
| --- | --- | --- | --- |
| agentRunReconciler.js | <code>path</code> | Reviewed exception (see registry) | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| agentRunTracking.js | <code>metaPath</code> | Reviewed exception (see registry) | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| albums/file.js | <code>ALBUMS_FILE</code> | Strict read | [#6984](https://github.com/atomantic/PortOS/pull/6984) |
| appleHealthIngest.js | <code>filePath</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| artists/file.js | <code>ARTISTS_FILE</code> | Strict read | [#6984](https://github.com/atomantic/PortOS/pull/6984) |
| askConversations.js | <code>pathFor ( id )</code> | Reviewed exception (see registry) | [#6983](https://github.com/atomantic/PortOS/pull/6983) |
| authors/file.js | <code>AUTHORS_FILE</code> | Strict read | [#6984](https://github.com/atomantic/PortOS/pull/6984) |
| autobiography.js | <code>CONFIG_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| autobiography.js | <code>STORIES_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| autonomousJobs/store.js | <code>JOBS_FILE</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| backup.js | <code>STATE_PATH</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| backup.js | <code>manifestPath</code> | Reviewed exception (see registry) | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| bibleStore.js | <code>filePath ( workId )</code> | Strict read | [#6983](https://github.com/atomantic/PortOS/pull/6983) |
| brainJournal.js | <code>OBSIDIAN_LOCATIONS_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| brainParity.js | <code>REPORTS_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| calendarAccounts.js | <code>ACCOUNTS_FILE</code> | Strict read | [#6978](https://github.com/atomantic/PortOS/pull/6978) |
| character.js | <code>CHARACTER_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| claudeChangelog.js | <code>STATE_FILE</code> | Reviewed exception (see registry) | [#6978](https://github.com/atomantic/PortOS/pull/6978) |
| creative/creativeRunLedger.js | <code>file</code> | Strict read | [#6983](https://github.com/atomantic/PortOS/pull/6983) |
| dailyDriver.js | <code>FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| dailyReview.js | <code>join ( REVIEW_DIR , &#96;  ${ date } .json &#96; )</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| dataSync.js | <code>CHARACTER_FILE</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| dataSync.js | <code>GOALS_FILE</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| dataSync.js | <code>filePath</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| datadog.js | <code>DATADOG_CONFIG_FILE</code> | Strict read | [#6978](https://github.com/atomantic/PortOS/pull/6978) |
| digital-twin-sync.js | <code>TASTE_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| digital-twin-sync.js | <code>path</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| featureAgents.js | <code>FA_FILE</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| github.js | <code>REPOS_FILE</code> | Strict read | [#6978](https://github.com/atomantic/PortOS/pull/6978) |
| goalCalendarScheduler.js | <code>GOALS_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| imageTo3d/sourceKeying.js | <code>preparedCacheMetadataPath ( targetPath )</code> | Reviewed exception (see registry) | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| insightsService.js | <code>NARRATIVE_FILE</code> | Reviewed exception (see registry) | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| insightsService.js | <code>THEMES_FILE</code> | Reviewed exception (see registry) | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| maintenanceRun.js | <code>runsFile ( )</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| meatspace.js | <code>CONFIG_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| meatspaceAlcohol.js | <code>CUSTOM_DRINKS_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| meatspaceCalendar.js | <code>ACTIVITIES_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| meatspaceCalendar.js | <code>EVENTS_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| meatspaceNicotine.js | <code>CUSTOM_PRODUCTS_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| meatspacePost.js | <code>CONFIG_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| meatspacePostMemory.js | <code>MEMORY_ITEMS_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| meatspacePostMorse.js | <code>MORSE_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| meatspacePostReview.js | <code>REVIEW_SCHEDULE_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| mediaAnnotations.js | <code>STATE_PATH</code> | Strict read | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| mediaSketches.js | <code>jsonPathFor ( key )</code> | Reviewed exception (see registry) | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| modelPersonality.js | <code>resultsFile ( )</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| mortalLoomStore.js | <code>goalsPath</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| mortalLoomStore.js | <code>localPath</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| obsidian.js | <code>VAULTS_FILE</code> | Strict read | [#6978](https://github.com/atomantic/PortOS/pull/6978) |
| peerUsage.js | <code>PEER_USAGE_FILE</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| pipeline/continuityBible.js | <code>ledgerPath ( seriesId )</code> | Strict read | [#6983](https://github.com/atomantic/PortOS/pull/6983) |
| pipeline/editorialScore.js | <code>ledgerPath ( seriesId )</code> | Strict read | [#6983](https://github.com/atomantic/PortOS/pull/6983) |
| pipeline/manuscriptComments.js | <code>reviewPath ( seriesId )</code> | Strict read | [#6983](https://github.com/atomantic/PortOS/pull/6983) |
| pipeline/reverseOutline.js | <code>outlinePath ( seriesId )</code> | Strict read | [#6983](https://github.com/atomantic/PortOS/pull/6983) |
| postRunStore.js | <code>SESSIONS_FILE</code> | Reviewed exception (see registry) | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| postRunStore.js | <code>TRAINING_FILE</code> | Reviewed exception (see registry) | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| productivity.js | <code>PRODUCTIVITY_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| projectFileStore.js | <code>file</code> | Strict read | [#6983](https://github.com/atomantic/PortOS/pull/6983) |
| providerQuotaShare.js | <code>PROVIDER_QUOTAS_FILE</code> | Reviewed exception (see registry) | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| rounds.js | <code>STATE_PATH</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| sharing/annotationsSync.js | <code>recordPath</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sharing/buckets.js | <code>REGISTRY_PATH ( )</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sharing/buckets.js | <code>bucketJsonPath</code> | Reviewed exception (see registry) | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sharing/exporter.js | <code>bucketBlobIndexPath ( bucketPath )</code> | Reviewed exception (see registry) | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sharing/importer.js | <code>inboxPath ( bucketId )</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sharing/importer.js | <code>persistedPath</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sharing/manifest.js | <code>cursorPath ( bucketId )</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sharing/manifest.js | <code>join ( bucketPath , "manifests" , filename )</code> | Reviewed exception (see registry) | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sharing/subscriptions.js | <code>STATE_PATH ( )</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| sprites/atlas.js | <code>join ( dir , RUNTIME_POINTER_REL )</code> | Strict read | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| sprites/localAnimationJobHook.js | <code>recordPath</code> | Strict read | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| sprites/publish.js | <code>join ( dir , RUNTIME_PUBLICATIONS_REL )</code> | Strict read | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| sprites/recordsFile.js | <code>RECORDS_FILE</code> | Strict read | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| sprites/reference.js | <code>join ( candidatesDir , &#96;  ${ name . replace ( /\.png$/ , "" ) } .generation.json &#96; )</code> | Reviewed exception (see registry) | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| sprites/walk.js | <code>join ( spriteDir ( recordId ) , selectionRelPath ( recordId ) )</code> | Strict read | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| sprites/walk.js | <code>join ( spriteDir ( recordId ) , walkSetRelPath ( recordId ) )</code> | Strict read | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
| syncOrchestrator.js | <code>CURSORS_FILE</code> | Strict read | [#6982](https://github.com/atomantic/PortOS/pull/6982) |
| taskScheduleStore.js | <code>SCHEDULE_FILE</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| taskTemplates.js | <code>TEMPLATES_FILE</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| tools.js | <code>toolPath ( id )</code> | Reviewed exception (see registry) | [#6978](https://github.com/atomantic/PortOS/pull/6978) |
| tracks/file.js | <code>TRACKS_FILE</code> | Strict read | [#6984](https://github.com/atomantic/PortOS/pull/6984) |
| twinEnrichment.js | <code>CHRONOTYPE_OBSERVED_FILE</code> | Reviewed exception (see registry) | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| twinEnrichment.js | <code>TASTE_OBSERVED_FILE</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| updateChecker.js | <code>UPDATE_FILE</code> | Strict read | [#6978](https://github.com/atomantic/PortOS/pull/6978) |
| usageBackfill.js | <code>correction . metadataPath</code> | Reviewed exception (see registry) | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| usageReconciler.js | <code>metadataPath</code> | Reviewed exception (see registry) | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| userActions.js | <code>eventsFile ( )</code> | Strict read | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| videoTimeline/local.js | <code>PROJECTS_FILE</code> | Strict read | [#6984](https://github.com/atomantic/PortOS/pull/6984) |
| voice/timers.js | <code>STORE_PATH</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| weeklyDigest.js | <code>path</code> | Reviewed exception (see registry) | [#6981](https://github.com/atomantic/PortOS/pull/6981) |
| workspaceContext.js | <code>CONTEXTS_FILE</code> | Strict read | [#6980](https://github.com/atomantic/PortOS/pull/6980) |
| writersRoom/store.js | <code>wrExercisesFile ( )</code> | Strict read | [#6984](https://github.com/atomantic/PortOS/pull/6984) |
| writersRoom/store.js | <code>wrFoldersFile ( )</code> | Strict read | [#6984](https://github.com/atomantic/PortOS/pull/6984) |
| youtubeIngest.js | <code>INDEX_FILE</code> | Strict read | [#6979](https://github.com/atomantic/PortOS/pull/6979) |
