# mkserve (optional local Inkling engine)

On a supported Mac, open **Models → Runtimes → mkserve**. Click **Install** to
install the runtime and fetch about 19 GiB of model weights, and **Start** after
the install finishes. **Stop** releases the model's memory. These actions do not
use Homebrew or need Python, Xcode, or a terminal. PortOS manages this engine only
on a native Apple M5 Max host with macOS 26 or later and 36 GiB or more of unified
memory. That is the chip tested by the upstream engine; other backends are
available for other machines.

Start uses the verified local checkpoint without downloads. The service listens
only on `127.0.0.1:8002`, with a 32,768-token context and one active sequence.
It serves text through the OpenAI-compatible API (`/v1`) and Anthropic Messages
API (`/v1/messages`). Its fixed model ID is `thinkingmachines/Inkling-2-Mini`.
It is opt-in: installing it does not change another provider or runtime's
settings or launch a model automatically. PortOS will not stop or replace a
listener it did not start.

**Update** installs the newer pinned bundle when PortOS ships one. Stop a running
managed mkserve before updating. The update reuses the verified checkpoint if the
model revision has not changed; a failed update does not activate a partial
installation. Once the new bundle is active, PortOS removes the superseded
managed bundle and any checkpoint it replaced. Interrupted checkpoint downloads
can resume when you retry.

The build and checkpoint are reproducible caches under `data/cache/mkserve`,
excluded from PortOS backups. The engine is pinned to the reviewed upstream
[megakernel-zoo commit](https://github.com/dangxingyu/megakernel-zoo/tree/95e315c808a7d935c10ef924a8fc0d901bfc3b89).
The [model files](https://huggingface.co/thinkingmachines/Inkling-2-Mini/tree/c9d028302cd0f035fdf8e7e91f089a4ce94d2195)
are verified against pinned SHA-256 digests, including the DSpark draft head.
