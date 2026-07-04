# PortOS Documentation

Index of everything under `docs/`. Start with the [root README](../README.md) for the product overview and quick start.

## Guides (living documents)

| Doc | Covers |
|-----|--------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design: React client, Express server, PM2 satellites, PostgreSQL + `data/` files |
| [API.md](./API.md) | REST endpoints, complete route-domain index, Socket.IO events |
| [STORAGE.md](./STORAGE.md) | Storage classification contract — PostgreSQL vs filesystem, new-data-store checklist |
| [BACKUP.md](./BACKUP.md) | Filesystem snapshots + PostgreSQL dumps, restore semantics |
| [PORTS.md](./PORTS.md) | Port allocation (5553–5561) and how 5555/5553/5554 relate |
| [PM2.md](./PM2.md) | Recommended PM2 ecosystem patterns for sub-projects |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup (PostgreSQL required), code conventions |
| [GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md) | CI and release workflows |
| [VERSIONING.md](./VERSIONING.md) | SemVer + release process (`/do:release`) |
| [DEPS.md](./DEPS.md) | Dependency audit — every third-party package and its verdict |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common runtime issues, known issues |
| [GOALS_OPERATIONAL.md](./GOALS_OPERATIONAL.md) | Runtime operating principles the CoS agent reads (parsed by `goalProgress.js`) |
| [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) | Historical hardening audit (2026-02, all items resolved) |

## Feature deep dives (`features/`)

App management: [app-wizard](./features/app-wizard.md) · [autofixer](./features/autofixer.md) · [browser](./features/browser.md) · [error-handling](./features/error-handling.md) · [jira-sprint-manager](./features/jira-sprint-manager.md)

Chief of Staff: [chief-of-staff](./features/chief-of-staff.md) · [cos-agent-runner](./features/cos-agent-runner.md) · [cos-enhancement](./features/cos-enhancement.md) · [agent-skills](./features/agent-skills.md) · [memory-system](./features/memory-system.md) · [claude-ollama](./features/claude-ollama.md) · [prompt-manager](./features/prompt-manager.md)

Identity & self: [digital-twin](./features/digital-twin.md) · [identity-system](./features/identity-system.md) · [soul-system](./features/soul-system.md) · [post](./features/post.md) (insights design spike: [plans/2026-06-03](./plans/2026-06-03-cross-domain-insights-engine.md))

Knowledge: [brain-system](./features/brain-system.md) · [messages-security](./features/messages-security.md)

Create: [writers-room](./features/writers-room.md) · [cybercity-v2](./features/cybercity-v2.md)

Comms & voice: [openclaw-operator-chat](./features/openclaw-operator-chat.md) ([pre-build audit](./research/2026-03-31-openclaw-operator-chat-audit.md)) · [voice](./features/voice.md)

## Point-in-time records

- **[plans/](./plans/README.md)** — dated design plans (`YYYY-MM-DD-<slug>.md`), archived on approval before implementation. Historical records, not living docs.
- **decisions/** — ADRs (`YYYY-MM-DD-<slug>.md`), e.g. the [Postgres-as-primary-datastore decision](./decisions/2026-06-07-postgres-as-primary-datastore.md).
- **research/** — dated investigation and incident write-ups (e.g. the [mflux GPU-watchdog panic](./research/2026-06-13-mflux-training-watchdog-panic.md)).
- **superpowers/** — plan/spec pairs from superpowers-driven builds: `specs/<date>-<slug>-design.md` (design) + `plans/<date>-<slug>.md` (implementation plan).

## Other

- **[themes/](./themes/README.md)** — UI theme specs and the theme integration contract.
- **[examples/](./examples/README.md)** — copy-ready config examples (e.g. Claude Code → Ollama settings).
- **media/** — screenshots and logo used by the root README.
