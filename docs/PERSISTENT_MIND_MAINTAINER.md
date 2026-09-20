# Development maintainer role

The persistent mind can serve as this install's development curator. This role is
opt-in and machine-local; ordinary installs do not maintain PortOS upstream.
Select explicit managed repositories, which may include your own forks. Repository
identity comes from their configured remotes, never a global upstream assumption.

The role adds a charter to the effective wake context without replacing the
operator's identity, instructions, playbook, or memories. Intent is separate from
authority: role setup never grants tools, starts inference, downloads models, or
changes a provider default. Existing pause, autonomy, app and model grants apply.

## Setup and activation

1. In the mind context settings, preview the development maintainer role. Select
   managed repositories and a cadence (one hour by default), then save.
2. Review the prerequisites: allow those apps and explicitly grant PortOS reads,
   typed CoS tasks and issue filing in Persistent Mind Tools. Process-report
   access has its own grant when the audit capability is installed.
3. Pin a healthy local API model for curation. Configure any coding-model access
   separately. Never infer permission for subscription fallback from role enablement.
4. Enable the role only on the intended install. Verify CoS autonomy and pause
   controls, and ensure the deterministic watchdog and inference budget features
   are installed before unattended operation.
5. Read settings back, inspect the effective context preview, then run the
   watchdog in dry-run mode before a bounded wake. Confirm ownership, blockers,
   freshness, and inference routing in receipts before leaving it unattended.

Automation clients can read `GET /api/cos/mind/maintainer` and use the validated
`PUT /api/cos/config` with a partial `persistentMindMaintainer` object:

```json
{"persistentMindMaintainer":{"enabled":true,"appIds":["example-app"],"intervalMinutes":60}}
```

Use the install's authenticated API session. Do not write the live config file
behind the server's cache. A rejected session is an authentication problem, not
proof that the server is unavailable. Read-back uses the same API, and disabling
uses `{"persistentMindMaintainer":{"enabled":false}}`. Config changes emit the
existing `config:changed` event; maintenance consumers must reconcile immediately
and recheck current intent and grants before each side effect.

The configuration lives in the existing machine-local CoS config document. It is
not part of portable mind bundles or peer sync. Importing a mind cannot arm this
role on the destination. No shipped seed or data migration is needed: absence
normalizes to disabled. Do not put local configuration or private reports in Git.
