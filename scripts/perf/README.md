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
{ url, cardinalities, startup, close }. Always await close() in a finally block. It is
idempotent. /__fixture/ready returns the same readiness/cardinality information
without database identifiers, credentials, paths, or record payloads. The optional
clientDist argument selects an already-built client; it defaults to client/dist.
No development proxy is started.

Startup preserves the 30,000 ms overall worker readiness budget. A separate
10,000 ms no-progress deadline detects a stalled worker sooner; only an advancing
allowlisted phase or completed-record count resets it. Repeated heartbeats do not.
The optional `startupLimits: { overallTimeoutMs, noProgressTimeoutMs }` argument
accepts integer milliseconds from 100 through 120,000, with the no-progress limit
at most the overall limit. These are explicit experiment limits, not automatic
retries or pass thresholds. The worker budgets start after the parent source copy
and schema setup; startup diagnostics include those parent phases as well.

`startup` contains fixed phase names, elapsed/phase milliseconds, completed
image/video/account/message counts, and cumulative milliseconds awaiting file
writes and canonical media-index inserts. Eight records seed concurrently, with
two sequential file writes and one canonical upsert per record. A failed batch
drains its outstanding writes before cleanup. The time aggregates sum work across
records and can exceed elapsed wall time with concurrent seeding. Each phase
retains only its latest progress sample, bounding report size. Rejected startup
errors carry the same sanitized `fixtureStartup` snapshot and a fixed
`fixtureFailure` reason; exception text and worker stderr never enter reports.

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
npm test -- ../scripts/perf/collectionFixtureStartup.test.js ../scripts/perf/collectionFixtureLifecycle.test.js ../scripts/perf/collectionFixtureSeed.test.js
npm run test:db -- ../scripts/perf/collectionFixture.db.test.js
~~~

The non-DB tests cover pre-import isolation rejection, bounded concurrency,
failed-batch drainage, independent total/inactivity deadlines, sanitized IPC and
stalled-child cleanup with injected resources/time. The DB suite covers actual HTTP
pagination, projections, unavailable actions, and success/failure cleanup against
portos_test.

## Browser and CDP audit

With Google Chrome installed, run from the repository root:

~~~sh
npm run build
PGDATABASE=portos_test node scripts/perf/browserCollectionAudit.mjs /tmp/collection-audit.json
~~~

`COLLECTION_AUDIT_BROWSER` optionally selects a Chromium executable.
`COLLECTION_AUDIT_CLIENT_DIST` optionally selects an isolated production client
build for before/after comparisons; it never selects a live instance URL. The audit
uses the existing server `playwright-core`, a fresh context for each cold route,
no browser profile, no dev proxy, and no live-instance URL option. It owns and
closes the fixture and browser, including on SIGINT/SIGTERM. An output filename
must not already exist; omit it to print aggregate JSON. Exit 0 means all gates
passed; exit 1 means the report contains findings or measurement failed. A failed
gate is evidence to fix, never a reason to raise the limit until the run passes.

The report records:

- Fixture startup phases, aggregate seed work and counts on success or failure;
  startup failures retain specific fixed reasons instead of a generic audit error.
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
- Media History loaded at 60, 600 and at least 1,200 records, followed by a
  responsive resize during scrolling and a return to the top. Each sample records
  loaded/mounted/visible cards, columns, scroll geometry and CDP DOM nodes after
  garbage collection. Mounts are bounded by two overscan rows on each side,
  partial viewport rows and a focused row with keyboard neighbors (at most twelve
  rows in this fixture), independent of loaded count. Keyboard focus survives
  scrolling and responsive regrouping. No machine-specific timing gate applies.
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

### Route mode (`--route`)

When the live UI is password-protected the scheduled performance lane's browser
gets 401s, so UI request counts and idle bytes cannot be measured there. Run the
same CDP accounting against the passwordless synthetic fixture for any route:

~~~sh
npm run build
PGDATABASE=portos_test node scripts/perf/browserCollectionAudit.mjs --route=/ --sibling=/messages/contacts
~~~

`--route` (absolute path) is cold-loaded, then `--sibling` is loaded (default
`/messages/contacts`), then a 60 s idle window runs (`--idle-ms=1000..300000` for
quick checks). An optional positional output file works as before. The JSON report
holds, per phase (`cold`, `sibling`, `idle`), requests, encoded/decoded bytes and
WebSocket frames/payload bytes per endpoint pattern, plus `idleBytesPerMinute`.
Numeric and long-hex path segments collapse to `:id`; query strings, hosts, tokens
and bodies are never retained. Fixture-unavailable APIs (503) are counted under
`unavailable`; this is shell/dashboard traffic shape, not production endpoint timing.

Every traffic row also carries `duplicates` (same exact request repeated within a
phase), `overlapping` (repeated while an identical request was still in flight)
and `httpErrors` (status 400 or above); the exact URLs used to count them stay in
memory only.

## Live install audit (`liveBrowserAudit.mjs`)

The synthetic fixture cannot show production fan-out: unavailable APIs return
503 there, and its useful-content marker is only a visible shell. The live audit
is a separate, explicitly selected workflow against this machine's running
install. Its report says `"live": true, "synthetic": false`; never merge it with
fixture evidence.

~~~sh
node scripts/perf/liveBrowserAudit.mjs /tmp/live-audit.json
node scripts/perf/liveBrowserAudit.mjs --route=/messages/inbox --sibling=/messages/contacts --idle-ms=90000
~~~

