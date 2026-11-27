# Media operation status and cancellation

Use the active run ID when canceling a run you already inspected. Cancellation requires [operator authority](../API.md#security-model).

| Endpoint | Behavior |
|---|---|
| `POST /api/media/collections/:id/primary/cancel` | Request cancellation after the current file settles. Pass `{ runId }` from `GET /api/media/collections/:id/primary` to target a specific run. Returns 202 with the run ID, or 404 when there is no matching active run. Completed transfers and releases are kept. |
| `GET /api/music-video/:id/research` | Lists active shot and cameo research in `{ runs }`, with a `runId`, target ID and status (`running`, `cancelling` or `saving`). |
| `POST /api/music-video/:id/research/cancel` | Pass `{ runId }` to cancel the matching project run, or omit it when exactly one run is active. Returns 202 when requested, 404 without a matching run, or 409 when a run must be selected or filing has started. The `music-video:research-seed` event reports `canceled` when research stops. Photos already imported remain in the gallery. |
| `GET /api/decks/:id/generate-prompts/status` | Returns `{ run }` with the active `runId` and status (`running` or `cancelling`), or `{ run: null }` when idle. |
| `POST /api/decks/:id/generate-prompts/cancel` | Returns 202 for a cancellation request. Pass `{ runId }` to target a specific run. Prompts already written remain on the deck. |
