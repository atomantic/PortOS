# PortOS Documentation

Index of everything under `docs/`. Start with the [root README](../README.md) for the product overview and quick start, and [ETHOS.md](../ETHOS.md) for the project's position on autonomy, digital-mind individuality, privacy boundaries, and why consent here is architecture rather than a service.

**Something won't start?** Run `npm run doctor` — a read-only report of every install prerequisite (Node/npm floors, submodule, workspace deps, PostgreSQL + pgvector, migrations, seeded `data/`, pm2, media toolchain, cert, ports). It runs before `npm install` and prints one pasteable block; add `--json` for machine-readable output. Then see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Guides (living documents)

A living doc describes current behaviour and operator procedure; issue numbers, dated evidence, and "what changed" belong in the commit or PR. Each guide is capped at 40 KB (grandfathered files are ratcheted in `server/test/guards/repo/docsIntegrity.test.js`); a doc at its ceiling is split by topic, not appended to.

| Doc | Covers |
|-----|--------|
| [SCRIPTS.md](./SCRIPTS.md) | Selected `npm run` maintenance commands (API, lint, setup helpers, password reset, hidden-content scan) and the standalone operator and ML scripts under `scripts/`, with when to run each |
| [CODEX_USAGE_PREVIEW.md](./CODEX_USAGE_PREVIEW.md) | Read-only bounded Codex raw/compressed/archive usage preview, deduplication and coverage limits |
| [EXECUTION_OPTIONS.md](./EXECUTION_OPTIONS.md) | Capability-driven speed options, persistence, dispatch attribution and selector inventory |
| [FLUX3_IMAGE.md](./FLUX3_IMAGE.md) | FLUX.3 Klein MLX profiles, isolated runtime, reference edits and license/access behavior |
| [MINIMAX_H3_CUDA.md](./MINIMAX_H3_CUDA.md) | MiniMax H3 CUDA hash locks, Python/CUDA targets, advisory checks and NVIDIA readiness validation |
| [LTX25_CUDA.md](./LTX25_CUDA.md) | LTX-2.5 CUDA hash locks, immutable source packaging, regeneration and NVIDIA readiness validation |
| [WAN22_CUDA.md](./WAN22_CUDA.md) | Wan 2.2 CUDA hash locks, Python/CUDA targets, regeneration, advisory scans and NVIDIA readiness validation |
| [DEMUCS_RUNTIME.md](./DEMUCS_RUNTIME.md) | Vocal separation hash locks, source-build contract, supported interpreters and validation limits |
| [RIGGING_RUNTIME.md](./RIGGING_RUNTIME.md) | Blender rigging interpreter artifacts, wheel locks, provisioning and validation limits |
| [PYTHON_RUNTIME_REFRESH.md](./PYTHON_RUNTIME_REFRESH.md) | Held-back Python runtime pins and the selective lock-regeneration procedure |
| [RUNTIME_LOCKS.md](./RUNTIME_LOCKS.md) | Shared lock-regeneration script, OSV audit and fresh-install readiness evidence for the Windows/Linux CUDA runtimes |
| [MINIMAX_MUSIC3_CUDA.md](./MINIMAX_MUSIC3_CUDA.md) | MiniMax Music 3 CUDA hash locks, Install/Repair, regeneration, advisory scans and NVIDIA readiness evidence |
| [AUDIOLDM2_CUDA.md](./AUDIOLDM2_CUDA.md) | AudioLDM2 Windows/Linux hash locks, Install/Repair, regeneration, advisory scans and NVIDIA readiness evidence |
| [MUSCRIPTOR_CUDA.md](./MUSCRIPTOR_CUDA.md) | MuScriptor Windows/Linux hash locks, Install/Repair, regeneration, advisory scans and NVIDIA readiness evidence |
| [ACESTEP_CUDA.md](./ACESTEP_CUDA.md) | ACE-Step Windows/Linux hash locks, pinned-checkout install, regeneration, advisory scans and NVIDIA readiness evidence |
| [FLUX2_CUDA.md](./FLUX2_CUDA.md) | FLUX.2 / Qwen-Image 2.1 Windows/Linux hash locks, Install/Repair, regeneration, advisory scans and NVIDIA readiness evidence |
| [ACESTEP15_CUDA.md](./ACESTEP15_CUDA.md) | ACE-Step 1.5 Windows/Linux hash locks, pinned-checkout install, regeneration, advisory scans and NVIDIA readiness evidence |
| [TRELLIS2_METAL.md](./TRELLIS2_METAL.md) | TRELLIS.2 Metal native profile, immutable sources, wheel/build locks, regeneration and Install/Repair validation |
| [PIXAL3D_CUDA.md](./PIXAL3D_CUDA.md) | Isolated Pixal3D CUDA lock, native Install/Repair, NAF fallback and validation status |
| [PIXAL3D_MPS.md](./PIXAL3D_MPS.md) | Pixal3D Metal patched Torch environment, hash locks, native Install/Repair and synthetic-image mesh validation |
| [TRELLIS2_CUDA.md](./TRELLIS2_CUDA.md) | TRELLIS.2 CUDA native profile, Conda artifacts, wheel locks, Install/Repair and GPU validation |
| [MLX_VIDEO_LOCKS.md](./MLX_VIDEO_LOCKS.md) | Pinned LTX and Wan MLX runtime and build locks, audit inventory and regeneration |
| [MOSS_IMAGE.md](./MOSS_IMAGE.md) | Optional pinned MOSS Swift/MLX image runtime, explicit installation, resource needs and Apple Silicon validation |
| [HTML_COMPOSITIONS.md](./HTML_COMPOSITIONS.md) | Seekable HTML scenes rendered offline to MP4 through hidden managed-browser targets |
| [CONTAINMENT.md](./CONTAINMENT.md) | Every containment profile (bubblewrap, Seatbelt, Docker) and which consumer uses which; the opt-in Docker containment profile for untrusted installs/tests, its engine policy, two-phase network and `contained-run.js` |
| [SUPERCOLLIDER.md](./SUPERCOLLIDER.md) | Managed SuperCollider Docker runtime: `setup:supercollider`, readiness states, containment policy and platform evidence |
| [CODE_ANIMATION_PACKAGES.md](./CODE_ANIMATION_PACKAGES.md) | Versioned portable Code Animation source/brief packages, non-executing validation, and contained production execution |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design: React client, Express server, PM2 satellites, PostgreSQL + `data/` files |
| [GREYBOX.md](./GREYBOX.md) | Environment starter layouts, Blender exports, camera shots, reference captures and AI editing |
| [features/feature-priorities.md](./features/feature-priorities.md) | Feature area priority tiers: the focused-page-visit usage signal, machine-local storage, pins and the API |
| [features/splash.md](./features/splash.md) | PortOS-managed Apple Silicon Splash with Inkling 2 Mini and local OpenCode and Claude Code presets |
| [features/mkserve.md](./features/mkserve.md) | PortOS-managed mkserve with Inkling 2 Mini on Apple M5 Max |
| [features/mixture-of-agents.md](./features/mixture-of-agents.md) | Mixture of Agents presets: parallel tool-free advisors, the acting aggregator, cache-safe tail injection, privacy filter and run attribution |
| [features/image-verifier.md](./features/image-verifier.md) | Image Verifier: defect standards, evaluation profiles, model benchmarks, and integration with media jobs and imports |
| [features/catalog-ingest.md](./features/catalog-ingest.md) | Catalog extraction graph, context budgets, coverage, and review draft contract |
| [features/catalog-primitives.md](./features/catalog-primitives.md) | Catalog creative primitive ownership, locks, forks, design rounds, and canon description repair HTTP contract |
| [CATALOG_LOCAL_MERGE.md](./CATALOG_LOCAL_MERGE.md) | Local catalog consolidation, preserved identities and assets, conflict review, and guarded recovery |
| [CATALOG_SHARED_IDENTITY.md](./CATALOG_SHARED_IDENTITY.md) | Two-owner canonical identity agreements, preparation, adoption, owner refresh, and coordinated recovery |
| [API.md](./API.md) | API conventions, security model, peer-probe contract, route-domain index, Socket.IO events, error envelope (endpoint reference: API Explorer / OpenAPI) |
| [API_TOOL_CONTRACT.md](./API_TOOL_CONTRACT.md) | Unified semantic tool, Persistent Mind, and Agent Tools MCP contract |
| [ACP.md](./ACP.md) | Agent Client Protocol stdio adapter: Ask Yourself and the Persistent Mind in Zed, VS Code, JetBrains and Neovim |
| [COMPANION_APP_API.md](./COMPANION_APP_API.md) | PortDeck native iOS companion client discovery and HTTP API contract |
| [SETUP.md](./SETUP.md) | First install: Tailscale, MagicDNS, trusted HTTPS, exact launch URL, and AI-provider readiness |
| [REMOTE_DESKTOP.md](./REMOTE_DESKTOP.md) | PortDeck VNC broker security, host setup, and session flow |
| [FEDERATED_MEDIA_PROVIDERS.md](./FEDERATED_MEDIA_PROVIDERS.md) | Authenticated, capacity-aware peer audio, image, and video provider wire contract and setup |
| [STORAGE.md](./STORAGE.md) | Storage classification contract — PostgreSQL vs filesystem, new-data-store checklist |
| [STORAGE_RECOVERY.md](./STORAGE_RECOVERY.md) | Operator recovery: workflow maintenance journal and reservations, legacy creative import retry, catalog rewrite window, Codex image usage backfill |
| [DATABASE_MAINTENANCE.md](./DATABASE_MAINTENANCE.md) | Database maintenance journal: Docker ↔ native cutover lifecycle, offline transfer, verified restart, recovery commands |
| [BACKUP.md](./BACKUP.md) | Filesystem snapshots + PostgreSQL dumps: what is backed up, anchored excludes and tiers, restore semantics, retention, scheduling |
| [BACKUP_RUNBOOKS.md](./BACKUP_RUNBOOKS.md) | Operator runbooks: database backend migration, older-snapshot restore, in-server store restores, maintenance admission |
| [BACKUP_PUBLICATION_ADMISSION.md](./BACKUP_PUBLICATION_ADMISSION.md) | Shared admission lease between the server and `portos-cos`, how snapshot and restore cuts drain in-flight asset publications, and the consistency contract for changing assets |
| [PORTS.md](./PORTS.md) | Port allocation (5553–5569) and how 5555/5553/5554 relate |
| [ITERM.md](./ITERM.md) | The Shell page's iTerm2 view — requirements, status states and their fixes, why iTerm2 sessions stay separate from PortOS shells, the clean-room protocol rule |
| [INSTANCE_FEATURES.md](./INSTANCE_FEATURES.md) | Optional per-install features — registry, client-side nav gating, feature groups, reconcile-at-toggle |
| [PM2.md](./PM2.md) | Recommended PM2 ecosystem patterns for sub-projects |
| [SECURITY_RISK_ASSESSMENT.md](./SECURITY_RISK_ASSESSMENT.md) | Threat boundaries, security finding dispositions and external-content screening |
| [DEEP-AUDITS.md](./DEEP-AUDITS.md) | Persistent audit coverage, independent passes, checkpoint/resume and completion rules |
| [DEEP-AUDITS-LEGACY.md](./DEEP-AUDITS-LEGACY.md) | Legacy (historical) exhaustive Deep audit records and their stored evidence format; new launches no longer run this workflow |
| [QUOTA-BURN.md](./QUOTA-BURN.md) | Quota-burn automation — spending subscription-backed CLI quota before expiry |
| [AI_PROVIDERS.md](./AI_PROVIDERS.md) | The AI Providers page: a run composed from Harness × Method × Service × Model × Effort, its Presets / Harnesses / Services views, compatibility matrix, derived vs legacy presets, and what federates (nothing) |
| [PROVIDER_COMPOSITION.md](./PROVIDER_COMPOSITION.md) | Composite provider ids (`harness.method@service[+bootstrap]`): the grammar, per-harness enablement, bootstrap apps, how every run path resolves one, and the preset-only surfaces |
| [MODEL_ACCESS.md](./MODEL_ACCESS.md) | Scoping a provider to the models your plan entitles you to — free tiers, allow/deny globs, gateway inheritance |
| [MODEL_TIERS.md](./MODEL_TIERS.md) | Light / Medium / Heavy / Ultra tiers as per-preset routing configuration, and how a task or stage names a tier |
| [JEV_SETUP.md](./JEV_SETUP.md) | Optional local jev entailment scorer: installing, the pinned model and runtime, and recovery |
| [PROMPT_GUARD_SETUP.md](./PROMPT_GUARD_SETUP.md) | Abuse Guard (Prompt Guard) runtime: status and install commands, repair behavior, and diagnosing a failed install |
| [PERSISTENT_MIND_MAINTAINER.md](./PERSISTENT_MIND_MAINTAINER.md) | Opt-in, machine-local development maintainer role for the persistent mind: setup, grants, and activation |
| [IMAGE_GALLERY.md](./IMAGE_GALLERY.md) | Image gallery reads: legacy full-array response, paged and filtered envelope, and `media_assets` search semantics |
| [MODEL-COMPARISON.md](./MODEL-COMPARISON.md) | Sourced provider/model/effort comparisons, cost estimates and CoS research refresh |
| [THREEJS_MODELS.md](./THREEJS_MODELS.md) | Three.js procedural 3D model generation and trust boundary |
| [features/music-video-autonomous.md](./features/music-video-autonomous.md) | One-prompt autonomous music videos: brief → lyrics → mood board → Suno song → production, optional checkpoints, and the `music-video-autopilot` scheduled task that turns Brain ideas into videos |
| [features/blender-models.md](./features/blender-models.md) | Blender Models: agent-written Blender Python that builds one model, the `describe`/`build` contract, build checks and findings, GLB export and re-import verification, publishing and retention |
| [features/music-video-blender.md](./features/music-video-blender.md) | Blender film render style: Python scripts that build every shot in Blender, the workspace and film contract, per-shot renders and staleness, cuts, the final render, and the Trusted local requirement |
| [features/music-video-frame-capture.md](./features/music-video-frame-capture.md) | Shared paused-video/capture color interpretation, synthetic evidence and browser limits |
| [features/music-video-photo-sequences.md](./features/music-video-photo-sequences.md) | Ordered existing photos within one still shot, frame/beat cadence, persistence and preview/export timing |
| [features/music-video-temporal-evidence.md](./features/music-video-temporal-evidence.md) | Performance source provenance, synchronized playback and optional local temporal analyzer protocol |
| [features/artist-submission-profile.md](./features/artist-submission-profile.md) | Artist-curated bios, credits, statements and links that agents read when filling festival and distributor forms |
| [features/music-renderer-benchmarks.md](./features/music-renderer-benchmarks.md) | Technical and full-length listening evidence for local music renderer profiles |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup (PostgreSQL required), code conventions |
| [INSTRUCTION_RULE_DETAIL.md](./INSTRUCTION_RULE_DETAIL.md) | Full wording of rules whose short form lives in the `AGENTS.md` files |
| [LOCAL_REVIEW_LIFECYCLE.md](./LOCAL_REVIEW_LIFECYCLE.md) | Durable one-time pre-PR review, recovery and hosted-feedback continuation |
| [CODE_REVIEW_DIAGNOSTICS.md](./CODE_REVIEW_DIAGNOSTICS.md) | Privacy-safe CLI deadline phases, process timing and a synthetic review probe |
| [CLI_REVIEW_OUTCOMES.md](./CLI_REVIEW_OUTCOMES.md) | Reviewer tiers, provider pins and bounded, authenticated CLI health reports |
| [SECURITY_SCANNER_RUNTIME.md](./SECURITY_SCANNER_RUNTIME.md) | Runner-owned Codex security scans, pinned execution, process cleanup and observed evidence |
| [UX_DESIGN_GUIDE.md](./UX_DESIGN_GUIDE.md) | Admin workspace design specification: icon navigation, responsive layouts, disclosure, visual hierarchy, and redesign acceptance |
| [GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md) | CI and release workflows |
| [PREGATE.md](./PREGATE.md) | The local pre-push gate: what it runs, its receipt, interrupts and test process containment |
| [TEST_MEMO.md](./TEST_MEMO.md) | Test memo: skipping verified test files, record-aware related selection |
| [TEST_MEMO_GIT_FIXTURES.md](./TEST_MEMO_GIT_FIXTURES.md) | Test memo: the `test-memo: git-fixture` declaration for suites that only run git in repositories they create |
| [VERSIONING.md](./VERSIONING.md) | SemVer + release process (`/do:release`) |
| [SELF_UPDATE.md](./SELF_UPDATE.md) | Fork-aware self-update flow — release polling, `FORK_SYNC_REQUIRED`, fork sync, running a customized fork, and the unattended idle-gated automatic update |
| [MANAGED_APP_UPDATES.md](./MANAGED_APP_UPDATES.md) | Safe managed-app update default and the opt-in app lifecycle contract |
| [MANAGED_APP_FORGE_ACCOUNTS.md](./MANAGED_APP_FORGE_ACCOUNTS.md) | Running managed apps under a second GitHub account — ssh `Host` aliases and the per-app `forgeAccount` pin |
| [DEPS.md](./DEPS.md) | Dependency audit — every third-party package and its verdict |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common runtime issues, known issues |
| [WINDOWS_CONSOLE.md](./WINDOWS_CONSOLE.md) | Why console windows flash and steal focus on Windows, and the two fixes |
| [GOALS_OPERATIONAL.md](./GOALS_OPERATIONAL.md) | Runtime operating principles the CoS agent reads (parsed by `goalProgress.js`) |
| [METRICS.md](./METRICS.md) | The `METRICS.md` convention — how a managed app exposes its own success metrics so agents (incl. Layered Intelligence) can evaluate it against its goals |

