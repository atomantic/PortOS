# Dedicated LLM host for a PortOS fleet

One PortOS machine with a capable GPU can serve every other install on the
tailnet. Clients connect to the host's queued OpenAI-compatible API;
PortOS federation supplies the known-peer address, but it does not proxy prompts
or responses through `:5555`.

For one RTX 3090, the default stack is:

```text
PortOS clients ── Tailscale ──> queue :18022 ──> private vLLM :18020 ──> Qwen3.8-27B + DFlash2
      │
      ├─ OpenCode TUI provider: coding agents and tool use
      └─ API provider: text generation, analysis, and thinking workflows
```

Open **Settings → AI Providers → Model host setup** on each client to create either
provider. The walkthrough can prefill the endpoint from an existing PortOS peer
and writes it into both the provider record and OpenCode's actual `baseURL`.

## Why this stack on a 3090

The [syv-ai RTX 3090 kit](https://github.com/syv-ai/qwen38-27b-rtx3090) is the
current default because its important claims are measurements on this exact
card, not projections from another architecture:

- roughly 118 tok/s with MTP and 132–133 tok/s with DFlash2 for one stream at
  the documented operating point;
- prefix caching that makes a repeated 25k-token prefix start in about 0.56 s
  instead of 22.4 s;
- tool-call parsing, authenticated network serving, concurrent request slots,
  and a published container;
- 64k in its conservative low-latency profile, with documented longer-context
  modes up to the model's native 262k window.

The [MiaAI-Lab EXL3 kit](https://github.com/MiaAI-Lab/Qwen3.8-27B-DFlash2-EXL3-5.0bpw)
is a useful alternative when maximum resident context is the main constraint.
Its 3.5-bpw target plus MTP head is substantially smaller and its Hadamard-4 KV
lane is designed to fit 262k on a 24 GB Ampere card. It is not the fleet default
yet for two concrete reasons: its published throughput was measured on GB10 and
explicitly has not been benchmarked on RTX, and its bundled server generates one
request at a time while concurrent calls queue. Measure it on a real 3090 before
replacing the vLLM appliance.

Other existing PortOS paths remain useful, but solve different problems:

| Runtime | Use it when | Why it is not the 3090 fleet default |
| --- | --- | --- |
| LM Studio | A desktop-managed server and the easiest first network test matter most | It does not run the referenced EXL3 kit and is less reproducible as an unattended appliance |
| MTPLX | The host is Apple Silicon and native MTP is desired | It is an MLX runtime, not the CUDA path for a 3090 |
| llama.cpp | A portable GGUF runtime matters more than this model-specific throughput | The DFlash2 path is not the measured, packaged 3090 stack |
| SGLang | The host is Hopper or Blackwell | Its published Qwen3.8 recipes do not include Ampere 24 GB |

## Host setup

Open **AI Providers → Model host setup → Host**. The banner is visible above the provider list and detects GPU/platform capabilities. On Windows/Linux with an RTX 3090 (24 GB), the recommended action prepares missing weights, preserves the prepared image by digest, selects DFlash 2 and prefix caching, and starts a persistent container. The recorded warm agent-prompt result was **105.3 tok/s**; this is a measured reference, not a speed guarantee for every prompt.

Setup binds the underlying runtime to loopback `:18020` and exposes a bearer-authenticated queue on `:18022`. It creates a **Direct API** provider — not an OpenCode TUI one — and moves existing local vLLM providers (including OpenCode's baseURL) through the queue. Competing local LM Studio/Ollama/llama/SGLang/SlotStream providers are disabled; their configurations remain available. Unload other GPU models before starting. PortOS no longer enables the default local backend at boot while dedicated hosting is enabled.

Once the host is configured (`hasApiKey` and an endpoint are both present), the host panel itself offers **Set up OpenCode TUI on this machine** — the same "Connect client" walkthrough below, but pre-filled with this machine's own loopback endpoint and key, so running coding agents on the host machine doesn't require hand-copying its own credentials. The provider list on this page also surfaces this as an "add a provider" prompt when the host is serving and no matching provider exists yet.

The status panel checks Docker, prepared weights/key, the loaded model, Tailscale and queue listener. Copy the endpoint and explicitly reveal/copy the key only when connecting a client. The key never appears in the status payload. Driver installation, Docker engine repair, Windows reboot and enabling Docker Desktop startup may still require host interaction. Setup enables the model distro in Docker Desktop, wakes it before retrying a failed WSL integration, and registers a Windows login task to restore PortOS and the prepared container. The login task waits for Docker, never downloads weights or generates tokens, and does nothing when the dedicated-host flag is disabled. Once Docker starts, the container's `unless-stopped` policy restores the model; PortOS restores the queue from its machine-local opt-in flag. Cold model initialization can take 5–7 minutes. Boot makes no generation requests.

Restrict `:18022` to your clients using Tailscale/network rules. Existing installations using a directly exposed `:18020` must run host setup before changing clients to `:18022`. Older clients can enter the queue URL manually; no federation schema upgrade is required. Prompts and responses use this separately configured inference API, never federation record sync.

### Queue behavior

One inference request runs at a time across clients, with at most 16 waiting requests. Waiting expires after two minutes with HTTP 429 and Retry-After; active requests have a ten-minute ceiling. Bodies are limited to 2 MiB. SSE streams pass through, disconnects cancel work, and requests are never persisted or replayed after restart. Each model call acquires a slot; a coding agent's tool execution happens on its client and does not hold a GPU slot. The underlying runtime also uses one sequence as a backstop. Direct runtime calls bypass the gateway and should be reserved for local diagnostics.

### Stopping the host

**AI Providers → Model host setup → Stop hosting on this machine**, or the **Dedicated Qwen host** row on **Models → Runtimes**. Both call the same action, which undoes all four things setup armed:

1. closes the shared API queue, so no new peer request is admitted (anything in flight is cancelled);
2. writes `PORTOS_FLEET_LLM_ENABLED=0`, so the queue does not return on the next restart;
3. removes the Windows login-recovery task;
4. stops **and removes** the vLLM container.

Step 4 removes rather than merely stops because setup writes the container with `restart: unless-stopped` — a stopped container comes back the next time the Docker engine starts, which is why turning the host off used to feel impossible. The prepared image and the ~20 GB of weights stay on disk, so starting again takes minutes, not another download.

If Docker is not answering, the first three steps still happen and the action reports that the container could not be stopped — the host is disabled either way. Providers that setup disabled stay disabled; re-enable the ones you want on the AI Providers page.

The setup-page button arms on the first click and acts on the second ("Confirm stop — disconnect peers now"), because stopping cuts off every federated client immediately. The Runtimes row is a one-click Stop like the other runtimes on that card.

### Seeing who is using the host

The host panel shows a **Who is using this host** report while hosting is enabled, read from `GET /api/providers/fleet-host/usage`:

- how many generations are running and waiting right now;
- one row per calling machine — requests, prompt and generated token totals, failures, and when it was last active;
- a live dot on any machine generating at that moment, so a busy GPU can be attributed rather than guessed at;
- the last 50 completed requests, with duration, model and status.

Callers are keyed by their address (every client authenticates with the one shared host key, so the wire carries no per-peer identity) and named from the peer list, falling back to the tailnet's node name. An address matching neither is shown as **Unrecognized** rather than hidden — an unknown machine holding the host key is the case worth seeing.

Token counts come from the model's own reply. A streamed request whose client did not ask for usage reports none, so a row can show requests with no tokens; the panel states how many requests carried counts rather than implying the rest were free. Nothing from a request or response body is stored — the ledger is counts, timestamps, a model id and an HTTP status, kept for 30 days in `data/fleet-host-usage.json` and never federated.

## Client setup

On each client PortOS:

1. Add the GPU host under **Instances** if it is not already a peer.
2. Open **AI Providers → Model host setup → Connect client**.
3. Select the peer (or enter its MagicDNS/IP endpoint), paste the host's
   `VLLM_API_KEY`, and keep the served model id in sync.
4. Choose **OpenCode TUI** for CoS coding agents. Choose **Direct API** for
   PortOS text-generation calls that do not need a file/tool harness.
5. Optionally point an existing provider at this host instead of creating a
   new one: pick it from the **Provider** dropdown (candidates are existing
   OpenCode TUI and Direct API providers). Its harness type is locked, but its
   endpoint, key, and model are updated in place — its other env vars and
   previously-served models are preserved rather than overwritten.
6. Create (or update) the provider, refresh models, run the card test, then
   test one small tool-using workspace before making it the default.

OpenCode is the optimal coding harness for this vLLM server because it speaks
the OpenAI-compatible protocol directly and preserves structured tool calls.
Claude Code would require an Anthropic-compatible translation layer for this
specific runtime. A direct API provider has no coding harness: it is deliberately
the lighter path for ordinary synthesis.

Fleet cards carry a **FLEET HOST** badge and name the remote host. They never
offer to install or start the runtime locally; lifecycle and GPU-memory controls
belong to the dedicated machine.

## Availability and failure policy

Keep at least one fallback provider on every client. A dedicated host still has
driver updates, container restarts, and network maintenance. PortOS should route
around that outage rather than cold-start another large model on each client.

No cold-bootstrap request is involved in this feature. Opening the walkthrough
reads saved configuration, machine health and model discovery. Generation happens only when the user clicks Test or starts a real task.

