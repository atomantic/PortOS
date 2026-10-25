import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'minimax_h3_lora.py');
const loraProbe = join(here, 'minimax_h3_lora_probe.py');
const runtimeDir = join(homedir(), '.portos', 'minimax-h3-mlx');
const hasPinnedRuntime = existsSync(join(runtimeDir, 'minimax_h3_mlx', 'pipeline.py'));
// resolveTestPython() may return a bare PATH name ("python3") it has already
// proven runnable, so only the runtime venv path is gated on existsSync —
// filtering both would silently skip this suite on every machine without the
// pinned H3 runtime.
const candidates = [
  join(homedir(), '.portos', 'minimax-h3-mlx', '.venv', 'bin', 'python3'),
].filter((candidate) => existsSync(candidate))
  .concat(resolveTestPython() || [])
  .filter((candidate, index, all) => all.indexOf(candidate) === index);
const pyBin = candidates.find((candidate) => {
  try {
    execFileSync(candidate, ['-c', 'import mlx.core'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}) || null;

const runPython = (lines) => execFileSync(pyBin, ['-c', [
  'import sys',
  'from pathlib import Path',
  'sys.path.insert(0, str(Path(sys.argv[1]).parent))',
  ...lines,
].join('\n'), script], { encoding: 'utf8' });

describe.skipIf(!pyBin)('minimax_h3_lora.py', () => {
  it.skipIf(!hasPinnedRuntime)('capability-probes the installed quantized H3 runtime', () => {
    expect(execFileSync(pyBin, [loraProbe, runtimeDir], { encoding: 'utf8' })).toBe('');
  });

  it('adds an activation-space delta after a packed uint32 projection', () => {
    const output = runPython([
      'import mlx.core as mx, mlx.nn as nn, tempfile',
      'from minimax_h3_lora import LoRALinear, apply_loras',
      'class Attention(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.heads = 2; self.head_dim = 4; self.qkv_proj = nn.Linear(32, 24, bias=False)',
      'class Block(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.attn = Attention()',
      'class DiT(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.blocks = [Block()]',
      'model = DiT()',
      'nn.quantize(model, group_size=32, bits=8, class_predicate=lambda path, module: path.endswith("qkv_proj"))',
      'x = mx.arange(32, dtype=mx.float32).reshape(1, 1, 32) / 32',
      'before = model.blocks[0].attn.qkv_proj(x); mx.eval(before)',
      'with tempfile.TemporaryDirectory() as temp:',
      '    path = Path(temp) / "adapter.safetensors"',
      '    down = mx.arange(32, dtype=mx.float32).reshape(1, 32) / 32',
      '    up = mx.arange(24, dtype=mx.float32).reshape(24, 1) / 24',
      '    mx.save_safetensors(str(path), {"blocks.0.attn.qkv_proj.lora_a.weight": down, "blocks.0.attn.qkv_proj.lora_b.weight": up, "blocks.0.attn.qkv_proj.alpha": mx.array([1.0])}, metadata={"portos.qkv_layout": "native"})',
      '    apply_loras(model, [{"path": str(path), "scale": 0.5}])',
      '    after = model.blocks[0].attn.qkv_proj(x)',
      '    expected = before + ((x @ down.T) @ up.T) * 0.5',
      '    mx.eval(after, expected)',
      '    error = float(mx.max(mx.abs(after - expected)))',
      '    if error >= 1e-5: raise AssertionError(f"delta mismatch: {error}")',
      '    if not isinstance(model.blocks[0].attn.qkv_proj, LoRALinear): raise AssertionError("projection was not wrapped")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  it('normalizes H3 prefixes and converts reference-layout QKV rows', () => {
    const output = runPython([
      'import mlx.core as mx, mlx.nn as nn, tempfile',
      'from minimax_h3_lora import apply_loras',
      'class Attention(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.heads = 2; self.head_dim = 4; self.qkv_proj = nn.Linear(32, 24, bias=False)',
      'class Block(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.attn = Attention()',
      'class DiT(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.blocks = [Block()]',
      'model = DiT()',
      'with tempfile.TemporaryDirectory() as temp:',
      '    path = Path(temp) / "wushu_spatial_physics_pruned.safetensors"',
      '    down = mx.zeros((1, 32))',
      '    up = mx.arange(24, dtype=mx.float32).reshape(24, 1)',
      '    mx.save_safetensors(str(path), {"model.diffusion_model.transformer_blocks.0.attention.to_qkv.lora_A.weight": down, "model.diffusion_model.transformer_blocks.0.attention.to_qkv.lora_B.weight": up})',
      '    apply_loras(model, [{"path": str(path), "scale": 1.0}])',
      '    attached = model.blocks[0].attn.qkv_proj.adapters[0].up',
      '    expected = up.reshape(3, 2, 4, 1).transpose(1, 0, 2, 3).reshape(24, 1)',
      '    mx.eval(attached, expected)',
      '    if not bool(mx.all(attached == expected)): raise AssertionError("QKV rows were not converted")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  it('maps Diffusers split-QKV and gated-MLP exports onto the MLX tree', () => {
    const output = runPython([
      'import mlx.core as mx, mlx.nn as nn, tempfile',
      'from minimax_h3_lora import apply_loras',
      'class Attention(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.heads = 2; self.head_dim = 4; self.qkv_proj = nn.Linear(32, 24, bias=False)',
      'class Mlp(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.fc1 = nn.Linear(32, 16, bias=False)',
      'class Block(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.attn = Attention(); self.mlp = Mlp()',
      'class DiT(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.blocks = [Block()]',
      'model = DiT()',
      'with tempfile.TemporaryDirectory() as temp:',
      '    path = Path(temp) / "lightx2v-turbo.safetensors"',
      '    down = mx.zeros((1, 32))',
      '    q = mx.arange(8, dtype=mx.float32).reshape(8, 1)',
      '    k = mx.ones((8, 1))',
      '    v = mx.ones((8, 1)) * 2',
      '    mlp_up = mx.arange(16, dtype=mx.float32).reshape(16, 1)',
      '    mx.save_safetensors(str(path), {',
      '        "transformer_blocks.0.attn.to_q.lora_A.default.weight": down,',
      '        "transformer_blocks.0.attn.to_q.lora_B.default.weight": q,',
      '        "transformer_blocks.0.attn.to_q.alpha": mx.array([2.0]),',
      '        "transformer_blocks.0.attn.to_k.lora_A.default.weight": down,',
      '        "transformer_blocks.0.attn.to_k.lora_B.default.weight": k,',
      '        "transformer_blocks.0.attn.to_v.lora_A.default.weight": down,',
      '        "transformer_blocks.0.attn.to_v.lora_B.default.weight": v,',
      '        "transformer_blocks.0.ff.net.0.proj.lora_A.default.weight": down,',
      '        "transformer_blocks.0.ff.net.0.proj.lora_B.default.weight": mlp_up,',
      '    })',
      '    apply_loras(model, [{"path": str(path), "scale": 1.0}])',
      '    qkv = model.blocks[0].attn.qkv_proj.adapters',
      '    expected_q = mx.stack([q.reshape(2, 4, 1), mx.zeros((2, 4, 1)), mx.zeros((2, 4, 1))], axis=2).transpose(0, 2, 1, 3).reshape(24, 1)',
      '    expected_fc1 = mx.concatenate([mlp_up[8:], mlp_up[:8]], axis=0)',
      '    mx.eval(*(adapter.up for adapter in qkv), expected_q, expected_fc1)',
      '    if len(qkv) != 3: raise AssertionError(f"expected 3 QKV adapters, got {len(qkv)}")',
      '    if not any(bool(mx.all(adapter.up == expected_q)) and adapter.scale == 2.0 for adapter in qkv): raise AssertionError("Q adapter was not expanded or alpha-scaled")',
      '    if not any(adapter.scale == 8.0 for adapter in qkv): raise AssertionError("Diffusers default alpha was not applied")',
      '    if not any(bool(mx.all(adapter.up == expected_fc1)) and adapter.scale == 8.0 for adapter in model.blocks[0].mlp.fc1.adapters): raise AssertionError("fc1 gate/value order or alpha was not applied")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  it('normalizes Diffusers attn1 and flattened kohya H3 targets', () => {
    const output = runPython([
      'from minimax_h3_lora import _normalize_target',
      'expected = ("blocks.0.attn.qkv_proj", "split_k")',
      'for target in ["transformer_blocks.0.attn1.to_k", "lora_unet_transformer_blocks_0_attn1_to_k"]:',
      '    if _normalize_target(target) != expected: raise AssertionError(f"target was not normalized: {target}")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  // A two-head toy DiT with a fused qkv_proj and an MLP, plus helpers that
  // build distinguishable Q/K/V rows and the native-order permutation.
  const layoutFixture = [
    'import mlx.core as mx, mlx.nn as nn, tempfile',
    'from minimax_h3_lora import LoRALinear, apply_loras',
    'class Attention(nn.Module):',
    '    def __init__(self):',
    '        super().__init__(); self.heads = 2; self.head_dim = 4; self.qkv_proj = nn.Linear(32, 24, bias=False)',
    'class Mlp(nn.Module):',
    '    def __init__(self):',
    '        super().__init__(); self.fc1 = nn.Linear(32, 16, bias=False)',
    'class Block(nn.Module):',
    '    def __init__(self):',
    '        super().__init__(); self.attn = Attention(); self.mlp = Mlp()',
    'class DiT(nn.Module):',
    '    def __init__(self):',
    '        super().__init__(); self.blocks = [Block()]',
    'def make_model():',
    '    mx.random.seed(0); model = DiT(); mx.eval(model.parameters()); return model',
    'def to_native(up):',
    '    return up.reshape(3, 2, 4, up.shape[1]).transpose(1, 0, 2, 3).reshape(24, up.shape[1])',
    // Contiguous rows: Q rows 0-7, K rows 100-107, V rows 200-207.
    'contiguous_up = mx.concatenate([mx.arange(8, dtype=mx.float32), mx.arange(8, dtype=mx.float32) + 100, mx.arange(8, dtype=mx.float32) + 200]).reshape(24, 1)',
    'down = mx.arange(32, dtype=mx.float32).reshape(1, 32) / 32',
    'x = mx.arange(32, dtype=mx.float32).reshape(1, 1, 32) / 32',
    'QKV = "blocks.0.attn.qkv_proj"',
    'def fused(up, alpha=None, prefix=QKV):',
    '    tensors = {f"{prefix}.lora_A.weight": down, f"{prefix}.lora_B.weight": up}',
    '    if alpha is not None: tensors[f"{prefix}.alpha"] = mx.array([alpha])',
    '    return tensors',
    'def save(temp, name, tensors, metadata=None):',
    '    path = Path(temp) / name',
    '    mx.save_safetensors(str(path), tensors, metadata=metadata or {})',
    '    return str(path)',
    'def same(left, right):',
    '    mx.eval(left, right); return float(mx.max(mx.abs(left - right))) < 1e-4',
  ];

  it('resolves fused QKV row order from adapter content, never its basename', () => {
    const output = runPython([
      ...layoutFixture,
      'with tempfile.TemporaryDirectory() as temp:',
      '    outputs = []',
      // Byte-identical unannotated adapters under neutral and misleading names.
      '    for name in ["character.safetensors", "native-character.safetensors", "interleaved.safetensors"]:',
      '        model = make_model()',
      '        apply_loras(model, [{"path": save(temp, name, fused(contiguous_up, 1.0)), "scale": 1.0}])',
      '        if not same(model.blocks[0].attn.qkv_proj.adapters[0].up, to_native(contiguous_up)): raise AssertionError(f"{name}: unannotated fused export was not converted from contiguous rows")',
      '        outputs.append(model.blocks[0].attn.qkv_proj(x))',
      '    if not all(same(outputs[0], other) for other in outputs[1:]): raise AssertionError("renaming identical bytes changed the adapted output")',
      // A native declaration wins regardless of a name that suggests otherwise.
      '    native_up = to_native(contiguous_up)',
      '    for key, value in [("portos.qkv_layout", "native"), ("qkv_layout", "per-head"), ("qkv_layout", "Interleaved")]:',
      '        model = make_model()',
      '        apply_loras(model, [{"path": save(temp, "contiguous-turbo.safetensors", fused(native_up, 1.0), {key: value}), "scale": 1.0}])',
      '        if not same(model.blocks[0].attn.qkv_proj.adapters[0].up, native_up): raise AssertionError(f"{key}={value} native declaration was not honored")',
      // An explicit contiguous declaration, including a consistent duplicate key.
      '    model = make_model()',
      '    apply_loras(model, [{"path": save(temp, "native.safetensors", fused(contiguous_up, 1.0), {"portos.qkv_layout": "contiguous", "qkv_layout": "fused"}), "scale": 1.0}])',
      '    if not same(model.blocks[0].attn.qkv_proj.adapters[0].up, native_up): raise AssertionError("contiguous declaration was not converted")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  it('applies each adapter in a mixed-layout stack exactly once with its own scaling', () => {
    const output = runPython([
      ...layoutFixture,
      'with tempfile.TemporaryDirectory() as temp:',
      '    model = make_model()',
      '    before = model.blocks[0].attn.qkv_proj(x); fc1_before = model.blocks[0].mlp.fc1(x); mx.eval(before, fc1_before)',
      '    native_up = to_native(contiguous_up) / 10',
      '    q_up = mx.arange(8, dtype=mx.float32).reshape(8, 1) + 1',
      '    fc1_up = mx.arange(16, dtype=mx.float32).reshape(16, 1)',
      '    stack = [',
      // Declared native, alpha 2 over rank 1, external 0.5 -> scale 1.0.
      '        {"path": save(temp, "a.safetensors", fused(native_up, 2.0), {"qkv_layout": "native"}), "scale": 0.5},',
      // Unannotated fused contiguous, no alpha -> alpha = rank, scale 0.25.
      '        {"path": save(temp, "b.safetensors", fused(contiguous_up)), "scale": 0.25},',
      // Split Q projection; a fused declaration does not apply to it.
      '        {"path": save(temp, "c.safetensors", {"transformer_blocks.0.attn.to_q.lora_A.weight": down, "transformer_blocks.0.attn.to_q.lora_B.weight": q_up, "transformer_blocks.0.attn.to_q.alpha": mx.array([1.0])}, {"qkv_layout": "native"}), "scale": 1.0},',
      // MLP-only adapter carrying a layout declaration stays row-for-row.
      '        {"path": save(temp, "d.safetensors", fused(fc1_up, 1.0, "blocks.0.mlp.fc1"), {"qkv_layout": "native"}), "scale": 1.0},',
      '    ]',
      '    apply_loras(model, stack)',
      '    adapters = model.blocks[0].attn.qkv_proj.adapters',
      '    if len(adapters) != 3: raise AssertionError(f"expected 3 QKV adapters, got {len(adapters)}")',
      '    expected_q = mx.stack([q_up.reshape(2, 4, 1), mx.zeros((2, 4, 1)), mx.zeros((2, 4, 1))], axis=2).transpose(0, 2, 1, 3).reshape(24, 1)',
      '    expected = [(native_up, 1.0), (to_native(contiguous_up), 0.25), (expected_q, 1.0)]',
      '    for adapter, (up, scale) in zip(adapters, expected):',
      '        if not same(adapter.up, up) or abs(adapter.scale - scale) > 1e-6: raise AssertionError(f"adapter mismatch: scale {adapter.scale} vs {scale}")',
      '    delta = sum(((x @ down.T) @ up.T) * scale for up, scale in expected)',
      '    if not same(model.blocks[0].attn.qkv_proj(x), before + delta): raise AssertionError("stacked QKV output was not the sum of each adapter once")',
      '    fc1 = model.blocks[0].mlp.fc1',
      '    if len(fc1.adapters) != 1 or not same(fc1.adapters[0].up, fc1_up): raise AssertionError("MLP-only adapter rows were changed by a layout declaration")',
      '    if not same(fc1(x), fc1_before + (x @ down.T) @ fc1_up.T): raise AssertionError("MLP adapter output mismatch")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  it('rejects malformed or contradictory layout metadata before replacing any module', () => {
    const output = runPython([
      ...layoutFixture,
      'to_qkv = {"transformer_blocks.0.attention.to_qkv.lora_A.weight": down, "transformer_blocks.0.attention.to_qkv.lora_B.weight": contiguous_up}',
      'cases = [',
      '    ("unsupported", fused(contiguous_up), {"qkv_layout": "sideways"}),',
      '    ("overlong", fused(contiguous_up), {"qkv_layout": "native" * 20}),',
      '    ("conflicting keys", fused(contiguous_up), {"portos.qkv_layout": "native", "qkv_layout": "contiguous"}),',
      '    ("key format vs metadata", to_qkv, {"qkv_layout": "native"}),',
      ']',
      'with tempfile.TemporaryDirectory() as temp:',
      '    good = save(temp, "good.safetensors", fused(contiguous_up, 1.0))',
      '    for label, tensors, metadata in cases:',
      '        model = make_model()',
      '        bad = save(temp, f"bad-{label}.safetensors", tensors, metadata)',
      '        try:',
      '            apply_loras(model, [{"path": good, "scale": 1.0}, {"path": bad, "scale": 1.0}])',
      '        except ValueError as error:',
      '            if "qkv_layout" not in str(error) and "QKV" not in str(error): raise AssertionError(f"{label}: unhelpful error {error}")',
      '        else:',
      '            raise AssertionError(f"{label}: metadata was accepted")',
      '        if isinstance(model.blocks[0].attn.qkv_proj, LoRALinear): raise AssertionError(f"{label}: a module was replaced before validation failed")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });
});
