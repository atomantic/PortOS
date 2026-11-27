"""Talking-only AvatarForcing model math for offline Voice Call rendering."""

from math import ceil

import torch
from torch.nn import functional as F

FRAMES_PER_SECOND = 25
SAMPLE_RATE = 16_000
WINDOW = 50
BLOCK = 10
CLEAN = WINDOW - BLOCK

# Stage-specific flow-matching parameters for continuous non-speaking presence:
# (guidance_scale toward real Wav2Vec2 silence conditioning, latent noise_scale).
# Stronger silence guidance keeps lips naturally closed while preserving organic
# neural blinking, breathing, gaze shifts, and subtle head movement.
IDLE_STAGE_PARAMS = {
    "idle": (1.8, 1.0),
    "listening": (1.4, 1.05),
    "thinking": (1.6, 0.95),
}


def split_heads(tensor, heads):
    return tensor.unflatten(-1, (heads, -1)).transpose(1, 2)


def attention(q, k, v, heads, mask=None):
    q, k, v = [split_heads(t, heads) for t in (q, k, v)]
    return F.scaled_dot_product_attention(q, k, v, attn_mask=mask).transpose(1, 2).flatten(2)


def dense(weights, name, values):
    return F.linear(values, weights[name + ".weight"], weights.get(name + ".bias"))


def norm(values, weight=None, bias=None, eps=1e-5):
    return F.layer_norm(values, (values.shape[-1],), weight, bias, eps)


def conditioning(weights, audio):
    p = "flow_transformer.c_embedder."
    zero = torch.zeros_like(audio)

    def affine(name, x):
        return dense(weights, p + name, x)

    def normalize(name, x):
        return F.silu(norm(x, weights[p + name + ".weight"], weights[p + name + ".bias"]))

    def cross(name, q_source, kv_source):
        parts = weights[p + name + ".in_proj_weight"].chunk(3, dim=0)
        biases = weights[p + name + ".in_proj_bias"].chunk(3, dim=0)
        q, k, v = [F.linear(x, weight, bias)
                   for x, weight, bias in zip((q_source, kv_source, kv_source), parts, biases)]
        return affine(name + ".out_proj", attention(q, k, v, 4))

    embedded = normalize("motion_embedder.1", affine("motion_embedder.0", zero))
    embedded = normalize("motion_embedder.4", affine("motion_embedder.3", embedded))
    aligned = normalize("ln1", embedded + cross("dual_modal_attn", embedded, zero))
    mixed = normalize("ln2", audio + cross("user_agent_attn", audio, aligned))
    return affine("to_cond_user", mixed)


def rotate(tensor, phase):
    cos, sin = phase
    even, odd = tensor[..., ::2].float(), tensor[..., 1::2].float()
    return torch.stack((even * cos - odd * sin, odd * cos + even * sin), dim=-1).flatten(-2).to(tensor.dtype)