## Feature deep dives (`features/`)

- [Music Video private sharing copy](./features/music-video-sharing-copy.md) — source-bound 720p downloads strictly under 100 MB, private local export and media queue lifecycle
- [Music Video Publish kit](./features/music-video-publish-kit.md) — As mixed and measured Web loudness for release downloads
- [Music Video cinema DCP](./MUSIC_VIDEO_DCP.md) — local cinema export, verification and venue delivery guidance
- [Music Video festival packet](./features/music-video-festival-packet.md) — editable festival information, explicit source suggestions and selected text exports
- [Music Video making-of export](./features/music-video-making-of.md) — local multi-variant planning packages, inventory previews, source planning retention and publication boundaries

Start with the [product surface map](./features/product-surfaces.md) ([repo-study mapping](./features/product-surfaces-repo-study.md)) for a tour of the application’s major surfaces. The focused guides below explain the features with their own operating contracts.

App management: [app-wizard](./features/app-wizard.md) · [app-quality](./features/app-quality.md) · [autofixer](./features/autofixer.md) · [browser](./features/browser.md) · [error-handling](./features/error-handling.md) · [jira-sprint-manager](./features/jira-sprint-manager.md)

Chief of Staff: [chief-of-staff](./features/chief-of-staff.md) · [branch-reconciliation](./features/branch-reconciliation.md) · [autonomous-job-reliability](./features/autonomous-job-reliability.md) · [cos-agent-runner](./features/cos-agent-runner.md) · [self-improvement-audits](./features/self-improvement-audits.md) · [agent-context](./features/agent-context.md) · [agent-skills](./features/agent-skills.md) · [memory-system](./features/memory-system.md) · [claude-ollama](./features/claude-ollama.md) · [grok-box-local-mind](./features/grok-box-local-mind.md) · [fleet-llm-host](./features/fleet-llm-host.md) · [mtplx](./features/mtplx.md) · [slotstream](./features/slotstream.md) · [dflash2](./features/dflash2.md) ([DSpark vs DFlash 2](./research/2026-08-19-dspark-vs-dflash2.md), [Ternary Bonsai 2 27B](./research/2026-09-18-ternary-bonsai-2-27b.md), [Inkling 2 Mini](./research/2026-11-21-inkling-2-mini.md)) · [qwen38-rtx3090](./features/qwen38-rtx3090.md) ([3090 bring-up](./research/2026-08-21-qwen38-rtx3090-vllm.md)) · [sglang-qwen38](./features/sglang-qwen38.md) ([SGLang Hopper/Blackwell evaluation](./research/2026-08-21-sglang-qwen38-27b.md)) · [prompt-manager](./features/prompt-manager.md) · [development-watchdog](./features/development-watchdog.md) · [review-queue](./features/review-queue.md)

