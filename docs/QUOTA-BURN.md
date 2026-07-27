# Quota-burn automation

Quota-burn is an opt-in perpetual scheduled task for installations that use
subscription-backed CLI providers. It first performs only the existing
zero-token usage checks. It dispatches an agent only when an enabled provider
family is inside its configured reset window and still has quota above its
reserve percentage.

Each provider family has its own prompt, optional CLI/TUI provider pin, reset
window, reserve, and per-window dispatch cap. Unknown reset times, unsupported
providers, quota-read errors, and missing agent-capable providers all skip a
dispatch safely. The feature is disabled by default; enabling it is explicit
consent to spend that provider's subscription quota on a schedule.

The configuration and dispatch ledger are machine-local under `data/cos/`.
They are intentionally not federated: quota belongs to a particular machine
and provider account, not to an app record shared with peers.
