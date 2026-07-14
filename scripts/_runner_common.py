"""
Shared helpers for the PortOS local image-gen Python runners
(`flux2_macos.py` and `z_image_turbo.py`).

Both runners present the same CLI surface to `server/services/imageGen/local.js`
— STAGE: markers, USER_ERROR: lines, stepwise PNG previews, sidecar JSON — and
the bits that own that contract live here. Keeping these in one module means a
fix to the HF error mapping or the stepwise decode lands in both runners at
once, instead of drifting.

The runner-specific bits each script still owns:
  - argparse + which pipeline class / weight repo to load
  - `load_pipeline_*` (sdnq / int8 / auto-pipeline / ERNIE)
  - the txt2img-vs-i2i pipe swap (`to_i2i_pipeline` in z-image)

Anything generic — device picking, RNG seeding, memory-saving knobs, sidecar
writes, stepwise preview decode, USER_ERROR markers, and the cause-chain
walker that turns a buried `GatedRepoError` into a friendly link — belongs here.
"""

import json
import logging
import os
import platform
import subprocess
import sys
import threading
from contextlib import contextmanager
from functools import wraps
from pathlib import Path

# Lazy heavy-import note: `torch` and `PIL` are deferred into the functions
# that actually need them (pick_device, make_generator, make_stepwise_callback).
# Lightweight helpers — heartbeat, install_hf_error_handler, write_sidecar —
# stay usable from venvs that haven't pip-installed torch yet (e.g. the
# Hunyuan venv during a partial bootstrap).


@contextmanager
def heartbeat(stage: str, interval: float = 20.0):
    """Emit a periodic STAGE:<stage>:heartbeat:Ns marker so the JS idle
    watchdog (default 5min) doesn't kill silent long pipeline loads.

    Diffusers' from_pretrained on a fully-cached 10-25 GB model is silent
    for several minutes (mmap + weight assignment, no tqdm), which trips
    the JS-side idle watchdog. `handleLine()` in imageGen/local.js sees
    the heartbeat line and resets lastActivityAt. True hangs (GIL-pinned
    C extension, no I/O) still trip the watchdog because the heartbeat
    thread can't print either.
    """
    stop = threading.Event()

    def beat():
        elapsed = 0
        while not stop.wait(interval):
            elapsed += int(interval)
            print(f"STAGE:{stage}:heartbeat:{elapsed}s", file=sys.stderr, flush=True)

    t = threading.Thread(target=beat, daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()
        t.join(timeout=interval + 1)


def parse_user_loras(raw: "str | None") -> "list[tuple[str, float]]":
    """Parse a `--user-loras` JSON string into a list of (path, strength) tuples.

    Shared by the video LoRA runners (scripts/generate_ltx2.py for the dgrauet
    ltx2 runtime, scripts/generate_av_lora.py for the mlx_video runtime) so the
    strict-validation contract that protects against a Node-side bug lives in one
    place. Each entry must be {path: str (existing file), strength: number}.
    Returns [] when the arg is unset. Raises SystemExit with a precise message on
    any malformed input so the failure surfaces before any model load / GPU work.
    """
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"--user-loras is not valid JSON: {e}")
    if not isinstance(data, list):
        raise SystemExit("--user-loras must be a JSON list of {path, strength}")
    specs: "list[tuple[str, float]]" = []
    for i, item in enumerate(data):
        if not isinstance(item, dict) or "path" not in item:
            raise SystemExit(f"user-loras[{i}] must be an object with 'path'")
        path = item["path"]
        if not isinstance(path, str) or not path:
            raise SystemExit(f"user-loras[{i}].path must be a non-empty string")
        if not Path(path).exists():
            raise SystemExit(f"user-loras[{i}].path does not exist: {path}")
        strength = item.get("strength", 1.0)
        try:
            strength = float(strength)
        except (TypeError, ValueError):
            raise SystemExit(f"user-loras[{i}].strength must be a number")
        specs.append((path, strength))
    return specs


def _mac_chip() -> str:
    """Human chip name on macOS ('Apple M5 Max'). Falls back to
    platform.processor()/machine() so the field is never empty."""
    try:
        out = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=2,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return platform.processor() or platform.machine() or "unknown"


