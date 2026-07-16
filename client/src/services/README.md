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
| `apiWorkspaceContexts.js` | Per-project working-context save/restore (branch, shells, tasks). |
| `apiAccounts.js` | Platform accounts. |
| `apiAgents.js` | Running-agent process management. |
| `apiCommands.js` | CLI command dispatch. |
| `apiDashboard.js` | Dashboard state. |
| `apiDatabase.js` | Database introspection. |
| `apiLocalLlm.js` | Local LLM backends (Ollama / LM Studio): status (incl. installed models), catalog, model install/delete, backend install (Homebrew/script), switch/migrate. |
| `apiGit.js` | Git operations. |
| `apiGithub.js` | GitHub repo metadata. |
| `apiHistory.js` | Historical logs / runs. |
| `apiLogs.js` | PM2 system logs: fetch a process's recent log tail (process list comes from `apiCommands.getProcessesList`). |
| `apiPorts.js` | Port forwarding / allocation. |
| `apiProviders.js` | AI provider config. |
| `apiReferenceRepos.js` | Per-app reference-repo registry. |
| `apiReview.js` | Review hub. |
| `apiCodeReview.js` | Code Review Defaults (Review Loop reviewer chain + per-backend local-LLM model). |
| `apiCatalogTypes.js` | User-defined catalog ingredient types (list active registry + create/update/delete user types). |
| `apiRuns.js` | Agent run history. |
| `apiScaffold.js` | App scaffolding templates. |
| `apiSchedules.js` | Automation schedules. |
| `apiSystem.js` | System info (CPU/memory/ports/alerts) + D&D-style character sheet getter. |
| `apiAuth.js` | Optional login password — status, login/logout, set/clear password. |
| `apiLoops.js` | Scheduled loops. |

## Personal data / identity

| File | Purpose |
|---|---|
| `apiBrain.js` | Brain (second-brain) search + ingest + edit. |
| `apiMemory.js` | Memory CRUD. |
| `apiNotes.js` | Notes vault. |
| `apiDigitalTwin.js` | Digital twin status + summary. |
| `apiModelPersonality.js` | LLM personality self-profile tests: run, history, delete, scorer settings. |
| `apiGoals.js` | Identity / goals tracking. |
| `apiHealth.js` | Apple Health. |
| `apiMeatspace.js` | MeatSpace (genome + location). |
| `apiMortalLoom.js` | Mortality tracking. |
| `apiMoodBoard.js` | Mood boards (inspiration canvas + items). |
| `apiTribe.js` | Tribe people (relationship rings + contacts). |
| `apiCalendar.js` | Calendar events. |
| `apiMessages.js` | Messages / notifications + iMessage manager (#2413). |
| `apiContacts.js` | macOS Contacts sync + identity resolve + Tribe enrich (#2415). |
| `apiSignal.js` | Signal Desktop ingestion status / setup-check / sync. |
| `apiSpotify.js` | Spotify OAuth + listening-history sync. |
| `apiYoutube.js` | YouTube watch-history scrape sync + setup check. |
| `apiPersonalities.js` | Agent personality profiles. |

## Media / creative

| File | Purpose |
|---|---|
| `apiImageVideo.js` | Image-gen local backend extras (gallery, models, LoRAs, cancel, delete). |
| `apiLoraTraining.js` | Character LoRA training — datasets (CRUD, upload, generate, slice, caption), training runs (start/list/cancel/delete + status), character→LoRA link lookup. |
| `apiMedia.js` | Screenshots + media assets. |
| `apiMediaJobs.js` | Media generation job tracking. |
| `apiCreativeDirector.js` | Creative Director (video production). |
| `apiMusicVideo.js` | Music Video projects + scene board + audio analysis. |
| `apiPipeline.js` | Pipeline (issues + stages + canon). |
| `apiUniverseBuilder.js` | Universe Builder (generate + edit + commit). |
| `apiAuthors.js` | Author personas (name, writing style, bio, headshot description/style). |
| `apiArtists.js` | Music artist personas (name, genre, bio, musical style, portrait description/style). |
| `apiAlbums.js` | Music albums (title, artist FK + name, description, genre, release year, cover art, ordered track ids). |
| `apiTracks.js` | Music tracks (title, album/artist FKs, lyrics, prompt, gen metadata, audio-library pointer) + shared music-library list + audio upload/attach/clear. |
| `apiVideoDownload.js` | Dev Tools video downloader (#1946): start/cancel a YouTube/x.com full-video download via yt-dlp (SSE progress), list + delete downloaded clips. |
| `apiMusic.js` | On-device music generation (MusicGen / AudioLDM2 / ACE-Step): list engines (+ readiness) and generate a track from a prompt/lyrics. |
| `apiWritersRoom.js` | Writers Room (folders + works + drafts, live continuation + render-preview reservation, scene-image attach). |
| `apiSharing.js` | Share buckets + federation sync. |
| `apiRounds.js` | Rounds workbench CRUD (a cappella round writing + arranging voice layers + learning tracking). |
| `apiSongbook.js` | SongBook repertoire tracker (`/songbook` — Brain `songs` entity): song CRUD + stage PATCH, URL import draft, and attachments (base64 upload, present-flag list, raw serve URL via `songAttachmentUrl`). |
| `apiPeerSync.js` | Per-record peer sync subscriptions (universe + series → other PortOS instances over Tailnet). |
| `apiSyncReview.js` | Sync hygiene: duplicate-record detection + smart merge (universe/series) and the non-blocking edit-conflict journal (list/resolve). Surfaced in Sharing → Duplicates / Conflicts. |

## Tools / integrations

| File | Purpose |
|---|---|
| `apiAsk.js` | Ask page (chat-like). |
| `apiGSD.js` | "Get Stuff Done" integration. |
| `apiImporter.js` | Manuscript / chat importer. |
| `apiStoryBuilder.js` | Unified Story Builder conductor (sessions, step lock/unlock, generate/refine, cross-machine sync toggle + reconcile). |
| `apiOpenClaw.js` | File browser / picker backend. |
| `apiPalette.js` | Command-palette manifest + action dispatch. |
| `apiVoice.js` | Voice synthesis / processing. |
| `apiCity.js` | CyberCity snapshots — historical city-state series for the timeline scrubber (GET /snapshots, GET /config, POST /capture). |
| `apiPrivacy.js` | Privacy Center — encrypted PII Vault + Trusted Organizations registry (status, vault CRUD + reveal, org CRUD, org holdings replace-set) + Digital Twin social-account cross-link. |

## Browser-facing (DOM, voice, build) — not pure API wrappers

| File | Purpose |
|---|---|
| `voiceClient.js` | Browser-side voice capture + playback (two modes). |
| `browserLlm.js` | Client for Chrome's on-device "Gemini Nano" (Prompt API): dual-shape detection, availability enum, cached `promptNano()` with timeout. Tier 2 of the voice fast-resolution cascade. |
| `voiceFastPath.js` | Voice fast-resolution cascade: trigger nav → on-device Nano → server LLM. Decides how each spoken/typed turn is resolved. |
| `voiceVisibility.js` | Voice UI state manager. |
| `uiInteract.js` | Execute voice `ui_click` / `ui_fill` / `ui_select` against live DOM. |
| `domIndex.js` | DOM indexer for voice accessibility mode. |
| `staleBuildToast.jsx` | Sticky toast shown when server's build id differs from client's. |
