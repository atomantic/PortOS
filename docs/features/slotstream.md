# Slotstream — SSD-streaming MoE runtime

[Slotstream](https://github.com/carloslfu/slotstream) is a separately managed
local runtime for Apple Silicon that runs a mixture-of-experts (MoE) checkpoint
larger than the machine's RAM: it keeps a small dense trunk resident and
streams the routed experts a token actually needs from SSD into a fixed cache
of slots. Cache size trades speed against memory and **never changes output**
— a smaller cache is slower, not less accurate. The technique only pays off on
a MoE checkpoint, where a handful of experts are active per token; a dense
checkpoint of the same size would stream every byte of every layer for every
token and crawl, which is why PortOS offers a curated checkpoint list rather
than an open Hugging Face search.

This is an additional runtime, not a replacement for Ollama or LM Studio.
PortOS exposes it as an `api`/`tui` local provider like every other local
runtime; the `slotstream` entry lives in `LOCAL_RUNTIMES`
(`server/lib/localProviderRuntime.js`).

## Platform gate

Slotstream is Apple-Silicon-only. `isAppleSilicon()`
(`server/lib/platform.js`) gates install and start; on any other host or
architecture the card reports **"Slotstream runs only on macOS with Apple
Silicon."** and offers no install button.

## Where it is managed

**Models → LLMs** is the home for Slotstream's lifecycle, in the same **Local
Runtime Servers** table as Ollama, LM Studio, llama.cpp and MTPLX
(`client/src/components/settings/RuntimeServersCard.jsx`):

- The row offers **Install**, **Start** (enabled once a checkpoint is cached),
  **Stop**, **Configure**, and an **Idle release** window — Slotstream is the
  one runtime besides llama.cpp and MTPLX with an idle-release field.
- The **Slotstream (SSD-streaming MoE)** card below it
  (`client/src/components/settings/SlotstreamServerCard.jsx`) picks which
  cached checkpoint, which port, and an optional memory-cap override; **saves
  that as the launch line an on-demand start replays**; shows the memory plan;
  and is where checkpoints are downloaded.

PortOS runs Slotstream as a **PM2 process named `portos-slotstream`**, exactly
like `portos-mtplx` and `portos-llama-server`. So `pm2 list` shows it next to
the rest of the install, `pm2 logs portos-slotstream` has its output, and a
PortOS restart re-adopts a server it started earlier by reading the launch
config back off the running process's own PM2 args
(`parseConfigFromArgs` in `server/services/slotstreamServerManager.js`).

## The dedicated port

Slotstream always binds an explicit `--port`, defaulting to
`PORTS.SLOTSTREAM` (`server/lib/ports.js`) — a loopback port dedicated to
Slotstream. Port `11434` is refused outright
(`SLOTSTREAM_OLLAMA_PORT_ERROR`): that is Ollama's default, and a
PortOS-managed Ollama already listens there, so a Slotstream server on the
same port would silently steal its traffic instead of failing loudly.

## Setup

1. **Install** from **Local Runtime Servers**. `installSlotstream()`
   downloads the Apple Silicon release from GitHub Releases
   (`gh release download --repo carloslfu/slotstream`) into
   `~/.slotstream/bin` and extracts it — it needs the GitHub CLI (`gh`) on
   `PATH`; without it the install refuses with
   `SLOTSTREAM_INSTALL_UNAVAILABLE` rather than trying an unauthenticated
   fallback. This step never downloads model weights.
2. **Download a checkpoint** from the Slotstream card's **Add a checkpoint**
   picker — a curated list (`SLOTSTREAM_CATALOG` in
   `server/lib/slotstreamCatalog.js`) of three Hugging Face MoE checkpoints
   sized from "small enough to verify the install end to end" up to the
   235B-class headline case. Picking one and pressing **Download checkpoint**
   previews the size and free disk, then streams the transfer with byte
   progress over the `slotstream:download` socket event; the download resumes
   from a partial file if interrupted, and stalls (no bytes for 20 minutes by
   default) are abandoned rather than hung forever, resumable on the next
   press. PortOS also accepts a plain Hugging Face `owner/name` outside the
   curated list, as long as the repo is a Slotstream-loadable MoE checkpoint.
   Nothing downloads without this explicit press.
3. **Start Slotstream** on the card, or **Save configuration** to store the
   choice for a later on-demand start without starting it now. Either way,
   Slotstream never fetches weights at start time — a start reads
   `~/.slotstream/models` (or `SLOTSTREAM_MODEL_DIR`, see below) and refuses
   with a clear message if nothing servable is cached, rather than trying to
   fetch the requested checkpoint.
4. Point an `api`/`tui` provider at the Slotstream endpoint (or use the
   `slotstream` preset if one exists in AI Providers) and use it for
   supported tasks.

## Memory plan

`planSlotstreamMemory()` (`server/lib/slotstreamModels.js`) computes the
expert-cache target before every start and is shown on both the card and the
Local Runtime Servers row:

- **Auto target** — `max(6 GB, min(totalRam × 0.67, max(6 GB, totalRam − 8
  GB)))`, leaving headroom so the rest of PortOS is not paged out.
- **Floor** — `SLOTSTREAM_MEMORY_FLOOR_GB` (6 GB): the smallest cache a dense
  trunk plus a workable expert pool still runs on.
- **Expected peak** — reported equal to the target; this is the ceiling the
  cache is capped at, not a separate measurement.
- **Expected warm decode** — a throughput estimate scaled linearly from one
  measured reference point (~12 tok/s at a 32 GB target), so it moves with the
  chosen target but is a rough guide, not a benchmark.
- **Override** — the Memory cap field on the card sets an explicit `--memory-gb`
  instead of the auto target (still floored at 6 GB). The override — not the
  resolved number — is what gets persisted, so an auto-sized start stays
  reported as "auto" instead of freezing whatever RAM happened to compute to
  on that boot.

## Cache layout

Each subdirectory of the cache directory is one checkpoint, named after the
value a start hands `--model`. The default location is
`~/.slotstream/models`; set `SLOTSTREAM_MODEL_DIR` to use a different
directory (a second drive, for instance) — `slotstreamCacheDir()` is the one
place that decision is made, so the manager, the model lister and the
downloader always agree on where the cache is. A checkpoint downloaded through
the catalog picker lands at `<cache>/<owner>__<name>` (the repo id's `/`
flattened to `__`, since the directory name is also the id a start selects).
A directory holding a `.partial` (an in-progress or abandoned download) is not
counted as a servable checkpoint — Slotstream reports an empty cache rather
than trying to serve a half-downloaded one.

## What a start does and does not do

- **A start never downloads weights**, in either direction it can be
  triggered: pressing **Start Slotstream** on the card, or the first PortOS
  request routed to a Slotstream-backed provider firing lazy start
  (`ensureSlotstreamRunning()`). Both read the on-disk cache and refuse with
  the same message when it is empty. Only the explicit **Download checkpoint**
  button in the previous section ever fetches weights.
- A start with no checkpoint requested picks the first cached one
  (`pickSlotstreamCachedModel`); an explicitly named checkpoint is verified
  against the cache first — `slotstream serve` would otherwise treat an
  unknown name as something to fetch, which is exactly the implicit-download
  path PortOS refuses to open.
- If the requested port is already answering an OpenAI-compatible server, or
  is in use by anything else, the start refuses rather than clobbering
  whatever is already listening.
- A process that exits immediately after `pm2 start` (a bad flag, a corrupt
  checkpoint) is diagnosed from its own PM2 log tail and the PM2 entry is torn
  down, rather than being left around reporting a phantom "running" state.
- Started outside PortOS (someone ran `slotstream serve` by hand on the same
  port), the card reports **Running (external)** with no Stop button — PortOS
  never stops a process it did not start.

## Idle release and lazy start

Slotstream's whole resident state — trunk plus expert cache — sits in one
process for as long as it is up, same shape as MTPLX and llama.cpp.

**Idle release.** Set a window in minutes on the Slotstream row under Local
Runtime Servers. When no PortOS request has been routed to Slotstream for
that long, PortOS stops `portos-slotstream`
(`registerIdleDaemon`/`idleWindowMs` in `server/lib/managedDaemon.js`) and the
memory comes back. `0` (the default) means never.

**Lazy start.** The next PortOS request routed to Slotstream starts it and
waits for readiness (`ensureSlotstreamRunning`). It comes back on the launch
line it last used — the saved checkpoint, port and memory-cap override — so a
released server returns exactly as configured rather than re-guessing.
**Only PortOS traffic counts** toward the idle timer; a client hitting the
Slotstream port directly is invisible to it.

Unlike MTPLX, the Local Runtime Servers row also offers a manual **Start**
button once a checkpoint is cached — Slotstream does not rely on lazy start
alone.

## Startup at boot

Like `portos-mtplx`, `portos-slotstream` is deliberately excluded from **Save
PM2 list for reboot** (`server/routes/localLlm.js`, the `saveProcessList`
call's `exclude` list) — it starts on demand, so resurrecting it at boot would
pin whichever checkpoint and memory cap happened to be saved on a machine
nobody has asked anything of yet. The running process, if any, is left alone;
it just is not in the dump a reboot replays.

## API surface

`server/routes/localLlm.js` exposes the lifecycle under
`/api/local-llm/slotstream/*`:

| Route | Purpose |
| --- | --- |
| `GET /slotstream/status` | Binary presence, running state, endpoint, memory plan, cached checkpoints, cache directory/error, the curated catalog, recent log lines. |
| `POST /slotstream/start` | Launch `slotstream serve` under PM2 with the given (or saved) checkpoint/port/memory cap; streams progress. |
| `POST /slotstream/stop` | Stop the managed process. |
| `POST /slotstream/install` | Download and extract the Apple Silicon binary. |
| `POST /slotstream/models/download` | Fetch one catalog (or `owner/name`) checkpoint into the cache; streams byte progress on the `slotstream:download` socket event. |

`POST /api/local-llm/download-preflight` also accepts `{ kind: 'slotstream', model }` to
preview a checkpoint download's size and free-disk verdict before the confirm
step commits to it.

## Operational notes

- Keep the Slotstream endpoint local. The dedicated port is a loopback
  address; if you intentionally change that, treat the server and its cached
  weights as a separate trusted runtime.
- A checkpoint download can run for a long time (100 GB+ for the largest
  catalog entry) — PortOS fetches one checkpoint at a time; a second request
  while one is in flight is refused rather than interleaved.
- Slotstream was integrated by PortOS; it is not PortOS's own project. See
  [carloslfu/slotstream](https://github.com/carloslfu/slotstream) for the
  runtime itself, its supported checkpoint formats, and its own release
  notes.
