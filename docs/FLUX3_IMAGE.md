# FLUX.3 Klein on Apple Silicon

PortOS offers the distilled mflux-community Q4, Q6 and Q8 conversions for
text-to-image and edits with up to ten reference images. Choose a FLUX.3 model
in Image Gen, then use **Install / repair FLUX.3 runtime** if needed. Installation
requires `uv`, macOS 14+ and Apple Silicon; the shipped profiles require 32 GB
unified memory. Runtime packages and model weights are separate downloads.

The runtime lives at `<data>/python/venv-flux3`, with mflux 0.23.0 and pinned
MLX/Transformers dependencies. It does not upgrade the older shared FLUX.1 or
video environment. The installer verifies imports without loading weights.
Selecting **Download** or generating the first image fetches the selected
community checkpoint into the normal Hugging Face cache. Explicit downloads and
later reconciliation update the model inventory.
Approximate checkpoint downloads: Q4 5.3 GB, Q6 7.6 GB, Q8 9.9 GB.

Write a complete scene caption, or explicitly use Refine to expand your prompt.
PortOS sends your text unchanged; it does not automatically run BFL's separate
prompt upsampler. The default is 16 steps. Quantization is built into the selected
checkpoint and guidance is fixed. This integration rejects negative prompts,
LoRAs, init-image strength and per-reference strength overrides. Put edit images
in the reference slots. Dimensions must be multiples of 16, from 256 through
1024 on each edge. Federated edits retain the wire protocol's eight-image limit.

## License and access

The weights retain the [FLUX Kommunity License v1.0](https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md).
It permits non-commercial use and a commercial-output exception for qualifying
users whose combined annualized revenue with affiliates is below US$5 million,
subject to its other restrictions. Qualifying use also requires content
filtering or output review before distribution, plus AI disclosures where law
requires them. Read the full terms for your use case.

BFL's [original repository](https://huggingface.co/black-forest-labs/flux-3-image-klein)
is gated. The [Q4](https://huggingface.co/mflux-community/flux-3-image-klein-mflux-q4),
[Q6](https://huggingface.co/mflux-community/flux-3-image-klein-mflux-q6) and
[Q8](https://huggingface.co/mflux-community/flux-3-image-klein-mflux-q8) conversions
were ungated when verified on 2026-11-01. Community download access does not
certify upstream license acceptance. The license binds access/use and does not
require a separate application checkbox, so PortOS displays the terms without
recording an acceptance or accepting terms on the operator's behalf. If access
is later gated, review the model's Hugging Face conditions yourself and configure
your existing authorized token in Image Gen settings; PortOS surfaces access
errors rather than bypassing the gate.

## Verification and limits

The issue's provenance is real: [Phosphene v4.19.14](https://github.com/mrbizarro/Phosphene/commit/43c2b9abd7edde4fca1dbfb265e88dfe642317e6)
introduced FLUX.3 Klein. CLI modules and flags were verified against the
[published mflux 0.23.0 source](https://pypi.org/project/mflux/0.23.0/) and the
[upstream runner documentation](https://github.com/mflux-community/mflux/tree/main/src/mflux/models/flux3).

Automated tests cover registration/upgrades, hardware requirements, runtime
installation/repair/cancellation, readiness, HTTP reference admission, CLI
arguments and UI controls. No model weights were downloaded and no hardware
inference was performed for this integration. GPU output quality and peak memory
on each quantization profile remain unverified in PortOS. The 32 GB floor is
conservative headroom over upstream's published memory measurements, not a local
benchmark. The undistilled Base and bf16 conversions are not registered.
