# PortOS documentation

Start with the [project overview and quick start](../README.md) or read the [project ethos](../ETHOS.md) for PortOS's design commitments.

## Use PortOS

- [Install and configure PortOS](SETUP.md) covers first launch, private Tailscale access, HTTPS, and AI providers.
- [Product surface map](features/product-surfaces.md) shows where to find features in the app.
- [AI providers](AI_PROVIDERS.md) explains how harnesses, services, models, and presets fit together.
- [Digital Twin](features/digital-twin.md), [Brain](features/brain-system.md), and [Privacy Center](features/privacy-center.md) cover personal context, capture, and privacy.
- [Music Video](features/music-video.md) walks through a project from brief and song to production.

## Operate an install

- [Troubleshooting](TROUBLESHOOTING.md) covers startup and runtime failures. Run `npm run doctor` to check installation prerequisites.
- [Back up and restore](BACKUP.md) covers PostgreSQL and filesystem recovery.
- [Self-update](SELF_UPDATE.md) explains updates for upstream and forked installs.
- [Storage](STORAGE.md) and [port assignments](PORTS.md) describe the local deployment.
- [Chief of Staff](features/chief-of-staff.md) and [peer administration](features/peer-administration.md) cover agent work and federation.
- [Maintenance scripts](SCRIPTS.md) lists operator commands and when to use them.
- [Media operation controls](features/media-operation-control.md) covers status and cancellation for active media jobs.

## Contribute

- [Contributor guide](../CONTRIBUTING.md) covers development setup, conventions, and testing.
- [Architecture](ARCHITECTURE.md) and [API guide](API.md) explain the codebase and its interfaces.
- [Hosted CI](GITHUB_ACTIONS.md) and [local pregate](PREGATE.md) explain what runs before and after pushing.
- [Versioning and releases](VERSIONING.md) describes the release workflow.
- [Architecture decisions](decisions/README.md) and [configuration examples](examples/) provide targeted references.
