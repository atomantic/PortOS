# Casting detail loading

Tracking: #13627. Builds on the canonical primitive model delivered in #13626.

## Baseline and limits

Six read-only API requests against the user-supplied representative record:

| Projection | Samples (ms) | Response bytes |
| --- | --- | --- |
| Basic record | 414, 928, 502 | 15,644 |
| Full details | 2,198, 1,853, 6,762 | 339,619 |

Media was 241,682 bytes; revision snapshots were 82,175 bytes. Together they
accounted for about 95% of detail bytes. These are loaded-host observations,
not isolated database timings. No record content, private URL or record ID is
included here. Browser selection timed out twice, so a live browser waterfall
was not obtained. No live after-change speedup has been measured or claimed.

The source reads media twice for full details, once for attachments and once
for integrity. Revision snapshots and media block the original first render.
Consolidation/identity manager bodies already mount lazily; they do not need a
new eager-fetch workaround. Catalog types have a synchronous fallback, and the
character LoRA lookup is scoped to this primitive and follows first render.

A mock query-seam fixture measured 3, 21 and 101 direct SQL calls in the old
usage helper for 1, 10 and 50 matching canon entries. That baseline excludes
the identity lookup and its separate universe/prose adapters. The batched
helper issues four direct statements for the same sizes, including its scoped
prose query; it still has one separate identity lookup. This is a count/scaling
measurement, not a latency benchmark. The PostgreSQL contract test verifies
the real statements in hosted test infrastructure; do not run it against live
data.

## Changes

- Keep the full details response as the compatibility default. Library editors
  request `view=profile`, retaining identity fences, editable payload, sources,
  relations, small cover keys and direct ownership/reference labels while
  omitting media/history and deferring derived story usage.
- Fetch `view=media` on the first media-tab visit. Derive integrity from the same
  returned rows. Revision history loads explicitly, with unavailable, loading,
  failed and legitimately empty states kept distinct.
- Refresh core identity/context through the same lean projection. Keep drafts,
  prevent stale secondary responses from winning, and refresh already loaded
  media in the background after reconnect/change without unmounting panels.
  Media that has never been opened remains deferred.
- Project only the selected identity's canon IDs/names/aliases. Batch FableLoom
  pointers, voice bindings and series/issue prose through indexed universe and
  series scopes. Reuse the existing prose matchers. Avoid loading every series
  or repeatedly scanning stories per canon entry.
- Keep known direct usage visible during secondary work; pending/failed derived
  usage never appears as a confirmed unused result. Preserve missing targets
  and retained references without dead links.

## Verification

The focused synthetic HTTP/service pass completed with nine assertions and
clean process settlement. Its full response was 333,908 bytes versus 14,866
bytes for the profile projection. The first client pass completed 101 cases;
one new thumbnail URL expectation was corrected and passed on focused rerun.
The subsequent cover-cache regression passed after the source-review fix.
PostgreSQL execution and exact-head hosted coverage remain pending publication.

Use synthetic HTTP/component regressions for early useful profile rendering,
lazy secondary reads, errors/retries, stale responses and full-detail
compatibility. Verify emitted statement count is independent of canon size.
Record payload measurements separately from live timings. Run the focused gate,
independent review and exact-head hosted CI when local resource/settlement
health is verified. Do not deploy, restart services, run live fixtures, change
production data or alter the representative character/assets to benchmark.
