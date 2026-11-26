# Splash: local Inkling 2 Mini (opt-in)

Splash is a separate Apple Silicon inference server, not an Ollama or MTPLX option. PortOS manages a private, verified [Splash 1.7.2](https://github.com/incoai/splash/releases/tag/1.7.2) install on macOS 26.4+ with Apple M3 or newer.

1. On the Mac running PortOS, open **Models → Runtimes → Splash → Configure**. Choose **Install**. PortOS downloads the pinned runtime, a pinned revision of the default Inkling 2 Mini GGUF and the compatible DFlash drafter selected by Splash at install time. Allow about 17 GB of downloads and additional disk space for the prepared cache. No Homebrew or terminal command is needed.
2. Choose **Start** to load the already downloaded text model. The server binds only to loopback on port 8001 and announces model ID `inkling2-mini`. The status verifies readiness and model identity without making a generation request. Port 8000 remains available to other runtimes.
3. In **AI Providers**, enable and select **OpenCode · Splash (local)** or **Claude Code · Splash (local)**. Both reach the same server. OpenCode uses the OpenAI-compatible `/v1` root and declares a local auxiliary model; Claude Code uses the Anthropic-compatible server root. The optional **Splash (local)** provider is the direct OpenAI-compatible API route. All ship disabled; installation does not change your active provider or defaults.
4. Choose **Stop** to free memory. After stopping, **Update** installs the release pinned by the current version of PortOS when a different pinned version is available. Updates preserve cached weights and do not restart the server. If another application is already listening on port 8001, PortOS will not replace or stop it. A compatible manually started Splash server at that port remains usable.

Splash uses `reasoning_content` for the OpenAI-compatible tool loop, not the Ollama-specific `reasoning` field. Claude Code uses its native structured thinking blocks. PortOS tested OpenCode 1.x. The vendor launcher uses standalone mode for OpenCode 2; the PortOS preset does not select that mode. On the managed local endpoint, the Claude Code and OpenCode presets follow the running Splash window at launch by default. They fall back to 65,536 tokens when the server does not report a window and normally reserve 8,192 output tokens. Existing explicit preset pins and non-default legacy limits are preserved. In **AI Providers → Edit → Generation**, choose **Follow Splash runtime** to clear a pin, or pick a size for only that preset. The Claude environment tab previews the value PortOS generates at launch instead of offering another editor for it. Actual speed, useful context and time to a passing patch depend on weights, memory, and workload.

The Splash card shows two different limits. **Splash context window** is the requested limit for the next start (64K by default). With Splash stopped, choose 64K, 128K, 256K, 512K, or 1M; saving does not restart or reconfigure a running engine. **Currently serving** is the limit advertised by the running engine at `/v1/models`, when present. The two can differ. [Splash documents](https://github.com/incoai/splash/blob/1.7.2/docs/server.md#memory-and-context) an Inkling limit of 1,010,000 tokens, not a guarantee that 1M will run well on every Mac. Bigger windows can need substantially more free memory or SSD space. Start with a smaller window and increase as needed. After a restart, new launches that follow Splash use the newly reported window. A pinned preset keeps its chosen value.

Splash can be measured on **Models → Performance**, and its PM2 log (`portos-splash`) is readable through the PortOS logs API.

### Removing the runtime

In **Models → Runtimes**, stop Splash and choose **Uninstall** to remove the
PortOS-installed release. The private model cache and provider presets stay
available for reinstall. An external Splash installation is not changed.
The same control is available for the PortOS-installed mkserve release; its
downloaded checkpoint is also kept.
