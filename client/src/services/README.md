# client/src/services/ — HTTP, sockets, and browser-facing clients

API wrappers, Socket.IO client, and browser-facing clients (voice, DOM, UI dispatch).
**Before adding a new HTTP call inline, grep this catalog first** — almost every backend
domain already has a service file.

`api.js` is a barrel that re-exports everything from the `apiX.js` files; callers can
either `import * as api from '.../services/api'` or `import { specificFn } from '.../services/apiX'`.

This directory has no `index.js` barrel because every file already follows the `apiX.js`
naming convention, and `api.js` already aggregates them. When you add a new `apiX.js`,
add it to `api.js` and add a row here.

## Discovery rule

```
grep -i "what you want to do" client/src/services/README.md
```

The `request()` helper in `apiCore.js` toasts errors by default. Pass `{ silent: true }`
when the caller owns its own error UI (custom catch + toast, or `useAsyncAction` which
toasts on throw). **Custom catch ⇒ `silent: true`** — otherwise toasts fire twice.

---

## Core / infrastructure

| File | Purpose |
|---|---|
| `api.js` | Barrel — re-exports every `apiX.js`. |
| `apiCore.js` | `request()` helper + stable PortOS-app id. Shared error / toast handling. |
| `socket.js` | Singleton Socket.IO client over relative path (Tailscale-friendly). |
| `appUrls.js` | Compute candidate launch URLs for an app from page context. |

## App lifecycle / system

| File | Purpose |
|---|---|
| `apiApps.js` | App CRUD + PM2 ops (start/stop/restart/logs). |
| `apiAccounts.js` | Platform accounts. |
| `apiAgents.js` | Running-agent process management. |
| `apiCommands.js` | CLI command dispatch. |
| `apiDashboard.js` | Dashboard state. |
| `apiDatabase.js` | Database introspection. |
| `apiGit.js` | Git operations. |
| `apiGithub.js` | GitHub repo metadata. |
| `apiHistory.js` | Historical logs / runs. |
| `apiPorts.js` | Port forwarding / allocation. |
| `apiProviders.js` | AI provider config. |
| `apiReferenceRepos.js` | Per-app reference-repo registry. |
| `apiReview.js` | Review hub. |
| `apiRuns.js` | Agent run history. |
| `apiScaffold.js` | App scaffolding templates. |
| `apiSchedules.js` | Automation schedules. |
| `apiSystem.js` | System info (CPU/memory/ports/alerts). |
| `apiLoops.js` | Scheduled loops. |

## Personal data / identity

| File | Purpose |
|---|---|
| `apiBrain.js` | Brain (second-brain) search + ingest + edit. |
| `apiMemory.js` | Memory CRUD. |
| `apiNotes.js` | Notes vault. |
| `apiDigitalTwin.js` | Digital twin status + summary. |
| `apiGoals.js` | Identity / goals tracking. |
| `apiHealth.js` | Apple Health. |
| `apiMeatspace.js` | MeatSpace (genome + location). |
| `apiMortalLoom.js` | Mortality tracking. |
| `apiCalendar.js` | Calendar events. |
| `apiMessages.js` | Messages / notifications. |
| `apiPersonalities.js` | Agent personality profiles. |

## Media / creative

| File | Purpose |
|---|---|
| `apiImageVideo.js` | Image-gen local backend extras (gallery, models, LoRAs, cancel, delete). |
| `apiMedia.js` | Screenshots + media assets. |
| `apiMediaJobs.js` | Media generation job tracking. |
| `apiCreativeDirector.js` | Creative Director (video production). |
| `apiPipeline.js` | Pipeline (issues + stages + canon). |
| `apiUniverseBuilder.js` | Universe Builder (generate + edit + commit). |
| `apiWritersRoom.js` | Writers Room (folders + works + drafts). |
| `apiSharing.js` | Share buckets + federation sync. |

## Tools / integrations

| File | Purpose |
|---|---|
| `apiAsk.js` | Ask page (chat-like). |
| `apiGSD.js` | "Get Stuff Done" integration. |
| `apiImporter.js` | Manuscript / chat importer. |
| `apiOpenClaw.js` | File browser / picker backend. |
| `apiPalette.js` | Command-palette manifest + action dispatch. |
| `apiVoice.js` | Voice synthesis / processing. |

## Browser-facing (DOM, voice, build) — not pure API wrappers

| File | Purpose |
|---|---|
| `voiceClient.js` | Browser-side voice capture + playback (two modes). |
| `voiceVisibility.js` | Voice UI state manager. |
| `uiInteract.js` | Execute voice `ui_click` / `ui_fill` / `ui_select` against live DOM. |
| `domIndex.js` | DOM indexer for voice accessibility mode. |
| `staleBuildToast.jsx` | Sticky toast shown when server's build id differs from client's. |