def _resolve_pkg_version(pkg: str) -> "str | None":
    """importlib.metadata.version for `pkg`, tolerant of the
    underscore/dash skew between import names and distribution names
    (callers pass whichever they know). Returns None when not installed."""
    from importlib.metadata import PackageNotFoundError, version as _version
    for candidate in (pkg, pkg.replace("_", "-"), pkg.replace("-", "_")):
        try:
            return _version(candidate)
        except PackageNotFoundError:
            continue
        except Exception:
            # An odd/transient metadata error on one spelling shouldn't skip the
            # remaining variants — keep trying, give up (None) only after all do.
            continue
    return None


def build_runtime_fingerprint(runtime_id: str, packages, extra_versions=None) -> dict:
    """Build a runtime-fingerprint dict — which runtime + resolved package
    versions + chip/os/python — so a render (or a bug report) self-documents the
    exact numerical stack it ran on. Garbled/"mosaic" video output is often a
    per-chip/per-runtime numerical bug rather than a crash, and the version trio
    is what makes those reports actionable (see issue #1325).

    Pure (no printing) so the on-demand /status probe (scripts/runtime_fingerprint.py)
    and the inline render-time emit share one definition. Best-effort: a package
    that isn't installed is simply omitted from `versions` rather than raising.
    """
    versions = {}
    for pkg in packages or []:
        v = _resolve_pkg_version(pkg)
        if v is not None:
            versions[pkg] = v
    # Caller-supplied versions that aren't pip distributions (e.g. the CUDA
    # toolkit version from torch.version.cuda) — merge into `versions` so they
    # render in the same list the log + /status UI already show, instead of a
    # top-level field nothing displays.
    for name, val in (extra_versions or {}).items():
        if val is not None:
            versions[name] = val
    fp = {
        "runtime": runtime_id,
        "versions": versions,
        "chip": _mac_chip() if sys.platform == "darwin"
        else (platform.processor() or platform.machine() or "unknown"),
        "os": platform.platform(),
        "python": platform.python_version(),
    }
    return fp


def emit_runtime_fingerprint(runtime_id: str, packages, extra_versions=None) -> dict:
    """Print a single `RUNTIME:<json>` line to stderr — the channel PortOS's
    videoGen line handler (makeVideoGenLineHandler) parses to stamp the
    fingerprint onto the render job + history record. Best-effort: never raises
    (a fingerprint failure must not abort a render). Returns the dict it emitted
    (or {} on failure) so callers can also log it locally if they want."""
    try:
        fp = build_runtime_fingerprint(runtime_id, packages, extra_versions)
        print(f"RUNTIME:{json.dumps(fp)}", file=sys.stderr, flush=True)
        return fp
    except Exception as err:  # pragma: no cover - defensive
        print(f"⚠️ runtime fingerprint failed: {err}", file=sys.stderr, flush=True)
        return {}


class _ClipTruncationFilter(logging.Filter):
    _MARKER = "input was truncated because CLIP can only handle"

    def filter(self, record: logging.LogRecord) -> bool:
        return self._MARKER not in record.getMessage()


def suppress_cosmetic_clip_truncation() -> None:
    """Hide the "CLIP can only handle N tokens" warning on multi-encoder
    pipelines (FLUX.2, HiDream, Qwen-Image, Z-Image, ERNIE).

    Every pipeline in this runner stack runs CLIP alongside a high-context
    encoder (T5 / Llama-3.1-8B / Qwen2-VL); CLIP only contributes pooled
    style/color vectors derived from the first ~77 tokens, while the long
    encoder reads the full prompt. The diffusers warning fires anyway and
    bleeds red into PortOS server logs as if the prompt were being damaged.
    Filter just that one message — every other diffusers warning still flows.

    Logger-level filters don't apply to propagated child records, so the
    filter has to be on the handlers. Idempotent (skips handlers it's
    already attached to) so callers don't need to track first-run state.
    """
    f = _ClipTruncationFilter()
    for name in ("diffusers", "transformers"):
        for handler in logging.getLogger(name).handlers:
            if not any(isinstance(existing, _ClipTruncationFilter) for existing in handler.filters):
                handler.addFilter(f)


def pick_device(requested: str) -> str:
    """Resolve `auto`/`mps`/`cuda`/`cpu` against what torch actually has.
    Falls back to CPU with a warning when the requested accelerator isn't
    available — never silently downgrades without telling the user."""
    import torch
    if requested == "auto":
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
    if requested == "mps" and not torch.backends.mps.is_available():
        print("⚠️ MPS requested but unavailable — falling back to CPU", file=sys.stderr)
        return "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        print("⚠️ CUDA requested but unavailable — falling back to CPU", file=sys.stderr)
        return "cpu"
    return requested


