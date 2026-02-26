---
phase: 03-apple-health-integration
plan: 02
subsystem: api
tags: [apple-health, sax, xml, streaming, multer, websocket, react, file-upload]

# Dependency graph
requires:
  - phase: 03-apple-health-integration
    plan: 01
    provides: readDayFile/writeDayFile/extractDateStr from appleHealthIngest.js, existing POST /ingest and GET routes

provides:
  - SAX streaming XML parser for Apple Health export.xml files (500MB+ without OOM)
  - POST /api/health/import/xml with multer diskStorage upload
  - Real-time WebSocket progress (health:xml:progress, health:xml:complete)
  - normalizeXmlRecord() pure function for HK identifier mapping
  - Working Apple Health XML Import section in Import tab

affects:
  - 03-03-apple-health-insights
  - meatspace health data availability

# Tech tracking
tech-stack:
  added:
    - sax (SAX streaming XML parser, non-strict mode for malformed Apple Health XML)
    - multer (multipart file upload with diskStorage to avoid OOM on large files)
  patterns:
    - SAX stream piped from createReadStream for memory-efficient XML parsing
    - Post-parse aggregation pattern (collect all records first, then aggregate outside SAX event loop)
    - WebSocket progress emission every N records for long-running imports
    - Raw fetch() for file uploads (bypasses request() helper's Content-Type: application/json)
    - useEffect socket listener cleanup pattern for WebSocket events in React

key-files:
  created:
    - server/services/appleHealthXml.js
  modified:
    - server/routes/appleHealth.js
    - client/src/services/api.js
    - client/src/components/meatspace/tabs/ImportTab.jsx
    - .changelog/v1.7.x.md

key-decisions:
  - "SAX non-strict mode (createStream(false)) handles malformed Apple Health XML gracefully; error handler clears parser error and resumes"
  - "Post-parse aggregation: collect all records in dayBuckets map first, then aggregate step_count (sum) and sleep_analysis (stage durations) after stream ends — avoids complexity in SAX event callbacks"
  - "multer diskStorage (not memoryStorage) for XML upload route — prevents OOM on 500MB+ files by writing to tmpdir immediately"
  - "uploadAppleHealthXml uses raw fetch() not the request() helper — request() sets Content-Type: application/json which conflicts with multipart/form-data boundary"
  - "Indeterminate progress bar with live record count — total record count is unknown before parsing ends"

patterns-established:
  - "Pattern 1: SAX streaming with post-parse aggregation — parse into buckets, aggregate after stream ends, then write files sequentially"
  - "Pattern 2: WebSocket progress for long-running server operations — emit every N records with processed count"
  - "Pattern 3: Raw fetch for multipart uploads in PortOS client — api.js request() is JSON-only"

requirements-completed:
  - HLT-03
  - HLT-04

# Metrics
duration: 3min
completed: 2026-02-26
---

# Phase 3 Plan 02: Apple Health XML Import Summary

**SAX streaming XML import pipeline for 500MB+ Apple Health exports with multer diskStorage, HK identifier normalization, sleep/step aggregation, and real-time WebSocket progress in Import tab**

## Performance

- **Duration:** ~7 min (including human-verify checkpoint)
- **Started:** 2026-02-26T23:30:08Z
- **Completed:** 2026-02-26T23:37:06Z
- **Tasks:** 3 of 3 (including Task 3 checkpoint:human-verify — approved)
- **Files modified:** 5

## Accomplishments

- Created `appleHealthXml.js` SAX streaming service: parses Apple Health export.xml without loading into memory, normalizes HK identifiers, aggregates step counts and sleep stage durations per day
- Added `POST /api/health/import/xml` route with multer diskStorage (2GB limit), emitting WebSocket progress every 10k records
- Replaced Import tab Apple Health placeholder with working XML file picker, indeterminate progress bar showing live record count, and success/error states

## Task Commits

1. **Task 1: Create SAX XML streaming service and add XML import route** - `8967415` (feat)
2. **Task 2: Update Import tab with Apple Health XML file picker and progress bar** - `a4b2d20` (feat)
3. **Task 3: Verify XML import and ingest pipeline (checkpoint:human-verify)** - Approved by human; no code commit

## Files Created/Modified

- `/Users/antic/github.com/atomantic/PortOS/server/services/appleHealthXml.js` - SAX streaming parser: normalizeXmlRecord(), importAppleHealthXml(), sleep/step aggregation
- `/Users/antic/github.com/atomantic/PortOS/server/routes/appleHealth.js` - Added multer config and POST /import/xml route
- `/Users/antic/github.com/atomantic/PortOS/client/src/services/api.js` - Added uploadAppleHealthXml() using raw fetch for multipart
- `/Users/antic/github.com/atomantic/PortOS/client/src/components/meatspace/tabs/ImportTab.jsx` - Working XML import section replacing disabled placeholder
- `/Users/antic/github.com/atomantic/PortOS/.changelog/v1.7.x.md` - Added Apple Health XML import entries

## Decisions Made

- SAX non-strict mode (`sax.createStream(false, { lowercase: true })`) handles Apple Health's occasionally malformed XML; error handler clears parser state and resumes rather than aborting
- Post-parse aggregation approach: collect all records into `dayBuckets` map during SAX events, then aggregate after stream ends (outside event callbacks for simplicity)
- `multer.diskStorage` for upload route prevents OOM on 500MB+ files — writes to system tmpdir immediately, no in-memory buffering
- `uploadAppleHealthXml` uses raw `fetch()` not the `request()` helper — the helper hardcodes `Content-Type: application/json` which would break multipart/form-data boundary
- ServerError constructor corrected to use `{ status: 400, code: 'BAD_REQUEST' }` object signature (not positional statusCode) matching the existing class definition

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ServerError constructor call signature**
- **Found during:** Task 1 (adding XML import route)
- **Issue:** Plan showed `new ServerError('Only XML files are accepted', 400)` but the ServerError constructor takes `(message, options = {})` not `(message, statusCode)`
- **Fix:** Changed to `new ServerError('...', { status: 400, code: 'BAD_REQUEST' })`
- **Files modified:** `server/routes/appleHealth.js`
- **Verification:** Routes file loads cleanly via Node.js import test
- **Committed in:** `8967415` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug)
**Impact on plan:** Necessary correction to match existing codebase conventions. No scope creep.

## Issues Encountered

None beyond the auto-fixed ServerError constructor mismatch above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- XML import pipeline complete and verified: automated tests pass (1192), client builds cleanly, human checkpoint approved
- Plan 03-03 (Apple Health insights/visualization) can proceed immediately
- Data from both XML import and JSON ingest is available in the same day-file format under data/health/
- No blockers for 03-03

---
*Phase: 03-apple-health-integration*
*Completed: 2026-02-26*