Federation: [peer-administration](./features/peer-administration.md) · [tailcat-peers](./features/tailcat-peers.md) · Models: [decision-classifiers](./features/decision-classifiers.md)
- [Persistent Mind continuous play + local context](./features/persistent-mind-continuous-play.md) — explore/invent playbook and mind-adjustable `numCtx` clamps

Identity & self: [digital-twin](./features/digital-twin.md) · [identity-system](./features/identity-system.md) · [soul-system](./features/soul-system.md) · [privacy-center](./features/privacy-center.md) · [post](./features/post.md) (insights design spike: [plans/2026-06-03](./plans/archive/2026-06-03-cross-domain-insights-engine.md))

Knowledge: [brain-system](./features/brain-system.md) · [untrusted messages and GitHub automation](./features/messages-security.md) · [scope adherence](./features/scope-adherence.md)

Create: [writers-room](./features/writers-room.md) · [creative-director-video](./features/creative-director-video.md) · [apple-video-options](./features/apple-video-options.md) · [qwen-image-21](./features/qwen-image-21.md) · [fableloom](./features/fableloom.md) · [FableLoom runtime v1](./features/fableloom-runtime-v1.md) · [FableLoom export v1](./features/fableloom-export-v1.md) · [Eidoverse Worlds integration](./features/eidoverse.md) ([guest travel](./features/eidoverse-guest-travel.md), [discovery](./features/eidoverse-discovery.md)) · [Eidoverse music-video renderer](./EIDOVERSE_VIDEO.md) · [sprite-export-contract](./features/sprite-export-contract.md) · [video-text-encoders](./features/video-text-encoders.md) · [video-speed-profiles](./features/video-speed-profiles.md) ([H3 LightX2V on CUDA](./MINIMAX_H3_LIGHTX2V.md)) · [LTX A2V LoRA stages](./features/ltx-a2v-lora-stages.md) · [video-render-batches](./features/video-render-batches.md) · [video-upscale](./features/video-upscale.md)