def make_generator(device: str, seed: int) -> "torch.Generator":
    """Seed a torch Generator on the right device. Accelerator generators
    must be initialised with the device string; the CPU fallback uses the
    no-arg form."""
    import torch
    if device in ("cuda", "mps"):
        return torch.Generator(device).manual_seed(int(seed))
    return torch.Generator().manual_seed(int(seed))


# VAE *tiling* is a memory optimization for very large decodes: it splits a
# single image's latent into overlapping spatial tiles, decodes each, and
# blends the overlaps. That blend leaves visible seams / dark bands on the
# small-to-mid resolutions PortOS actually renders — the same reason both
# runners already disable tiling on their i2i paths ("tiled encode of a small
# image produces seams"). At these sizes tiling buys no memory (the VAE decode
# is a rounding error next to the ~20 GB transformer), so only turn it on above
# an area floor no standard/experimental preset reaches. VAE-decode peak memory
# scales with output *area*, so the floor is in total pixels, not edge length:
# the largest preset that routes through these native runners is Qwen's
# experimental 1328×2048 (~2.7 MP), and the image-gen route caps a single edge
# at 3840 (so a 3840² custom render is ~14.7 MP and genuinely wants tiling to
# avoid an OOM on decode). ~6.5 MP sits between the two. VAE *slicing* (batch-dim
# split, no-op at batch 1) and attention slicing never touch spatial layout, so
# they stay unconditional.
_VAE_TILING_MIN_PIXELS = 2560 * 2560  # ~6.5 MP


def set_vae_tiling(pipe, enabled: bool) -> None:
    """Toggle VAE tiling on a loaded pipeline, preferring the pipeline-level
    switch and falling back to the VAE's own. Best-effort (gated on hasattr) so
    pipelines that expose neither still work. Shared by the txt2img size gate in
    `apply_memory_optimizations` and the runners' i2i paths, which force tiling
    off unconditionally (tiled encode of a small init image seams regardless of
    output size)."""
    pipe_attr = "enable_vae_tiling" if enabled else "disable_vae_tiling"
    vae_attr = "enable_tiling" if enabled else "disable_tiling"
    if hasattr(pipe, pipe_attr):
        getattr(pipe, pipe_attr)()
        return
    vae = getattr(pipe, "vae", None)
    if vae is not None and hasattr(vae, vae_attr):
        getattr(vae, vae_attr)()


def apply_memory_optimizations(pipe, width=None, height=None) -> None:
    """Enable memory-saving knobs on the loaded pipeline. Best-effort: each
    call is gated on hasattr so older / smaller pipelines that don't ship a
    given slice / tile path still work.

    Attention slicing and VAE slicing are always safe and always applied. VAE
    *tiling* is applied only when the target render is large enough to need it
    (total pixels > `_VAE_TILING_MIN_PIXELS`); below that it is explicitly
    disabled to avoid tile-seam / black-band artifacts (issue: z-image-turbo
    576×1024 renders showed a black strip at a content-dependent point near the
    bottom). When `width`/`height` are omitted the old always-tile behavior is
    preserved for back-compat."""
    if hasattr(pipe, "enable_attention_slicing"):
        pipe.enable_attention_slicing()
    if hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()

    # A diffusers default or a reused pipeline could leave tiling enabled, so
    # drive it explicitly in both directions rather than only turning it on.
    want_tiling = True
    if width and height:
        want_tiling = (int(width) * int(height)) > _VAE_TILING_MIN_PIXELS
    set_vae_tiling(pipe, want_tiling)


# Headroom reserved on top of the resident weights for activations + allocator
# fragmentation when deciding whether a pipeline fits in *currently free* VRAM.
# Catches the case where another process is hogging the card even for a
# mid-size model.
_ACTIVATION_RESERVE_BYTES = 3 * 1024 ** 3

# Second, resolution-independent offload trigger: when the weights alone exceed
# this fraction of the card's *total* VRAM, force offload regardless of how
# much is momentarily free. A model that fills most of the card leaves no
# bounded margin for high-res activations or the per-step stepwise VAE decode,
# and on Windows the NVIDIA driver answers the overflow with silent sysmem
# fallback (~50x slowdown) rather than OOM — so a fixed activation reserve
# can't protect against it. Offload is cheap for these (the transformer stays
# resident across the whole denoising loop), so erring toward it costs a few
# seconds of one-time component paging and removes the thrash cliff entirely.
# 0.5 keeps SDXL (~7 GB) / SD-1.5 (~2 GB) fully resident on a 24 GB card while
# routing the ~19-20 GB Z-Image / ERNIE / Qwen bf16 pipelines to offload.
_OFFLOAD_VRAM_FRACTION = 0.5


