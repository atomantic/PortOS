# Dedicated LLM host for a PortOS fleet

A PortOS install on an RTX 3090 can serve an OpenAI-compatible model to your other installs over a private tailnet. The inference queue listens on 18022. vLLM remains on loopback at 18020. Restrict 18022 to your own clients using Tailscale or network rules. Keep PortOS administration and the underlying runtime private.

## Host setup

On the GPU machine, open **AI Providers → Model host setup** and follow the dedicated host workflow. Install the host NVIDIA driver and Docker prerequisites from the [local runtime guide](./local-llm-runtimes.md#vllm-on-rtx-3090). On Windows, use Docker Desktop with the target Linux WSL2 distro enabled. Stop competing workloads using the GPU. Setup prepares the container and starts the queue. Allow several minutes for cold model load.

The host panel checks Docker, checkpoint, model, Tailscale and the queue. Use its loopback **Set up Pi on this machine** or **Set up OpenCode TUI on this machine** control to run coding tasks on the host. Reboot restoration is opt-in through dedicated-host setup. It waits for Docker and uses prepared weights.

## Connect a client

1. Add the host under **Instances** if needed. Open **AI Providers → Model host setup → Connect client**.
2. Select the peer or enter the private queue endpoint. Fetch the host key through the peer connection or paste it explicitly. Keep the key private.
3. Configure **Pi** or **OpenCode TUI** for coding, or **Direct API** for ordinary text generation. To update an existing provider, select a compatible one from the dropdown. Refresh models, run the provider test and test a small tool-using workspace.
4. After migrating an older direct-runtime setup, move clients to the queue on 18022. Manage the runtime only on the dedicated host.

## Monitor or stop the host

**Who is using this host** shows active/queued work, recent requests and token totals when the model supplies them. Counts stay local. Prompts and replies are neither persisted by the queue nor sent by record sync. The queue serves one request at a time, with up to 16 waiting. A two-minute wait can return 429 with Retry-After. A stall returns an error and the watchdog can restart the runtime after its cooldown.

Stop hosting from the host panel or **Models → Runtimes → Dedicated Qwen host**. Stopping disconnects clients, disables boot restoration and removes the serving container. The image and checkpoints remain available for starting again. If Docker is unavailable, use the reported error to complete container cleanup after the engine recovers. Re-enable other providers manually if setup disabled them.
