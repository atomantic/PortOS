# PortOS — Development Plan

The active, claimable roadmap now lives in the **GitHub issue tracker** — see the
open issues labeled [`plan`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Aplan).
Managed by `/do:replan --issues`. For project goals, see [GOALS.md](./GOALS.md);
for completed work, see [.changelog/](./.changelog/) and `git log`.

This file no longer tracks individual tasks (so it stops generating merge
conflicts as work proceeds). The only thing kept here is the **Future / Ideas**
list below — speculative possibilities, not commitments, deliberately left out of
the tracker until one is promoted to a real, claimable issue.

## Future / Ideas

- **Identity Context Injection** — per-task-type digital twin preamble toggle.
- **Content Calendar** — unified calendar across platforms.
- **Goal Decomposition Engine** — auto-decompose goals into task sequences.
- **Knowledge Graph Visualization** — extend BrainGraph 3D to full knowledge graph.
- **Autobiography Prompt Chains** — LLM follow-ups building on prior answers.
- **Legacy Export Format** — identity as portable Markdown/PDF (closes GOALS "Knowledge Legacy" gap currently at Early status). Bundle scope: autobiography, Brain notes + memories, key decisions, goals + milestones, digital-twin prompt, health summaries with source caveats, and a machine-readable manifest.
- **Workspace Contexts** — project context syncing across shell, git, tasks.
- **Inline Code Review Annotations** — one-click fix from self-improvement findings.
- **AI-assisted panel/scene prompt generation** — reserve `pipeline-comic-panel-image-prompt.md` and `pipeline-storyboard-image-prompt.md` for a future "turn script fragment into N image-gen prompts" button.
- **Local LLM stream backpressure** — `POST /api/local-llm/test/stream` (`server/routes/localLlm.js`) ignores `res.write()`'s return value, so it never awaits `drain`. Fine under single-user/local trust + modest local-LLM token rates, but a fast model + slow client buffers NDJSON unbounded. Mirror `ask.js`'s drain-await if ever hardened. (Deferred from PR #872 review — NIT.)
- **Reasoning-only models stream in one chunk** — in `server/services/localLlmPlayground.js`, reasoning deltas aren't forwarded to `onChunk` during the stream (only content is), so a reasoning-only model's playground panel shows "Waiting for the first token…" the whole run, then the full text lands at once via the terminal result frame. To stream live, forward `delta.reasoning` during the loop AND drop the end-of-stream `onChunk(resolved)` re-emit so it doesn't double — but that touches the shared non-streaming TTFT-timing contract, so it was left as-is. (Deferred from PR #872 review — NIT.)
- **Major Dependency Upgrades** — React 19, Zod 4, PM2 6, Vite 8.
- **Workflow tab Phase 2** — drag-and-drop ordering of stages, custom user-defined stages, per-app workflow overrides.
- **Inspiration & Mood Board Canvas** — dedicated mood-board surface for collecting visual + textual references that feed into Universe Builder, Writers Room, and Creative Director (distinct from raw Media History). Items can be pinned from any media surface; canvas surfaces ref images when starting a new universe / scene / treatment. Documented as a Secondary Goal in GOALS.md but had no tracking.
- **Generative regen path for SynthID defeat (image cleaner) — research/backlog, hardware-gated.** Current `cleanImageBuffer` (`server/lib/imageClean.js`) only strips the C2PA `caBX` chunk + runs `median(3).sharpen()` — SynthID survives by design. The only honest defeat path is to round-trip pixels through a generative model: short-step img2img (low step count + low–moderate denoise, ~0.35–0.5) on a local FLUX runner so composition holds but the per-pixel watermark signal is overwritten by fresh sampling. **Scope narrowed (2026-05-20):** post-hoc, history-only — a second button next to "Clean (aggressive)" on the image-settings/lightbox modal; never auto-applied, never wired into the active gen flow. Each run is ~5–15s on local mflux and GPU/unified-memory heavy; wants its own queue lane. Sidecar records `regenerated: true, regenSteps: N, regenStrength: 0.4, regenModelId: 'flux-v1'` so lineage stays honest. **Hardware-gated** — the 128GB unified-memory machine is now online, so this can be pulled in when the user wants to play with it. UX caveat: this is the only honest watermark-defeat path; the existing C2PA-strip-and-denoise will always be a no-op against SynthID.