Comms & voice: [beeper](./features/beeper.md) ([mirror](./features/beeper-mirror.md)) · [messages-browser-send](./features/messages-browser-send.md) · [openclaw-operator-chat](./features/openclaw-operator-chat.md) ([pre-build audit](./research/2026-03-31-openclaw-operator-chat-audit.md)) · [stacker-news](./features/stacker-news.md) · [voice](./features/voice.md) ([Jev feasibility](./research/2026-09-30-jev-voice-feasibility.md))

## Point-in-time records

- [Explicit Music Video render pools](decisions/2026-10-04-music-video-render-pools.md) — proposed initial shot placement and supplied-audio conditioning; final composition export remains local.
- [CoS agent permission posture](decisions/2026-10-06-cos-agent-permission-posture.md) — why unattended agents keep full-bypass instead of vendor auto-approve modes, and where stricter modes apply.
- [Native trash feasibility study](research/2026-10-18-native-trash-feasibility.md) — can PortOS recycle media without the `trash` package: per-platform comparison, executed macOS/Linux proofs, the Windows acceptance checks, and the regression matrix.
- [Recycle media through OS facilities PortOS owns](decisions/2026-10-18-native-trash-without-dependency.md) — replace `trash@10.1.1` with `osascript`/JXA, PowerShell + `SHFileOperationW`, and an owned XDG adapter; implementation plan and Windows validation gate.
- [Docker containment for untrusted install and test runs](decisions/2026-10-21-docker-containment.md) — local-only engine policy, per-run egress proxy for installs, `--network none` validation, and no host fallback.

