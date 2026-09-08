# Persistent Mind: continuous play + adjustable local context

## Continuous play playbook

PortOS minds can opt into a first-class **operating playbook** stored on CoS config as `persistentMindPlaybook`:

| Field | Meaning |
|-------|---------|
| `mode` | `default` (operator prompt only) or `continuous-play` |
| `customInstructions` | Optional extra notes appended after the mode template |

When `mode` is `continuous-play`, every wake merges the product template into operating instructions:

1. **Explore** the Eidoverse / Commons with many small interactions
2. **Interact** (say / augment / project / peers / PortOS tools)
3. **Reflect** with concrete improvement ideas
4. **Invent / improve** via the smallest safe PortOS-side step or typed CoS task

Saving a playbook never starts inference. The Mind Context panel exposes the mode selector; `PUT /api/cos/config` accepts `persistentMindPlaybook`. `GET /api/cos/mind/context` returns `playbook` + `playbookCatalog` and previews composed instructions.

## Mind-adjustable `numCtx`

Granted via capability `adjustLocalContext` (capabilities schema v8). Semantic tools:

| Tool | Effect |
|------|--------|
| `mind.local-context` | Read current provider `numCtx` + safe clamp |
| `mind.adjust-local-context` | Set `numCtx` on **this mind's own local API provider** |

### Safety clamps

`server/lib/mindLocalContextClamp.js` refuses oversized windows so CPU-only / low-RAM hosts (including Grok boxes) cannot OOM PortOS:

- Absolute floor **512**, absolute ceiling **131072**
- CPU-only ceilings tiered by installed RAM (e.g. ≤16 GB → 4096)
- Free-memory ceiling reserves **2.5 GB** for PortOS + estimated model weights
- Usable NVIDIA VRAM / Apple Silicon allows higher ceilings
- Rate limit: **6** adjustments / rolling 24 h, **10** minutes apart
- Cloud / keyed / gateway providers are ineligible

Accepted adjustments persist via `updateProvider({ numCtx })` and call `ollamaManager.ensureContextWindow` for local Ollama.

### UI / API surfaces

- CoS → Mind → Tools / access: **Allow mind to adjust local model context (numCtx)**
- CoS → Mind → Context: **Operating playbook** mode selector
- Config: `PUT /api/cos/config` with `persistentMindCapabilities.adjustLocalContext` and/or `persistentMindPlaybook`