def _pipeline_weight_bytes(pipe) -> int:
    """Total bytes of the pipeline's parameters + buffers, de-duplicated by
    storage pointer so tied / shared weights aren't double-counted."""
    components = getattr(pipe, "components", None) or {}
    modules = [m for m in components.values() if hasattr(m, "parameters")]
    seen = set()
    total = 0
    for module in modules:
        for tensor in list(module.parameters()) + list(module.buffers()):
            key = tensor.data_ptr()
            if key in seen or key == 0:
                continue
            seen.add(key)
            total += tensor.numel() * tensor.element_size()
    return total


def place_pipeline(pipe, device: str) -> str:
    """Move a loaded diffusers pipeline onto the compute device, choosing
    between full-GPU residency and model CPU offload based on free VRAM.

    On CUDA, a pipeline whose weights nearly fill the card (Z-Image-Turbo /
    ERNIE / Qwen bf16 are ~20 GB on a 24 GB GPU) leaves no room for the
    forward pass's activations. On Windows the NVIDIA driver then silently
    spills the overflow into system RAM ("sysmem fallback") instead of
    OOM-ing, and every denoising step thrashes across PCIe — ~50x slower than
    the GPU is capable of. When the weights plus an activation reserve won't
    fit in free VRAM, fall back to `enable_model_cpu_offload()`: the
    transformer stays resident across the loop while the text encoder and VAE
    are paged in only for their one-shot forward, so peak VRAM drops well
    under the card's limit and the steps run at full GPU speed.

    MPS / CPU keep the plain `.to(device)` path — offload is a CUDA+accelerate
    feature and the sysmem-fallback failure mode it guards against is
    CUDA-specific. Override the heuristic with `PORTOS_IMAGE_OFFLOAD=1`
    (force offload) or `PORTOS_IMAGE_OFFLOAD=0` (force full residency).
    Returns the effective placement string for logging.
    """
    if device != "cuda":
        pipe.to(device)
        return device

    import torch

    override = os.environ.get("PORTOS_IMAGE_OFFLOAD", "").strip().lower()
    can_offload = hasattr(pipe, "enable_model_cpu_offload")
    if override in ("0", "false", "never"):
        force_offload = False
    elif override in ("1", "true", "force", "always"):
        force_offload = True
    else:
        weight_bytes = _pipeline_weight_bytes(pipe)
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        fits_now = (weight_bytes + _ACTIVATION_RESERVE_BYTES) <= free_bytes
        fills_card = weight_bytes > _OFFLOAD_VRAM_FRACTION * total_bytes
        force_offload = fills_card or not fits_now
        gb = 1024 ** 3
        reason = "fills card" if fills_card else ("low free VRAM" if not fits_now else "fits")
        print(
            f"🧮 image-gen VRAM: weights ~{weight_bytes / gb:.1f}GB, "
            f"free ~{free_bytes / gb:.1f}GB, total ~{total_bytes / gb:.1f}GB ({reason}) → "
            f"{'model CPU offload' if force_offload else 'full GPU residency'}",
            file=sys.stderr, flush=True,
        )

    if force_offload and can_offload:
        pipe.enable_model_cpu_offload()
        return "cuda+offload"
    pipe.to(device)
    return device


def write_sidecar(output: str, payload: dict) -> None:
    """Write `<output>.metadata.json` next to the generated image. The
    server's gallery scanner picks this up to surface prompt/seed/model
    in the lightbox without re-parsing the PNG."""
    sidecar = Path(output).with_suffix(".metadata.json")
    sidecar.write_text(json.dumps(payload, indent=2))


