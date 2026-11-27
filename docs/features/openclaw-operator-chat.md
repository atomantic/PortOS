# OpenClaw Operator Chat

OpenClaw Operator Chat connects the PortOS conversation UI to a local or privately reachable [OpenClaw](https://github.com/openclaw/openclaw) runtime. OpenClaw runs the assistant and tools. PortOS provides the session list, history, context controls and streaming composer.

1. Enable OpenClaw in **Settings → Features** on this install.
2. Configure the private runtime in `data/openclaw/config.json` using the [reference configuration](../../data.reference/openclaw/config.json), or set `OPENCLAW_BASE_URL` and the applicable `OPENCLAW_*` variables. Environment settings override the file. Use an HTTP(S) endpoint, keep any token in local configuration, and ensure the runtime offers tool invocation and the Responses endpoint.
3. Open **OpenClaw** from the palette or go to `/openclaw`. Confirm the connection status, then select an existing session or use the configured default. PortOS discovers sessions from the runtime.
4. Add app, directory or extra instructions and attachments only when you want to send that context to the configured runtime. Use Stop to cancel an active stream.

Key environment settings include `OPENCLAW_ENABLED`, `OPENCLAW_BASE_URL`, `OPENCLAW_AUTH_TOKEN`, `OPENCLAW_AUTH_HEADER` (default `Authorization`), `OPENCLAW_AUTH_SCHEME` (default `Bearer`), `OPENCLAW_DEFAULT_SESSION`, `OPENCLAW_DEFAULT_AGENT_ID` (default `main`), `OPENCLAW_TIMEOUT_MS` and `OPENCLAW_LABEL`.

**Unconfigured** means the adapter needs local settings. **Unavailable** means the adapter is configured but its probe failed. Check the runtime URL, private network access, and token before retrying. Disabling the feature hides the UI and refuses runtime requests on this install.
