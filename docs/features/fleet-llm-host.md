# Dedicated LLM host for a PortOS fleet

One PortOS machine with a capable GPU can serve every other install on the
tailnet. Clients connect directly to the model runtime's OpenAI-compatible API;
PortOS federation supplies the known-peer address, but it does not proxy prompts
or responses through `:5555`.

For one RTX 3090, the default stack is:

```text
PortOS clients ── Tailscale ──> vLLM :18020 ──> Qwen3.8-27B + DFlash2
      │
      ├─ OpenCode TUI provider: coding agents and tool use
      └─ API provider: text generation, analysis, and thinking workflows
```

Open **Settings → AI Providers → Fleet setup** on each client to create either
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

Follow [vLLM Qwen3.8-27B on an RTX 3090](./qwen38-rtx3090.md) for installation
and WSL2 requirements. For a fleet host, these settings are load-bearing:

1. Set a strong `VLLM_API_KEY`. The runtime listens on `0.0.0.0`; never expose
   it to the LAN or tailnet without the key.
2. Use `SPEC=dflash2` and `PREFIX_CACHE=1`. Keep the normal seven-token draft
   depth for agent work; `DFLASH_TOKENS=15` trades away request slots and context
   for prompt-reproduction workloads.
3. Keep model id `qwen3.8-27b`, or enter the actual id in the client walkthrough.
4. Confirm `http://<gpu-host>:18020/v1/models` answers from another tailnet
   machine with the bearer key.
5. On a **dedicated** host, configure the container with `restart:
   unless-stopped` (or Docker's equivalent) and ensure Docker starts at boot.

The last step is intentionally different from PortOS's mixed-workstation
default. Qwen3.8 occupies nearly all 24 GB of VRAM, so PortOS never auto-starts
the container on a machine that may also render images or video. A dedicated
fleet host has made the opposite allocation decision: availability is its job.

Use Tailscale ACLs to restrict `:18020` to the client machines. The API key is
still required: the tailnet authenticates machines, while the key prevents an
unrelated process on one of those machines from consuming the model.

## Client setup

On each client PortOS:

1. Add the GPU host under **Instances** if it is not already a peer.
2. Open **AI Providers → Fleet setup → Connect client**.
3. Select the peer (or enter its MagicDNS/IP endpoint), paste the host's
   `VLLM_API_KEY`, and keep the served model id in sync.
4. Choose **OpenCode TUI** for CoS coding agents. Choose **Direct API** for
   PortOS text-generation calls that do not need a file/tool harness.
5. Create the provider, refresh models, run the card test, then test one small
   tool-using workspace before making it the default.

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
only reads the saved peer list. The model is contacted only when the user clicks
Refresh Models, Test, or starts a real task.