def make_stepwise_callback(
    stepwise_dir: str,
    pipe,
    height: int,
    width: int,
    *,
    unpack_latents=None,
    preview_decoder=None,
):
    """Return a `callback_on_step_end` that decodes the running latent into
    a small preview PNG. `local.js#processLatestFrame` watches this dir and
    streams the freshest frame to the SSE client.

    The only per-runner difference is how packed latents are projected back
    to `(B, C, H_lat, W_lat)` before the VAE decode:

      - mflux / z-image: latents already arrive in `(B, C, H_lat, W_lat)`
        layout. Pass `unpack_latents=None`; the callback simply skips the
        step when latents are not 4-D (rather than guessing the shape).
      - flux2: transformer-packed latents come back as
        `(B, num_patches, C*p*p)`. Pass a callable that takes
        `(latents, height, width)` and returns the unpacked tensor.
      - ernie: latents stay 4-D but are 2x2 patch-packed (e.g. `(B, 128, H/2, W/2)`
        for a 32-ch VAE) AND need pipeline-specific BN-stats unnormalization
        before `vae.decode`, not the standard `latents/scaling + shift`.
        Pass `preview_decoder=fn(pipe, latents) -> image_tensor` to fully
        override the per-step decode path.
    """
    if not stepwise_dir:
        return None
    import torch
    from PIL import Image
    out = Path(stepwise_dir)
    out.mkdir(parents=True, exist_ok=True)
    vae = pipe.vae
    scaling = getattr(vae.config, "scaling_factor", 1.0) or 1.0
    shift = getattr(vae.config, "shift_factor", 0.0) or 0.0
    # Capture the VAE's weight dtype + device so the callback can align the
    # scaled latents before decode. Some pipelines (ERNIE, Flux2) keep latents
    # in float32 even when the pipeline was loaded with torch_dtype=bfloat16,
    # so `vae.decode(latents / scaling + shift)` would feed float32 into a
    # bfloat16 VAE and error with "Input type (float) and bias type
    # (c10::BFloat16) should be the same".
    try:
        vae_param = next(vae.parameters())
        vae_dtype, vae_device = vae_param.dtype, vae_param.device
    except StopIteration:
        vae_dtype, vae_device = None, None
    # Under `enable_model_cpu_offload()` (see place_pipeline) the VAE's params
    # rest on CPU but its forward runs on the accelerate hook's execution
    # device (CUDA) — and the hook moves the *weights* there without moving the
    # latents we hand it, so aligning the preview latents to the resting
    # (CPU) device decodes with "weight on cuda:0, other tensors on cpu". Target
    # the execution device instead, so the latents land where the VAE will run.
    _vae_hook = getattr(vae, "_hf_hook", None)
    _exec_device = getattr(_vae_hook, "execution_device", None)
    if _exec_device is not None:
        vae_device = _exec_device

    fired = {"count": 0, "saved": 0}

    @torch.no_grad()
    def cb(pipe, step_index, _timestep, callback_kwargs):
        fired["count"] += 1
        latents = callback_kwargs.get("latents")
        if latents is None:
            if step_index == 0:
                print("⚠️ stepwise: latents missing from callback_kwargs", file=sys.stderr)
            return callback_kwargs
        if step_index == 0:
            print(f"🖼️  stepwise: callback live, latents.shape={tuple(latents.shape)}", file=sys.stderr)
        # Best-effort decode. Errors here must not abort generation — the
        # final image is still produced after the last step.
        try:
            if latents.dim() == 3:
                if unpack_latents is None:
                    # No unpack helper provided; skip preview rather than
                    # guess the shape. The final image still saves.
                    return callback_kwargs
                latents = unpack_latents(latents, height, width)
            elif latents.dim() != 4:
                return callback_kwargs
            if preview_decoder is not None:
                aligned = latents
                if vae_dtype is not None and (aligned.dtype != vae_dtype or aligned.device != vae_device):
                    aligned = aligned.to(device=vae_device, dtype=vae_dtype)
                decoded = preview_decoder(pipe, aligned)
            else:
                scaled = latents / scaling + shift
                if vae_dtype is not None and (scaled.dtype != vae_dtype or scaled.device != vae_device):
                    scaled = scaled.to(device=vae_device, dtype=vae_dtype)
                decoded = vae.decode(scaled, return_dict=False)[0]
            decoded = (decoded.clamp(-1, 1) + 1) / 2
            arr = (decoded[0].float().cpu().permute(1, 2, 0).numpy() * 255).astype("uint8")
            img = Image.fromarray(arr)
            img.thumbnail((512, 512), Image.LANCZOS)
            img.save(out / f"step_{step_index + 1}.png", "PNG", optimize=False)
            fired["saved"] += 1
        except Exception as err:
            print(f"⚠️ stepwise preview failed at step {step_index}: {type(err).__name__}: {err}", file=sys.stderr)
        return callback_kwargs

    cb._stats = fired
    return cb


