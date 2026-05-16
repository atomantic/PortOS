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
import sys
import threading
from contextlib import contextmanager
from functools import wraps
from pathlib import Path

import torch
from PIL import Image


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


def pick_device(requested: str) -> str:
    """Resolve `auto`/`mps`/`cuda`/`cpu` against what torch actually has.
    Falls back to CPU with a warning when the requested accelerator isn't
    available — never silently downgrades without telling the user."""
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


def make_generator(device: str, seed: int) -> torch.Generator:
    """Seed a torch Generator on the right device. Accelerator generators
    must be initialised with the device string; the CPU fallback uses the
    no-arg form."""
    if device in ("cuda", "mps"):
        return torch.Generator(device).manual_seed(int(seed))
    return torch.Generator().manual_seed(int(seed))


def apply_memory_optimizations(pipe) -> None:
    """Enable every memory-saving knob diffusers exposes on the loaded
    pipeline. Best-effort: each call is gated on hasattr so older / smaller
    pipelines that don't ship a given slice / tile path still work."""
    if hasattr(pipe, "enable_attention_slicing"):
        pipe.enable_attention_slicing()
    if hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    vae = getattr(pipe, "vae", None)
    if hasattr(pipe, "enable_vae_tiling"):
        pipe.enable_vae_tiling()
    elif vae is not None and hasattr(vae, "enable_tiling"):
        vae.enable_tiling()


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