- **[plans/](./plans/README.md)** — dated design plans (`YYYY-MM-DD-<slug>.md`), archived on approval before implementation. Kept only while a living doc or ADR links them. See [provider connections and harnesses](./plans/archive/2026-09-06-provider-connections-and-harnesses.md) for stable executable routes, migration and management flows.
- **decisions/** — ADRs (`YYYY-MM-DD-<slug>.md`), e.g. the [Postgres-as-primary-datastore decision](./decisions/2026-06-07-postgres-as-primary-datastore.md) and what may cross the federation layer ([user-controlled federation](./decisions/2026-09-19-user-controlled-federation.md), [Privacy Center storage](./decisions/2026-08-08-privacy-records-machine-local.md), [federated visual prompts](./decisions/2026-08-20-federated-visual-prompts.md), [conditioning crosses to an allowlisted peer](./decisions/2026-08-22-federated-media-input-assets.md), [AI usage metrics federate on by default](./decisions/2026-09-01-federated-usage-metrics.md), [Eidoverse guest chat](./decisions/2026-09-05-eidoverse-guest-chat.md), [numeric PortOS quality federation](./decisions/2026-09-10-portos-quality-federation.md), [federated Eidoverse foundations](./decisions/2026-09-18-federated-eidoverse-foundations.md)), why H3 [ships the draft-decode gates without an asset](./decisions/2026-08-30-h3-draft-decoder-asset.md), and why closed-set decisions run on a [local entailment model that abstains](./decisions/2026-09-18-local-jev-decision-service.md).
- **research/** — investigation tools and incident write-ups (e.g. the [H3 scene-continuity comparison](./research/minimax-h3-continuity.md), [H3 vision precision investigation](./research/minimax-h3-vision-precision.md), [UX design audit](./research/UX_DESIGN_AUDIT.md), [page layout audit](./research/PAGE_LAYOUT_AUDIT.md), [mflux GPU-watchdog panic](./research/2026-06-13-mflux-training-watchdog-panic.md) and [local LLM performance audit](./research/2026-08-22-local-llm-performance-audit.md)).

## Other

- **[themes/](./themes/README.md)** — UI theme specs and the theme integration contract.
- **[examples/](./examples/README.md)** — copy-ready config examples (e.g. Claude Code → Ollama settings).
- **[`.changelog/README.md`](../.changelog/README.md)** — how `/do:release` synthesizes the single `RELEASE.md` from the commit log (GitHub Releases is the archive), and its format.
- **media/** — screenshots and logo used by the root README.

- [Local managed-app visitor broker](features/managed-visitors.md) — opt-in credential provisioning, versioned nonhumanoid scope and host negotiation.

- [Agent API key](./AGENT_API_KEY.md) — opt-in local credential and `scripts/portos-api.js` CLI for agents PortOS did not spawn.

- [Peer push authentication](./PEER_PUSH_AUTH.md)

- [Tool-free model delegation](SANDBOX_DELEGATION.md) — approved API workers, context packets, and advisory fidelity evaluation for Persistent Mind.

- [Runway model catalog](RUNWAY_MODELS.md) — supported operations, public schema source, caching, refresh and workflow limits.

- [Data Maintenance](DATA_MAINTENANCE.md) — retained retired-feature storage, LoRA training retirement and inline removal on the LoRAs page.

- [Offline greybox reference sequences](GREYBOX_SEQUENCES.md) — fixed-time blocking and per-camera reference exports.

## All other documents

Generated by `node scripts/sync-docs-index.js` from every `docs/**/*.md` the tables above do not link (plans under `plans/archive/` excluded); do not hand-edit.

<!-- docs-index:begin (generated by scripts/sync-docs-index.js; do not edit) -->

**top level**

- [CI Hidden-Content Gate](./CI_HIDDEN_CONTENT_GATE.md)
- [CI Native Jobs (Windows and macOS)](./CI_NATIVE_JOBS.md)
- [CI for generated snapshot pushes](./CI_SNAPSHOT_PUSHES.md)
- [CI Test Selection and Sizing](./CI_TEST_SELECTION.md)

**decisions**

- [ADR: Legacy Export "Key Decisions" — Derive, Don't Add a First-Class Entity](./decisions/2026-06-19-legacy-export-decisions-source.md)
- [ADR: Tribe Relationship Graph + Universe Render-Runs Stay Machine-Local](./decisions/2026-06-26-tribe-and-universe-runs-local.md)
- [ADR: Strict JSON Reads Wherever a File-Backed Value Is Counted, Displayed, or Written Back](./decisions/2026-08-14-strict-json-reads-for-counted-values.md)
- [ADR: Diegetic FaceTime Is an Optional Story Transport, Never the Session Authority](./decisions/2026-08-30-diegetic-facetime-transport.md)
- [System alerts report actionable failures](./decisions/2026-09-21-actionable-system-alerts.md)
- [ADR: Add SuperCollider as an optional offline code-audio engine](./decisions/2026-10-01-supercollider-code-audio.md)

**plans**

- [Owner-coordinated catalog identity](./plans/2026-10-18-catalog-shared-canonical-identity.md)
- [Local-first merge gate: make pregate the authority for own-agent PRs](./plans/2026-10-18-ci-local-first-merge-gate.md)
- [CoS task queue to PostgreSQL](./plans/2026-10-20-cos-task-queue-to-postgres.md)
- [Casting detail loading](./plans/2026-10-25-casting-detail-performance.md)
- [Shared character workspace](./plans/2026-10-25-character-workspace.md)
- [Creative catalog primitives and universe context](./plans/2026-10-25-creative-primitives.md)
- [Place greybox: a 3D layout reference on Environments](./plans/2026-10-25-place-greybox.md)
- [Native playback for shipped-template composition previews](./plans/2026-11-09-native-composition-preview.md)

**research**

- [POSThuman Web Version: Feature Review & Integration Recommendation](./research/2026-03-06-posthuman-web-feature-review.md)
- [Validation: torch FLUX.2 LoRA trainer on CUDA](./research/2026-08-05-torch-flux2-lora-cuda-validation.md)
- [Feasibility spike: Krea Realtime 14B as a local Apple Silicon video backend](./research/2026-08-09-krea-realtime-apple-silicon.md)
- [Qwen3.8 27B MLX options on macOS](./research/2026-08-16-qwen38-mlx-macos.md)
- [DFlash 2 speculative decoding — can PortOS run Qwen this way?](./research/2026-08-19-dflash2-speculative-decoding.md)
- [FastH3 VSA data-free preview: CUDA bring-up and Apple Silicon watch](./research/2026-08-28-fasth3-vsa-datafree.md)
- [Qwen3.8-Flash-Next on Apple M5 Max](./research/2026-08-28-qwen38-flash-next-m5-max.md)
- [macOS “Install out of sync” research](./research/2026-09-03-macos-install-out-of-sync.md)
- [Local models for private security assessments](./research/2026-09-06-private-security-models.md)
- [FastH3 V2 image-to-video: no Apple Silicon model can take the adapter](./research/2026-09-22-fasth3-v2-mlx-i2v.md)
- [MiniMax H3 CUDA history adapter](./research/minimax-h3-cuda-history.md)

**themes**

- [Black ICE Terminal](./themes/black-ice-terminal.md)
- [Blueprint Ops](./themes/blueprint-ops.md)
- [Classic Midnight](./themes/classic-midnight.md)
- [Kestrel Neon](./themes/kestrel-neon.md)
- [Lumen Glass](./themes/lumen-glass.md)

<!-- docs-index:end -->
