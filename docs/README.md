# PortOS documentation

Start with the [project overview and quick start](../README.md) or read the [project ethos](../ETHOS.md) for PortOS's design commitments.

## Use PortOS

- [Install and configure PortOS](SETUP.md) covers first launch, private Tailscale access, HTTPS, and AI providers.
- [Product surface map](features/product-surfaces.md) shows where to find features in the app.
- [AI providers](AI_PROVIDERS.md) explains how harnesses, services, models, and presets fit together. See [model access](MODEL_ACCESS.md) for scoping provider catalogs and [model tiers](MODEL_TIERS.md) for tier routing.
- [Quota Burn](QUOTA-BURN.md) explains automated consumption of expiring subscription CLI quotas.
- [Digital Twin](features/digital-twin.md), [Brain](features/brain-system.md), and [Privacy Center](features/privacy-center.md) cover personal context, capture, and privacy.
- [Voice Mode](features/voice.md) covers voice setup, the call console and FaceTime Audio.
- [Writers Room](features/writers-room.md) and [Blender Models](features/blender-models.md) cover drafting and reusable 3D assets.
- [POST](features/post.md) covers cognitive practice and benchmarks. [Eidoverse Worlds](features/eidoverse.md) covers private world setup and visits.
- [Music Video](features/music-video.md) walks through a project from brief and song to production. See [local cinema packages](MUSIC_VIDEO_DCP.md) for DCP export and the [artist submission profile](features/artist-submission-profile.md) for reusable press and festival materials.
- [Model Comparison](MODEL-COMPARISON.md) explains the catalog methodology. [Runway model options](RUNWAY_MODELS.md) covers hosted video model selection.

### Optional features

Enable GSD project planning, [Beeper](features/beeper.md), [OpenClaw Operator Chat](features/openclaw-operator-chat.md), and [Docker containment](CONTAINMENT.md) in **Settings → Features**. These features start disabled.

[JIRA](features/jira-sprint-manager.md) and DataDog are disabled on unconfigured installs. Their features can turn on automatically when an integration is configured, or you can set them explicitly in **Settings → Features**.

## Operate an install

- [Troubleshooting](TROUBLESHOOTING.md) covers startup and runtime failures. Run `npm run doctor` to check installation prerequisites. See [Windows console flashing](WINDOWS_CONSOLE.md) and the [iTerm2 Shell view](ITERM.md) for platform-specific guidance.
- [Back up and restore](BACKUP.md) covers PostgreSQL and filesystem recovery.
- [Self-update](SELF_UPDATE.md) explains updates for upstream and forked installs.
- [Storage](STORAGE.md) and [port assignments](PORTS.md) describe the local deployment.
- [Local LLM runtimes](features/local-llm-runtimes.md) covers MTPLX, vLLM, SGLang and llama-server. See [dedicated host setup](features/fleet-llm-host.md) for private fleet inference.
- [App Wizard](features/app-wizard.md) registers or creates a managed app and explains its [update lifecycle](features/app-wizard.md#update-a-managed-app). See [managed-app forge accounts](MANAGED_APP_FORGE_ACCOUNTS.md) to configure a separate GitHub identity or [managed-app visitors](features/managed-visitors.md) to set up scoped visitor access.
- [Agent skills](features/agent-skills.md) covers discovery, editing and curation.
- [Self-improvement audits](features/self-improvement-audits.md) explains scheduled checks and Deep mode. The [development watchdog](features/development-watchdog.md) describes Persistent Mind maintainer scans and claim dispatch.
- [Chief of Staff](features/chief-of-staff.md) and [peer administration](features/peer-administration.md) cover agent work and federation. [Tailcat peers](features/tailcat-peers.md) explains the private alternative for owned installs that cannot join your tailnet, and [peer push auth](PEER_PUSH_AUTH.md) documents pair-token authentication.
- [Agent API keys](AGENT_API_KEY.md) and [ACP stdio adapter](ACP.md) cover terminal and editor agent integration.
- [Instance features](INSTANCE_FEATURES.md) covers optional feature toggles. [Remote Desktop](REMOTE_DESKTOP.md) covers optional remote-desktop setup, and [data maintenance](DATA_MAINTENANCE.md) covers dataset and LoRA maintenance.
- [PM2 process management](PM2.md) covers starting, stopping and inspecting PortOS processes.
- [Runtime locks](RUNTIME_LOCKS.md) covers dependency refresh and runtime readiness. [Jev](JEV_SETUP.md) covers local decision scoring setup and recovery.
- [Prompt Guard setup and recovery](PROMPT_GUARD_SETUP.md) covers Abuse Guard runtime checks. [SuperCollider](SUPERCOLLIDER.md) covers the Music Designer render runtime.
- [Codex usage preview](CODEX_USAGE_PREVIEW.md) explains how to check subscription accounting without changing the usage ledger.
- [Maintenance scripts](SCRIPTS.md) lists operator commands and when to use them.
- [Media operation controls](features/media-operation-control.md) covers status and cancellation for active media jobs.

## Contribute

- [Contributor guide](../CONTRIBUTING.md) covers development setup, conventions, and testing. See [UX design guide](UX_DESIGN_GUIDE.md) for UI patterns and [security risk assessment](SECURITY_RISK_ASSESSMENT.md) for boundary analysis.
- [Architecture](ARCHITECTURE.md) and [API guide](API.md) explain the codebase and its interfaces.
- [Hosted CI](GITHUB_ACTIONS.md), [local pregate](PREGATE.md) and [test memo](TEST_MEMO.md) explain test selection and pre-push verification.
- [Dependencies](DEPS.md) lists the packages PortOS uses.
- [Local review lifecycle](LOCAL_REVIEW_LIFECYCLE.md) describes review continuity across PR delivery. [CLI review outcomes](CLI_REVIEW_OUTCOMES.md) documents how orchestrators record results.
- [Companion API](COMPANION_APP_API.md) covers native clients. [API and MCP tools](API_TOOL_CONTRACT.md) covers tool discovery and authority.
- [Versioning and releases](VERSIONING.md) describes the release workflow.
- [Architecture decisions](decisions/README.md) and [configuration examples](examples/) provide targeted references.
