# Isolated collection audit fixture

From a checkout with dependencies and portos_test already provisioned
(npm run setup:db:test), run this non-interactive command:

~~~sh
npm run build && PGDATABASE=portos_test node scripts/perf/collectionFixture.js
~~~

The command prints one JSON readiness record with a loopback URL and cardinalities.
Visit /media/history or /messages/inbox on that URL. Send SIGINT or SIGTERM to stop;
the launcher closes the child, drops its own PostgreSQL schema, and removes its
temporary directory. Initialization failures also clean up. As with any process,
SIGKILL or machine power loss cannot run cleanup; use graceful shutdown.

A future CDP runner can import startCollectionFixture() and use its returned
{ url, cardinalities, close }. Always await close() in a finally block. It is
idempotent. /__fixture/ready returns the same readiness/cardinality information
without database identifiers, credentials, paths, or record payloads. The optional
clientDist argument selects an already-built client; it defaults to client/dist.
No development proxy is started.

The fixed dataset contains 2,400 PNG images, 1,200 one-second MP4 videos and their
PNG thumbnails, and 4,000 messages across two disabled synthetic accounts. Every
tenth media record is hidden (240 images and 120 videos). Prompts and message
detail fields contain 8,192 characters. Ordering, IDs, and content are deterministic;
all addresses use example.com. Assets are generated colored rectangles. Reproduce
the checked-in clip with:

~~~sh
ffmpeg -f lavfi -i color=c=0x335577:s=640x360:r=1 -t 1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart synthetic.mp4
~~~

## Isolation and measurement boundary

- Only portos_test on loopback is accepted. TEST_DB_OK cannot override this.
  The launcher verifies the connected database and creates a fresh
  collection_audit_<random> schema. The child has only that schema in search_path
  and verifies the database/schema before seeding. Canonical media table/index
  DDL and mediaAssetIndex row transforms/writes are reused. No shared table is
  truncated or cleaned. Concurrent runs use separate schemas.
- An inherited PORTOS_DATA_ROOT, production database name, remote database host,
  alternate database service/URL, or non-loopback bind is refused before server
  imports. The launcher copies tracked server/library source to a fresh temporary
  directory and links installed dependencies. It never copies runtime data,
  .env, browser profiles, or private keys. A physical source copy preserves the
  existing rule that CoS worktrees cannot redirect PATHS into a live install.
- The worker receives an explicit environment allowlist; provider keys, agent
  tokens, proxy configuration, NODE_OPTIONS, and test/file-backend switches are
  omitted. The production PostgreSQL gallery path is exercised. Message caches
  use the normal per-account JSON format below temporary PATHS.messages.
- Gallery list/facet/collection reads and inbox summary/detail reads reuse the
  production handlers and services. Pagination and projections happen server-side.
  No browser route interception or collection response mocks are used.
- The real built client and an idle Socket.IO transport are served on the fixture
  origin. Auth/settings bootstrap responses describe this synthetic environment.
  Unrelated APIs explicitly return FIXTURE_UNAVAILABLE (503); media mutations
  return 405. Record unavailable calls separately in browser reports; they are
  fixture limitations rather than production API performance evidence.
- No application boot entrypoint, scheduler, provider runner, peer connection,
  sync, or send endpoint is started. Accounts are disabled. A same-origin connect
  policy prevents the browser reaching the running install or external services.
  This covers collection loading, pagination, detail hydration, and idle
  observations; it is not a full-install end-to-end environment.

Tests, from server/:

~~~sh
npm test -- ../scripts/perf/collectionFixture.test.js
npm run test:db -- ../scripts/perf/collectionFixture.db.test.js
~~~

The first covers pre-import isolation rejection. The second covers actual HTTP
pagination, projections, unavailable actions, and success/failure cleanup against
portos_test.

## Browser and CDP audit

With Google Chrome installed, run from the repository root:

~~~sh
npm run build
PGDATABASE=portos_test node scripts/perf/browserCollectionAudit.mjs /tmp/collection-audit.json
~~~

`COLLECTION_AUDIT_BROWSER` optionally selects a Chromium executable. The audit
uses the existing server `playwright-core`, a fresh context for each cold route,
no browser profile, no dev proxy, and no live-instance URL option. It owns and
closes the fixture and browser, including on SIGINT/SIGTERM. An output filename
must not already exist; omit it to print aggregate JSON. Exit 0 means all gates
passed; exit 1 means the report contains findings or measurement failed. A failed
gate is evidence to fix, never a reason to raise the limit until the run passes.

The report records:

- Time from navigation start until the first visible synthetic collection row,
  then a two-second observation tail for eager fetches; 60 media cards / 50 inbox
  rows maximum, checked against response counts before client rendering.
- CDP requests, completion/failure/cancellation counts, encoded HTTP transfer
  bytes and decoded body bytes by endpoint and phase. Redirect hops count as
  requests; partial failed transfers retain observed bytes. Headers count toward
  encoded transfer; decoded counts use `dataReceived.dataLength`. Terminal totals
  reconcile observed encoded bytes rather than adding them twice. Cached contexts
  and service workers are disabled. In-flight requests are reported explicitly.
- WebSocket sent/received frame counts and payload bytes (UTF-8 text, decoded
  base64 binary). These exclude frame/TCP/TLS overhead and are separate from HTTP
  bytes; do not add a WebSocket handshake or frame twice. This is CDP accounting,
  not a packet capture.
- Detail reads after opening a row, then the real Contacts tab click and a full
  measured 60-second idle window. Idle bytes/minute use actual elapsed time,
  with HTTP encoded/decoded and socket payload bytes separate. Requests count in
  the phase they start; bytes count in the phase CDP observes them.

Only aggregates and fixed failure codes are retained. Query strings, hostnames,
record IDs, response bodies, headers, screenshots, HARs, and frames are not saved.
Response payloads are inspected transiently for pagination, totals, hidden media,
and compact projections (at most 2 KiB per permitted list row; prompt previews
at most 512 characters, no inbox bodies or evaluation reasoning). Unrelated
fixture 503s are counted separately as unavailable, not production failures.
The fixture's unavailable password-check dialog is dismissed through the UI in
the disposable browser; this does not accept risk or change any live install.
Contacts APIs remain unavailable: its route/idle traffic is measured, not contact
loading performance. Timing is diagnostic, with no machine-specific threshold.

Run deterministic accounting and regression-gate tests from `server/`:

~~~sh
npm test -- ../scripts/perf/collectionTraffic.test.js
~~~

### Initial findings

The initial synthetic run identified media contract failures tracked in #8292:
full prompt fields in the first 60-row response (511,086 decoded bytes), totals
including hidden records, and no lazy media detail read. These remain hard
failures, not an accepted baseline. Inbox summary/detail and Contacts idle gates
passed, including a full idle minute with zero HTTP transfer and four bytes of
socket heartbeat payload. Completing #8292 is necessary before this audit can
report an overall pass. This runner does not claim all #8232 contracts are met.