Defaults: `--route=/media/history` (collection `/api/image-gen/gallery`),
`--sibling=/media/collections`, `--idle-ms=60000` (60,000–600,000).
`/messages/inbox` is also registered; any other static route needs
`--collection-endpoint=/api/...`. `LIVE_AUDIT_BROWSER` optionally selects a
Chromium executable. Phases:

- `cold` — fresh browser context, cache disabled, full load of `--route`.
  `usefulContentMs` ends when the route's collection response has finished, no
  loading skeleton (`role=status aria-busy=true`) remains, and no HTTP request
  other than Socket.IO polling (held open by design) is in flight; then a two-second tail catches eager follow-ups.
- `sibling` — in-app navigation (a visible link, else the data router via
  history) to `--sibling`, with the same completed-data rule. Refetching the
  route's collection here is a finding.
- `idle` — no interaction for the full window; `idleBytesPerMinute` reports
  HTTP encoded/decoded and Socket.IO payload bytes separately.

Per phase and endpoint pattern the report holds requests, completion, failure,
cancellation, HTTP errors, duplicates, overlapping duplicates, encoded/decoded
bytes and WebSocket frames/payload bytes, plus phase `totals`, `inFlight`
requests at the end and `blocked` requests. Findings:

- traffic: `http-error`, `request-failed`, `overlapping-duplicate-request`,
  `sibling-collection-refetch`, `blocked-foreign-origin`, `blocked-mutation`,
  `in-flight-at-end` (Socket.IO polling excluded), and `collection-http-status` (the route's collection
  response was not 2xx);
- runner: `browser-stage-<phase>` (a measurement stage broke), `browser-setup`
  (the context or page could not be prepared), `context-cleanup` and `cleanup`
  (the context or browser did not close). Exit 0 = measured with no findings, 1 = findings or a
failed stage, 2 = UNVERIFIED.

### Transport and authority

- Origin: `PORTOS_URL`, else the agent key file's URL, else the local listener
  (the same resolution as `scripts/portos-api.js`). Only plain-HTTP loopback
  with no path or userinfo is accepted; with HTTPS on, use the `:5553` mirror.
- Credential: the delegated agent session (`PORTOS_API_TOKEN`, else the Agent
  API key file). The instance password is never used. A Node preflight sends it
  as a bearer to that exact origin's `/api/auth/whoami` without following
  redirects. A password-free install needs no credential and none is attached.
- Browser: a fresh headless context with no profile and service workers
  blocked. Before the credential enters it, a guard aborts every request and
  WebSocket to any other origin (another loopback port included — cookies are
  not port-scoped) and every same-origin non-GET/HEAD/OPTIONS request except
  Socket.IO polling. The session is then installed as the install's
  port-scoped, host-only, HttpOnly, SameSite=Strict session cookie, so the UI
  and its Socket.IO handshake pass the normal auth gate; host-control and other
  gates are unchanged. The audit starts no provider, sync, send or host action:
  such writes are blocked and reported, not performed.
- Missing or rejected credential, a non-loopback origin, an unreachable
  install, no Chrome, or a redirect to `/login` produce `status: "unverified"`
  with a fixed `unverified.reason` and `nextStep`; no browser is launched for
  the preflight failures.

### Redaction

Labels come only from literals in server/routes: an API URL becomes its source
route pattern (`/api/messages/:accountId/:messageId`); an unmatched API path
keeps only its mount (`/api/image-gen/:unmatched`); `/assets/` and `/data/`
collapse; pages other than `/`, `--route` and `--sibling` become `/:page` or
`/:static`; other origins become `:foreign-origin`. Hosts, ports, queries,
headers, cookies, bodies and frames are never stored. Playwright errors become
fixed stage codes. Tests, from `server/`:

~~~sh
npm test -- ../scripts/perf/liveTraffic.test.js
~~~

They cover redaction of identifiers/credentials, the exact-origin bearer
preflight (no redirect following, decoy origin never contacted), guard order and
request/WebSocket decisions, and UNVERIFIED reports that launch no browser.

### Findings

The initial synthetic run identified media contract failures tracked in #8292:
full prompt fields in the first 60-row response (511,086 decoded bytes), totals
including hidden records, and no lazy media detail read. #8292 moved Media
History to visible-only compact rows (`hidden=false&compact=true`) with
single-record hydration on open; the fixture serves the same bounded image
lookup and video-history record readers the migrated UI calls. The media
scenario now passes with a 32,212-byte first page, visible/hidden totals of
3,240/360, no cold detail reads, and exactly one detail read when a row opens.
The fixture also serves image variant lineage (`/api/image-gen/:filename/variants`)
for the lightbox's current lazy-detail read. Inbox summary/detail and Contacts idle
gates passed, including a full idle minute with zero HTTP transfer and four
bytes of socket heartbeat payload. This runner does not claim all #8232
contracts are met.

#9676 moved the compact projection ahead of PostgreSQL for no-search pages:
the bound video-history parameter for the 60-row mixed page fell from
10,297,081 to 705,481 bytes, the SQL result from 511,058 to 31,998 bytes, and
the plan's temporary I/O from 2,682 blocks each way to none at the default
work_mem. Searches still match the full stored metadata. The browser response
is unchanged at 32,212 decoded bytes. `galleryCollections.db.test.js` prints
these measurements with `PORTOS_COLLECTION_BENCHMARK=1`.
