# PortOS documentation

Start with the [project overview and quick start](../README.md) or read the [project ethos](../ETHOS.md) for PortOS's design commitments.

## Use PortOS

- [Install and configure PortOS](SETUP.md) covers first launch, private Tailscale access, HTTPS, and AI providers.
- [Product surface map](features/product-surfaces.md) shows where to find features in the app.
- [AI providers](AI_PROVIDERS.md) explains how harnesses, services, models, and presets fit together.
- [Digital Twin](features/digital-twin.md), [Brain](features/brain-system.md), and [Privacy Center](features/privacy-center.md) cover personal context, capture, and privacy.
- [Voice Mode](features/voice.md) covers voice setup, the call console and FaceTime Audio.
- [Writers Room](features/writers-room.md) and [Blender Models](features/blender-models.md) cover drafting and reusable 3D assets.
- [POST](features/post.md) covers cognitive practice and benchmarks. [Eidoverse Worlds](features/eidoverse.md) covers private world setup and visits.
- [OpenClaw Operator Chat](features/openclaw-operator-chat.md) connects the private chat console to a configured runtime.
- [Music Video](features/music-video.md) walks through a project from brief and song to production.

## Operate an install

- [Troubleshooting](TROUBLESHOOTING.md) covers startup and runtime failures. Run `npm run doctor` to check installation prerequisites.
- [Back up and restore](BACKUP.md) covers PostgreSQL and filesystem recovery.
- [Self-update](SELF_UPDATE.md) explains updates for upstream and forked installs.
- [Storage](STORAGE.md) and [port assignments](PORTS.md) describe the local deployment.
- [Local LLM runtimes](features/local-llm-runtimes.md) covers MTPLX, vLLM, SGLang and llama-server. See [dedicated host setup](features/fleet-llm-host.md) for private fleet inference.
- [App Wizard](features/app-wizard.md) registers or creates a managed app. [Managed-app visitors](features/managed-visitors.md) covers its separate scoped visitor integration.
- [Agent skills](features/agent-skills.md) covers discovery, editing and curation.
- [Chief of Staff](features/chief-of-staff.md) and [peer administration](features/peer-administration.md) cover agent work and federation. [Tailcat peers](features/tailcat-peers.md) explains the private alternative for owned installs that cannot join your tailnet.
- [Maintenance scripts](SCRIPTS.md) lists operator commands and when to use them.
- [Media operation controls](features/media-operation-control.md) covers status and cancellation for active media jobs.

## Contribute

- [Contributor guide](../CONTRIBUTING.md) covers development setup, conventions, and testing.
- [Architecture](ARCHITECTURE.md) and [API guide](API.md) explain the codebase and its interfaces.
- [Hosted CI](GITHUB_ACTIONS.md) and [local pregate](PREGATE.md) explain what runs before and after pushing.
- [Versioning and releases](VERSIONING.md) describes the release workflow.
- [Architecture decisions](decisions/README.md) and [configuration examples](examples/) provide targeted references.
