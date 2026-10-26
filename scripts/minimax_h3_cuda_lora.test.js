import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'minimax_h3_cuda_lora.py');
const python = resolveTestPython();
const run = (code, bin = python) => execFileSync(bin, ['-c', `import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1]).parent))\nimport minimax_h3_cuda_lora as adapter\n${code}`, script], { encoding: 'utf8', timeout: 20000 }).trim();

describe.skipIf(!python)('H3 CUDA split adapter contract', () => {
  it('keeps split Q/K/V and SwiGLU rows in Diffusers order and applies recorded alpha/rank', () => {
    expect(run(`header = {'__metadata__': {'alpha':'8'}}
for target in ['attn.to_q','attn.to_k','attn.to_v','ff.net.0.proj']:
    prefix = 'transformer_blocks.0.' + target
    header[prefix+'.lora_A.default.weight'] = {'dtype':'BF16','shape':[128,5376]}
    header[prefix+'.lora_B.default.weight'] = {'dtype':'BF16','shape':[7168,128]}
plan = adapter.adapter_plan(header)
assert len(plan) == 4
assert [row[0].split('0.',1)[1] for row in plan] == ['attn.to_k','attn.to_q','attn.to_v','ff.net.0.proj']
assert all(row[3] == 0.0625 for row in plan)
print('original split rows; alpha/rank=0.0625')`)).toBe('original split rows; alpha/rank=0.0625');
  });

  it('refuses incomplete, fused, unknown-alpha and nonfinite adapters instead of partially applying them', () => {
    expect(run(`a = 'transformer_blocks.0.attn.to_q.lora_A.weight'
b = 'transformer_blocks.0.attn.to_q.lora_B.weight'
valid = {'__metadata__':{'alpha':'8'}, a:{'dtype':'BF16','shape':[2,4]}, b:{'dtype':'BF16','shape':[3,2]}}
bad = [dict(valid, **{'__metadata__':{}}), dict(valid, **{'__metadata__':{'alpha':'nan'}}),
       {a:valid[a]}, dict(valid, **{b:{'dtype':'BF16','shape':[3,1]}}),
       {'blocks.0.attn.qkv_proj.lora_A.weight':{'dtype':'BF16','shape':[2,4]}}, {}]
for header in bad:
    try: adapter.adapter_plan(header)
    except ValueError: pass
    else: raise AssertionError('invalid adapter accepted')
try: adapter.adapter_plan(valid, float('inf'))
except ValueError: pass
else: raise AssertionError('nonfinite strength accepted')
print('all invalid layouts refused')`)).toBe('all invalid layouts refused');
  });
});

// Optional tensor interpreter: the ordinary suite stays stdlib-only. Set this
// to an existing torch+safetensors venv for the numerical quantized-base check.
const tensorPython = process.env.PORTOS_H3_TEST_PYTHON;
it.skipIf(!tensorPython)('adds speed + style exactly once without changing quantized weights or output-row order', () => {
  expect(run(`import tempfile, torch
from safetensors.torch import save_file
root = torch.nn.Module()
root.transformer_blocks = torch.nn.ModuleList([torch.nn.Module()])
block = root.transformer_blocks[0]
block.attn = torch.nn.Module()
linear = torch.ao.nn.quantized.dynamic.Linear(4,3,bias_=False)
weight = torch.quantize_per_tensor(torch.arange(12,dtype=torch.float32).reshape(3,4)/12, 0.01, 0, torch.qint8)
linear.set_weight_bias(weight,None)
block.attn.to_q = linear
value = torch.tensor([[1.,2.,3.,4.]])
base = linear(value)
original = linear.weight().int_repr().clone()
a = torch.ones(2,4)
b = torch.tensor([[1.,0.],[2.,0.],[3.,0.]])
prefix = 'transformer_blocks.0.attn.to_q'
with tempfile.TemporaryDirectory() as tmp:
    speed, style = Path(tmp)/'speed.safetensors', Path(tmp)/'style.safetensors'
    save_file({prefix+'.lora_A.weight':a,prefix+'.lora_B.weight':b},str(speed),metadata={'alpha':'8'})
    save_file({prefix+'.lora_A.weight':a*2,prefix+'.lora_B.weight':b},str(style),metadata={'alpha':'2'})
    original_digest = adapter.file_digest
    adapter.file_digest = lambda path: adapter.CONTRACT['adapter']['sha256'] if path == speed else original_digest(path)
    reports = adapter.apply_adapters(root,[(speed,1.),(style,0.5)],speed_profile=True)
    expected = base + torch.tensor([[40.,80.,120.]]) + torch.tensor([[10.,20.,30.]])
    torch.testing.assert_close(linear(value),expected)
    assert torch.equal(linear.weight().int_repr(),original)
    assert len(reports) == 2 and linear._portos_lora_count == 2
    try: adapter.apply_adapters(root,[(speed,1.),(speed,1.)],speed_profile=True)
    except ValueError as exc: assert 'more than once' in str(exc)
    else: raise AssertionError('duplicate speed adapter accepted')
    adapter.file_digest = lambda path: adapter.CONTRACT['adapter']['sha256']
    try: adapter.apply_adapters(root,[(speed,1.)])
    except ValueError as exc: assert 'named speed profile' in str(exc)
    else: raise AssertionError('speed adapter accepted with stock sampler')
    assert linear._portos_lora_count == 2
print('quantized base preserved; each adapter applied once')`, tensorPython)).toBe('quantized base preserved; each adapter applied once');
});
