#!/usr/bin/env python3
"""Inspect H3 vision precision with cached weights and a synthetic input (#8867).

Run each backend/device in a separate process with torch, mlx, mlx-vlm and
transformers installed at the versions in docs/research/minimax-h3-continuity.md.
No model downloads or full language-model loads. GPU runs require an idle GPU.
Outputs are observations, not a pass/fail equivalence test; compare the four
arrays with max(abs(reference-actual)) and norm(reference-actual)/norm(reference).
"""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path


def gradient_noise_source():
    """Integer-only deterministic fixture, independent of random-library versions."""
    import numpy as np
    from PIL import Image
    y, x = np.indices((1344, 768), dtype=np.uint32)
    noise = ((x * 1103515245 + y * 12345 + 42) >> 16) & 31
    pixels = np.stack(((x * 255 // 767 + noise) % 256,
                       (y * 255 // 1343 + noise) % 256,
                       ((x + y) * 255 // 2110 + noise) % 256), axis=-1)
    return Image.fromarray(pixels.astype(np.uint8))


def install_trace(model, backend, directory, replay=None):
    """Observe real calls; stream arrays to disk instead of retaining a full tower."""
    import numpy as np
    directory.mkdir(parents=True, exist_ok=False)
    records, restores = [], []
    targets = [(model.patch_embed, 'patch')]
    for i, block in enumerate(model.blocks):
        targets.append((block, f'block_{i:02d}'))
        if i == 0:
            targets.extend((getattr(block, name), f'block_00_{name}')
                           for name in ('norm1', 'attn', 'norm2', 'mlp'))
    targets.append((model.merger, 'merged'))
    targets.extend((v, f'deepstack_{i}') for i, v in enumerate(model.deepstack_merger_list))

    def save(name, value):
        dtype = str(value.dtype)
        if backend == 'torch':
            array = value.detach().float().cpu().numpy()
        else:
            import mlx.core as mx
            array = np.array(value.astype(mx.float32))
        with (directory / f'{name}.npy').open('xb') as f:
            np.save(f, array)
        records.append({'name': name, 'dtype': dtype, 'shape': list(array.shape)})

    replay_names = {'block_00_' + name for name in ('norm1', 'attn', 'norm2', 'mlp')}
    def replay_input(name, value):
        array = np.load(replay / f'{name}_input.npy', allow_pickle=False)
        if list(array.shape) != list(value.shape) or not np.isfinite(array).all():
            raise ValueError('Replay input shape or finiteness mismatch')
        if backend == 'torch':
            import torch
            return torch.from_numpy(array).to(device=value.device, dtype=value.dtype)
        import mlx.core as mx
        return mx.array(array).astype(value.dtype)

    if backend == 'torch':
        for module, name in targets:
            def hook(_module, args, kwargs, output, name=name):
                if name == 'block_00' or name in replay_names:
                    save(name + '_input', args[0])
                save(name, output)
                if replay and name in replay_names:
                    save('replay_' + name, _module.forward(replay_input(name, args[0]), *args[1:], **kwargs))
            handle = module.register_forward_hook(hook, with_kwargs=True)
            restores.append(handle.remove)
    else:
        # Python resolves __call__ on the class. Filter by identity so other
        # instances of the same class (including nested modules) stay untouched.
        names = {id(module): name for module, name in targets}
        for cls in {type(module) for module, _ in targets}:
            original = cls.__call__
            def call(self, *args, _original=original, **kwargs):
                output = _original(self, *args, **kwargs)
                name = names.get(id(self))
                if name:
                    if name == 'block_00' or name in replay_names:
                        save(name + '_input', args[0])
                    save(name, output)
                    if replay and name in replay_names:
                        save('replay_' + name, _original(self, replay_input(name, args[0]), *args[1:], **kwargs))
                return output
            cls.__call__ = call
            restores.append(lambda cls=cls, original=original: setattr(cls, '__call__', original))

    def restore():
        for undo in reversed(restores):
            undo()
    return save, records, restore


def configure_mlx_ablation(model, position, attention, normalization):
    """Diagnostic-only operation controls; never installed by production."""
    import mlx.core as mx
    import mlx_vlm.models.qwen3_vl.vision as vision
    restores = []
    if normalization == 'float32':
        import mlx.nn as nn
        selected = {id(module) for module in model.modules() if isinstance(module, nn.LayerNorm)}
        original_call = nn.LayerNorm.__call__
        def norm_call(self, x):
            if id(self) not in selected:
                return original_call(self, x)
            return mx.fast.layer_norm(x.astype(mx.float32),
                                      self.weight.astype(mx.float32),
                                      self.bias.astype(mx.float32), self.eps).astype(x.dtype)
        nn.LayerNorm.__call__ = norm_call
        restores.append(lambda: setattr(nn.LayerNorm, '__call__', original_call))
    if position == 'float32':
        original = model.fast_pos_embed_interpolate
        def interpolate(grid):
            weight = model.pos_embed.weight
            try:
                model.pos_embed.weight = weight.astype(mx.float32)
                result = original(grid).astype(weight.dtype)
                mx.eval(result)
                return result
            finally:
                model.pos_embed.weight = weight
        model.fast_pos_embed_interpolate = interpolate
        restores.append(lambda: setattr(model, 'fast_pos_embed_interpolate', original))
    if attention == 'eager':
        def eager(q, k, v, scale):
            scores = (q @ k.swapaxes(-1, -2)) * scale
            probabilities = mx.softmax(scores.astype(mx.float32), axis=-1).astype(q.dtype)
            return probabilities @ v
        original_sdpa = vision.ensure_fused_sdpa
        vision.ensure_fused_sdpa = eager
        restores.append(lambda: setattr(vision, 'ensure_fused_sdpa', original_sdpa))

    def restore():
        for undo in reversed(restores):
            undo()
    return restore


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('backend', choices=['torch', 'mlx'])
    p.add_argument('--device', choices=['cpu', 'gpu'], default='cpu')
    p.add_argument('--dtype', choices=['float32', 'bfloat16'], default='float32')
    p.add_argument('--checkpoint-dir', type=Path, required=True, help='cached FL2VA directory')
    p.add_argument('--source', type=Path, help='synthetic source.ppm from diagnose_minimax_h3.py')
    p.add_argument('--fixture', choices=['source', 'gradient-noise'], default='source')
    p.add_argument('--trace-dir', type=Path, help='new directory for intermediate .npy arrays and manifest')
    p.add_argument('--replay-dir', type=Path, help='reference trace: also probe first-block operations with identical reference inputs')
    p.add_argument('--position', choices=['native', 'float32'], default='native', help='MLX diagnostic ablation only')
    p.add_argument('--normalization', choices=['native', 'float32'], default='native', help='MLX diagnostic ablation only')
    p.add_argument('--attention', choices=['native', 'eager'], default='native', help='MLX diagnostic ablation only')
    p.add_argument('--output', type=Path, required=True, help='new .npz output file')
    a = p.parse_args()
    if a.fixture == 'gradient-noise' and a.source is not None:
        p.error('--source cannot be combined with --fixture gradient-noise')
    if a.fixture == 'source' and a.source is None:
        p.error('--source is required for the source fixture')
    if a.backend != 'mlx' and (a.position != 'native' or a.attention != 'native' or a.normalization != 'native'):
        p.error('operation ablations are MLX-only')
    if a.replay_dir and not a.trace_dir:
        p.error('--replay-dir requires --trace-dir')
    if a.trace_dir and a.trace_dir.exists():
        p.error('--trace-dir must be new')
    if a.output.suffix != '.npz':
        p.error('--output must end in .npz')
    if a.output.exists():
        raise SystemExit('Output already exists; choose a new path')
    os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '0'
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import numpy as np
    from PIL import Image
    from safetensors import safe_open
    root = a.checkpoint_dir
    raw = json.loads((root / 'text_encoder/config.json').read_text())['vision_config']
    index = json.loads((root / 'text_encoder/model.safetensors.index.json').read_text())['weight_map']
    keys = {k: v for k, v in index.items() if k.startswith('model.visual.')}
    from transformers import Qwen2VLImageProcessorPil
    processor = Qwen2VLImageProcessorPil.from_pretrained(str(root / 'processor'))
    source = gradient_noise_source() if a.fixture == 'gradient-noise' else Image.open(a.source).convert('RGB')
    source = source.resize((576, 1024), Image.Resampling.LANCZOS)
    inputs = processor(images=[source], return_tensors='np')
    pixel_sha256 = hashlib.sha256(inputs['pixel_values'].tobytes()).hexdigest()
    config_sha256 = hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()
    if a.replay_dir:
        reference = json.loads((a.replay_dir / 'manifest.json').read_text())
        if (reference['pixel_sha256'] != pixel_sha256 or reference['dtype'] != a.dtype
                or reference['vision_config_sha256'] != config_sha256
                or reference['grid_thw'] != inputs['image_grid_thw'].tolist()):
            raise ValueError('Replay requires identical processed pixels, grid, configuration and dtype')
    started = time.perf_counter()
    records = []
    if a.backend == 'torch':
        import torch
        from transformers.models.qwen3_vl.configuration_qwen3_vl import Qwen3VLVisionConfig
        from transformers.models.qwen3_vl.modeling_qwen3_vl import Qwen3VLVisionModel
        torch.set_num_threads(6)
        cfg = Qwen3VLVisionConfig(**raw)
        cfg._attn_implementation = 'eager'
        with torch.device('meta'):
            model = Qwen3VLVisionModel(cfg)
        weights = {}
        for shard in sorted(set(keys.values())):
            with safe_open(root / 'text_encoder' / shard, framework='pt', device='cpu') as f:
                for k, v in keys.items():
                    if v == shard:
                        weights[k.removeprefix('model.visual.')] = f.get_tensor(k).to(getattr(torch, a.dtype))
        model.load_state_dict(weights, strict=True, assign=True)
        model.eval()
        from transformers.models.qwen3_vl.modeling_qwen3_vl import Qwen3VLVisionRotaryEmbedding
        # Meta construction leaves this nonpersistent buffer unmaterialized.
        model.rotary_pos_emb = Qwen3VLVisionRotaryEmbedding(cfg.hidden_size // cfg.num_heads // 2)
        device = 'mps' if a.device == 'gpu' else 'cpu'
        model.to(device)
        save, records, restore = install_trace(model, 'torch', a.trace_dir, a.replay_dir) if a.trace_dir else (None, [], lambda: None)
        try:
            with torch.inference_mode():
                if save:
                    from transformers.vision_utils import get_vision_bilinear_indices_and_weights
                    indices, weights = get_vision_bilinear_indices_and_weights(
                        torch.from_numpy(inputs['image_grid_thw']).to(device),
                        num_grid_per_side=model.num_grid_per_side,
                        spatial_merge_size=model.config.spatial_merge_size)
                    save('position', (model.pos_embed(indices) * weights[:, :, None]).sum(0).to(getattr(torch, a.dtype)))
                out = model(torch.from_numpy(inputs['pixel_values']).to(device=device, dtype=getattr(torch, a.dtype)), grid_thw=torch.from_numpy(inputs['image_grid_thw']).to(device))
        finally:
            restore()
        arrays = [out.pooler_output] + list(out.deepstack_features)
        arrays = [v.float().cpu().numpy() for v in arrays]
    else:
        import mlx.core as mx
        mx.set_default_device(mx.gpu if a.device == 'gpu' else mx.cpu)
        from mlx.utils import tree_flatten, tree_unflatten
        from mlx_vlm.models.qwen3_vl.config import VisionConfig
        from mlx_vlm.models.qwen3_vl.vision import VisionModel
        from generate_minimax_h3 import sanitize_vision_weights
        model = VisionModel(VisionConfig.from_dict(raw))
        weights = {}
        for shard in sorted(set(keys.values())):
            with safe_open(root / 'text_encoder' / shard, framework='pt', device='cpu') as f:
                for k, v in keys.items():
                    if v == shard:
                        weights[k.removeprefix('model.visual.')] = mx.array(f.get_tensor(k).float().numpy()).astype(getattr(mx, a.dtype))
        expected = {key for key, _ in tree_flatten(model.parameters())}
        if expected != set(weights):
            raise ValueError('Vision checkpoint keys do not match the MLX model')
        model.update(tree_unflatten(list(weights.items())))
        sanitize_vision_weights(model)
        restore_ablation = configure_mlx_ablation(model, a.position, a.attention, a.normalization)
        save, records, restore = install_trace(model, 'mlx', a.trace_dir, a.replay_dir) if a.trace_dir else (None, [], lambda: None)
        try:
            if save:
                save('position', model.fast_pos_embed_interpolate(mx.array(inputs['image_grid_thw'].astype(np.int32))))
            hidden, deep = model(mx.array(inputs['pixel_values']).astype(getattr(mx, a.dtype)), mx.array(inputs['image_grid_thw'].astype(np.int32)), output_hidden_states=True)
            mx.eval(hidden, deep)
        finally:
            restore()
            restore_ablation()
        arrays = [np.array(v.astype(mx.float32)) for v in [hidden] + list(deep)]
    with a.output.open('xb') as output:
        np.savez(output, **{str(i): v for i, v in enumerate(arrays)})
    if a.trace_dir:
        import importlib.metadata
        metadata = {
            'backend': a.backend, 'device': a.device, 'dtype': a.dtype,
            'fixture': a.fixture, 'position': a.position, 'attention': a.attention,
            'normalization': a.normalization,
            'mlx_enable_tf32': os.environ.get('MLX_ENABLE_TF32', 'default'),
            'pixel_sha256': pixel_sha256,
            'replay': bool(a.replay_dir),
            'grid_thw': inputs['image_grid_thw'].tolist(), 'stages': records,
            'vision_config_sha256': config_sha256,
            'versions': {name: importlib.metadata.version(name) for name in
                         ('torch', 'torchvision', 'mlx', 'mlx-metal', 'mlx-vlm', 'transformers')},
        }
        (a.trace_dir / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps({'backend': a.backend, 'dtype': a.dtype, 'device': a.device, 'seconds': time.perf_counter() - started, 'shapes': [list(v.shape) for v in arrays]}))
if __name__ == '__main__':
    main()