def inference_masks(device):
    """Attention masks for inference (True means a frame can attend)."""
    query = torch.arange(WINDOW, device=device)[:, None]
    key = query.T
    return (key // BLOCK < query // BLOCK) | (key <= query + 2), (key - query).abs() <= 2


def predict(weights, latents, reference, cond, steps, phase):
    p = "flow_transformer."

    def affine(name, x):
        return dense(weights, p + name, x)

    def modulation(x, shift, gain):
        return norm(x, eps=1e-6) * (1 + gain) + shift

    inv = 10000 ** (-torch.arange(128, device=steps.device, dtype=torch.float32) / 128)
    scalar = steps[..., None] * inv
    t = affine("t_embedder.mlp.0", torch.cat((scalar.cos(), scalar.sin()), dim=-1).to(latents.dtype))
    t = affine("t_embedder.mlp.2", F.silu(t))
    shift_a, gain_a, gate_a, shift_m, gain_m, gate_m = affine("adaLN_modulation.1", F.silu(t)).chunk(6, -1)
    x = affine("x_embedder.proj", torch.cat((latents, reference[:, None].expand_as(latents)), dim=-1))
    # Saved checkpoint masks encode positions to block, not positions to
    # attend. Rebuild the inference masks instead of treating training buffers
    # as PyTorch scaled-dot-product attention's True=allowed mask.
    self_mask, cross_mask = inference_masks(x.device)
    for index in range(8):
        prefix = f"blocks.{index}."
        qkv = affine(prefix + "attn.qkv", modulation(x, shift_a, gain_a)).chunk(3, -1)
        q, k, v = [split_heads(a, 8) for a in qkv]
        a = F.scaled_dot_product_attention(rotate(q, phase), rotate(k, phase), v, attn_mask=self_mask)
        x = x + gate_a * affine(prefix + "attn.proj", a.transpose(1, 2).flatten(2))
        q = affine(prefix + "cross_attn.q", norm(x, eps=1e-6))
        k, v = affine(prefix + "cross_attn.kv", cond).chunk(2, -1)
        x = x + affine(prefix + "cross_attn.proj", attention(q, k, v, 8, cross_mask))
        y = affine(prefix + "mlp.fc1", modulation(x, shift_m, gain_m))
        x = x + gate_m * affine(prefix + "mlp.fc2", F.gelu(y, approximate="tanh"))
    shift, gain = affine("final_layer.adaLN_modulation.1", F.silu(t)).chunk(2, -1)
    return affine("final_layer.linear", modulation(x, shift, gain))


def rope_phase(device):
    positions = torch.arange(WINDOW, device=device, dtype=torch.float32)
    inv_rope = 10000 ** (-torch.arange(0, 128, 2, device=device, dtype=torch.float32) / 128)
    angles = positions[:, None] * inv_rope
    return angles.cos(), angles.sin()


def tail_context(motion, audio_window, end_index):
    """Extract the CLEAN-frame motion and audio suffix ending at end_index."""
    if end_index >= CLEAN:
        start = end_index - CLEAN
        return motion[:, start:end_index].clone(), audio_window[:, start:end_index].clone()
    pad = CLEAN - end_index
    m = torch.cat((motion[:, :1].expand(-1, pad, -1), motion[:, :end_index]), dim=1)
    a = torch.cat((audio_window[:, :1].expand(-1, pad, -1), audio_window[:, :end_index]), dim=1)
    return m.clone(), a.clone()


def denoise_window(weights, audio_window, ref, phase, timeline, generator, clean, history_tail,
                   guidance=2.0, noise_scale=1.0, cond=None, cancelled=lambda: False):
    if cond is None:
        cond = conditioning(weights, torch.cat((torch.zeros_like(audio_window), audio_window), dim=0))
    noise = torch.randn((1, WINDOW - clean, 512), generator=generator).to(audio_window.device, audio_window.dtype)
    if noise_scale != 1.0:
        noise = noise * noise_scale
    motion = torch.cat((history_tail, noise), dim=1) if clean else noise
    for current, following in zip(timeline, timeline[1:]):
        if cancelled():
            return None
        t = audio_window.new_zeros((2, WINDOW), dtype=torch.float32)
        t[:, clean:] = current
        predicted = predict(weights, motion.expand(2, -1, -1), ref, cond, t, phase)
        base, guided = predicted.chunk(2, dim=0)
        field = base + guidance * (guided - base)
        # For linear flow matching the closed-form step simplifies to
        # x_next = x + (sigma_next - sigma_current) * v.
        motion[:, clean:] += ((round(following) - round(current)) / 1000) * field[:, clean:]
    return motion


def sample(weights, audio, ref_motion, steps=8, seed=66, cancelled=lambda: False,
           state=None, guidance=2.0, on_state=None):
    """Yield completed latent blocks; recompute a rolling window (no KV optimization).

    When `state=(history_tail, audio_tail)` is provided (each shape `(1, CLEAN, 512)`),
    prepends `audio_tail` to `audio` so frame 0 of `audio` aligns smoothly onto the
    previous 40 clean motion frames with no pose snap and exact lip-sync alignment.
    """
    generator = torch.Generator(device="cpu").manual_seed(seed)
    count = audio.shape[1]
    phase = rope_phase(audio.device)
    # The checkpoint uses unshifted flow matching. Round fractional times to
    # the nearest training sigma (with zero handled explicitly).
    timeline = [1000 * (steps - n) / steps for n in range(steps + 1)]
    ref = ref_motion.expand(2, -1)

    if state is not None:
        history_tail, audio_tail = state
        padded = torch.cat((audio_tail.to(audio.device, audio.dtype), audio), dim=1)
        for offset in range(0, count, BLOCK):
            audio_window = padded[:, offset:offset + WINDOW]
            if audio_window.shape[1] < WINDOW:
                audio_window = torch.cat((audio_window,
                    audio_window[:, -1:].expand(-1, WINDOW - audio_window.shape[1], -1)), dim=1)
            motion = denoise_window(weights, audio_window, ref, phase, timeline, generator,
                                    CLEAN, history_tail, guidance=guidance, cancelled=cancelled)
            if motion is None:
                return
            take = min(BLOCK, count - offset)
            history_tail, audio_tail = tail_context(motion, audio_window, CLEAN + take)
            if on_state is not None:
                on_state((history_tail, audio_tail))
            yield motion[:, CLEAN:CLEAN + take]
        return

    history_tail = None
    for start in range(0, max(WINDOW, count) - WINDOW + BLOCK, BLOCK):
        if start and start + CLEAN >= count:
            break
        audio_window = audio[:, start:start + WINDOW]
        if audio_window.shape[1] < WINDOW:
            audio_window = torch.cat((audio_window,
                audio_window[:, -1:].expand(-1, WINDOW - audio_window.shape[1], -1)), dim=1)
        clean = CLEAN if history_tail is not None else 0
        motion = denoise_window(weights, audio_window, ref, phase, timeline, generator,
                                clean, history_tail, guidance=guidance, cancelled=cancelled)
        if motion is None:
            return
        end_index = min(WINDOW, count - start)
        history_tail, audio_tail = tail_context(motion, audio_window, end_index)
        if on_state is not None:
            on_state((history_tail, audio_tail))
        yield motion[:, clean:end_index]


def idle_blocks(weights, silence_window, ref_motion, *, steps=8, seed=66, stage="idle",
                cancelled=lambda: False, state=None, max_blocks=150, on_state=None):
    """Continuously yield non-speaking neural motion blocks conditioned on silence."""
    guidance, noise_scale = IDLE_STAGE_PARAMS.get(stage, IDLE_STAGE_PARAMS["idle"])
    generator = torch.Generator(device="cpu").manual_seed(seed)
    phase = rope_phase(silence_window.device)
    timeline = [1000 * (steps - n) / steps for n in range(steps + 1)]
    ref = ref_motion.expand(2, -1)
    silence_cond = conditioning(weights, torch.cat((torch.zeros_like(silence_window), silence_window), dim=0))
    silence_block = silence_window[:, -BLOCK:]

    history_tail, audio_tail = state if state is not None else (None, None)
    # Count how many trailing blocks of prior speech audio remain before audio_tail
    # is purely silence and can reuse the cached `silence_cond` directly.
    transition_blocks = (CLEAN // BLOCK) if audio_tail is not None else 0

    for _ in range(max_blocks):
        if cancelled():
            return
        if history_tail is not None and audio_tail is not None and transition_blocks > 0:
            audio_window = torch.cat((audio_tail.to(silence_window.device, silence_window.dtype), silence_block), dim=1)
            cond = None
            transition_blocks -= 1
        else:
            audio_window = silence_window
            cond = silence_cond
        clean = CLEAN if history_tail is not None else 0
        motion = denoise_window(weights, audio_window, ref, phase, timeline, generator,
                                clean, history_tail, guidance=guidance, noise_scale=noise_scale,
                                cond=cond, cancelled=cancelled)
        if motion is None:
            return
        history_tail, audio_tail = tail_context(motion, audio_window, WINDOW)
        if on_state is not None:
            on_state((history_tail, audio_tail))
        yield motion[:, clean:WINDOW]


def audio_latents(model, waveform, weights):
    frames = ceil(waveform.shape[-1] * FRAMES_PER_SECOND / SAMPLE_RATE)
    length = frames * (SAMPLE_RATE // FRAMES_PER_SECOND)
    if length > waveform.shape[-1]:
        waveform = F.pad(waveform[:, None], (0, length - waveform.shape[-1]), mode="replicate")[:, 0]
    extracted = model.feature_extractor(waveform)
    extracted = F.interpolate(extracted, size=frames, mode="linear", align_corners=True).transpose(1, 2)
    encoded, _ = model.feature_projection(extracted)
    # Encoder input must be the feature sequence resampled to the video clock.
    # Newer Transformers only collects hidden states at the outer model call,
    # which would skip that resampling. Capture this checkpoint's 12 layer
    # outputs without modifying model internals or relying on private decorators.
    layers = []
    def capture(_module, _args, output):
        layers.append(output[0] if isinstance(output, tuple) else output)

    hooks = [layer.register_forward_hook(capture) for layer in model.encoder.layers]
    try:
        model.encoder(encoded)
    finally:
        for hook in hooks:
            hook.remove()
    features = torch.stack(layers, dim=2).flatten(2)
    p = "audio_encoder.audio_projection."
    projected = dense(weights, p + "0", features.to(weights[p + "0.weight"].dtype))
    return F.silu(norm(projected, weights[p + "1.weight"], weights[p + "1.bias"]))
