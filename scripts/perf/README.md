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
