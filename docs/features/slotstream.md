# Slotstream on Apple Silicon

Slotstream streams MoE expert weights from SSD. Open **Models → Runtimes → Local Runtime Servers** on an Apple Silicon Mac, then **Install** Slotstream. PortOS installs its pinned executable separately from checkpoints.

1. Under **Slotstream (SSD-streaming MoE)**, select **Add a checkpoint**. Review its disk estimate, choose **Download checkpoint**, and wait for verification. An interrupted transfer can resume on the next attempt.
2. Choose the cached checkpoint and check the memory plan before starting. Save a checkpoint, port and optional memory cap with **Save configuration**. `SLOTSTREAM_MODEL_DIR` overrides the default `~/.slotstream/models` location.
3. Press **Start Slotstream** or let a PortOS request start it with the saved options. Starting requires a cached checkpoint. The default endpoint is `http://127.0.0.1:5564/v1`. Port 11434 is reserved for Ollama.
4. Enable the **Slotstream (SSD-streaming MoE)** API preset under **AI Providers** for supported text generation tasks. Use the checkpoint actually loaded. CoS coding requires a separate tool-capable harness.

Set **Idle release** to free memory after the configured window. Only traffic routed through PortOS resets the timer or starts an idle process. Set it to `0` for a process serving direct clients. **Save PM2 list for reboot** omits Slotstream so boot leaves its memory available. Run `pm2 logs portos-slotstream` on the host to inspect startup.

To remove the PortOS-installed executable, stop Slotstream and choose **Uninstall**. Cached weights and saved options remain for reinstall.
