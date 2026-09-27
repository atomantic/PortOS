#!/usr/bin/env python3
"""Inspect H3 vision precision with cached weights and a synthetic input (#8867).

Run each backend/device in a separate process with torch, mlx, mlx-vlm and
transformers installed at the versions in docs/research/minimax-h3-continuity.md.
No model downloads or full language-model loads. GPU runs require an idle GPU.
Outputs are observations, not a pass/fail equivalence test; compare the four
arrays with max(abs(reference-actual)) and norm(reference-actual)/norm(reference).
"""
import argparse
import json
import os
import time
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('backend', choices=['torch', 'mlx'])
    p.add_argument('--device', choices=['cpu', 'gpu'], default='cpu')
    p.add_argument('--dtype', choices=['float32', 'bfloat16'], default='float32')
    p.add_argument('--checkpoint-dir', type=Path, required=True, help='cached FL2VA directory')
    p.add_argument('--source', type=Path, required=True, help='synthetic source.ppm from diagnose_minimax_h3.py')
    p.add_argument('--output', type=Path, required=True, help='new .npz output file')
    a = p.parse_args()
    if a.output.suffix != '.npz':
        p.error('--output must end in .npz')
    if a.output.exists():
        raise SystemExit('Output already exists; choose a new path')
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
    source = Image.open(a.source).convert('RGB').resize((576, 1024), Image.Resampling.LANCZOS)
    inputs = processor(images=[source], return_tensors='np')
    started = time.perf_counter()
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
        with torch.inference_mode():
            out = model(torch.from_numpy(inputs['pixel_values']).to(device=device, dtype=getattr(torch, a.dtype)), grid_thw=torch.from_numpy(inputs['image_grid_thw']).to(device))
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
        hidden, deep = model(mx.array(inputs['pixel_values']).astype(getattr(mx, a.dtype)), mx.array(inputs['image_grid_thw'].astype(np.int32)), output_hidden_states=True)
        mx.eval(hidden, deep)
        arrays = [np.array(v.astype(mx.float32)) for v in [hidden] + list(deep)]
    with a.output.open('xb') as output:
        np.savez(output, **{str(i): v for i, v in enumerate(arrays)})
    print(json.dumps({'backend': a.backend, 'dtype': a.dtype, 'device': a.device, 'seconds': time.perf_counter() - started, 'shapes': [list(v.shape) for v in arrays]}))
if __name__ == '__main__':
    main()