def _emit_user_error(kind: str, message: str, repo: str = "") -> None:
    """Emit a structured single-line error the server's stderr parser picks up
    for the SSE error event. `kind` is a stable identifier the UI maps to a
    friendly heading; `message` is the human prose; `repo` (optional) is the
    HF repo to deep-link the user to so they can request access / check token."""
    line = f"USER_ERROR:{kind}"
    if repo:
        line += f":{repo}"
    print(line, file=sys.stderr, flush=True)
    print(f"❌ {message}", file=sys.stderr, flush=True)


def _repo_from_hf_error(hf_err) -> str:
    """huggingface_hub doesn't always populate `repo_id` on the error.
    Fall back to parsing the failing URL — `/<owner>/<repo>/resolve/...`
    for file downloads or `/api/models/<owner>/<repo>` for API hits."""
    repo = getattr(hf_err, "repo_id", None) or ""
    if repo:
        return repo
    url = (
        getattr(getattr(hf_err, "response", None), "url", None)
        or getattr(getattr(hf_err, "request", None), "url", None)
    )
    if url is None:
        return ""
    path = str(url).split("huggingface.co", 1)[-1].lstrip("/")
    parts = path.split("/")
    if parts[:1] == ["api"] and len(parts) >= 4 and parts[1] in {"models", "datasets", "spaces"}:
        return f"{parts[2]}/{parts[3]}"
    if len(parts) >= 2 and parts[0] not in {"api", "settings", "join"}:
        return f"{parts[0]}/{parts[1]}"
    return ""


def install_hf_error_handler(main_fn):
    """Decorator that wraps a runner's `main()` in the canonical HuggingFace
    error-to-USER_ERROR-line translation.

    Walks the exception cause chain so a buried `GatedRepoError` /
    `RepositoryNotFoundError` / 401 `HfHubHTTPError` produces a friendly
    `USER_ERROR:<kind>:<repo>` line + `❌ <message>` on stderr — even when
    diffusers wraps the underlying HF error in OSError. Unknown failures
    emit a generic `USER_ERROR:unknown` marker and re-raise so the original
    traceback still surfaces.

    Usage:

        @install_hf_error_handler
        def main():
            ...

        if __name__ == "__main__":
            main()
    """

    @wraps(main_fn)
    def wrapped(*args, **kwargs):
        try:
            return main_fn(*args, **kwargs)
        except KeyboardInterrupt:
            sys.exit(130)
        except SystemExit:
            raise
        except Exception as err:
            # Lazy-import so the module loads on systems without
            # huggingface_hub installed (e.g. test environments).
            from huggingface_hub.errors import (
                GatedRepoError,
                HfHubHTTPError,
                RepositoryNotFoundError,
            )
            # Walk the cause chain — diffusers wraps HF errors in OSError, so
            # the innermost exception is what tells us the real story.
            chain = []
            cur = err
            while cur is not None:
                chain.append(cur)
                cur = cur.__cause__ or cur.__context__
            gated = next((e for e in chain if isinstance(e, GatedRepoError)), None)
            notfound = next(
                (e for e in chain if isinstance(e, RepositoryNotFoundError)), None
            )
            http = next((e for e in chain if isinstance(e, HfHubHTTPError)), None)
            if gated is not None:
                repo = _repo_from_hf_error(gated)
                url = f"https://huggingface.co/{repo}" if repo else "https://huggingface.co/"
                _emit_user_error(
                    "gated_repo",
                    f"Access to {repo or 'the model repo'} is restricted. Visit {url} "
                    f"to request access, then make sure your HF token is set in PortOS.",
                    repo,
                )
                sys.exit(2)
            status = (
                getattr(getattr(http, "response", None), "status_code", None)
                if http
                else None
            )
            if status == 401:
                _emit_user_error(
                    "hf_unauthorized",
                    "HuggingFace rejected the token (401). Check that the token is valid "
                    "and has read access, then re-paste it in PortOS.",
                )
                sys.exit(2)
            if notfound is not None:
                repo = _repo_from_hf_error(notfound)
                _emit_user_error(
                    "repo_not_found", f"HF repo not found: {repo or '(unknown)'}", repo
                )
                sys.exit(2)
            # Unknown failure — emit the original traceback (raised below) plus
            # a generic structured marker so the UI shows something useful.
            _emit_user_error("unknown", f"{type(err).__name__}: {err}")
            raise

    return wrapped
