import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const run = (lines) => execFileSync(python, ['-c', [
  'import sys, json, tempfile', 'from pathlib import Path',
  'sys.path.insert(0, str(Path.cwd() / "scripts"))', ...lines,
].join('\n')], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
const hasMlx = (() => {
  if (!python) return false;
  try { execFileSync(python, ['-c', 'import mlx.core, numpy'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!python)('Pika Flex helper admission', () => {
  it('parses the runner request and validates pins, schedule, conditioning, adapter and supporting files before model loading', () => {
    expect(run([
      'from types import SimpleNamespace',
      'import generate_minimax_h3 as runner, _minimax_h3_mlx_flex as flex',
      'c=flex.CONTRACT',
      'sys.argv=["helper","--runtime-dir","runtime","--runtime-revision",c["runtimeRevision"],"--checkpoint-repo",c["checkpoint"]["repo"],"--checkpoint-revision",c["checkpoint"]["revision"],"--model-repo",c["model"]["repo"],"--model-revision",c["model"]["revision"],"--prompt","Synthetic pond","--width","640","--height","384","--num-frames","124","--steps","7","--speed-profile",c["id"],"--speed-adapter","cache/fl2va/adapter.safetensors","--output","example.mp4"]',
      'args=runner.parse_args(); args.checkpoint_file=c["checkpoint"]["files"]',
      'assert runner.speed_helper(args) is flex',
      'try: flex.validate_profile_args(args)',
      'except ValueError: pass',
      'else: raise AssertionError("missing pinned source accepted")',
      'flex.shared.verify_runtime_source=lambda *_: None',
      'digests={"adapter.safetensors":c["adapter"]["sha256"], **{Path(k).name:v for k,v in c["adapter"]["supportFiles"].items()}}',
      'flex.shared.file_digest=lambda p: digests.get(Path(p).name,"bad")',
      'flex.validate_profile_args(args)',
      'for key,value in [("steps",6),("width",960),("source_video","prior.mp4"),("model_revision","custom"),("checkpoint_file",[]),("lora",["cache/fl2va/adapter.safetensors"])]:',
      '    original=getattr(args,key,None); setattr(args,key,value)',
      '    try: flex.validate_profile_args(args)',
      '    except ValueError: pass',
      '    else: raise AssertionError(key+" accepted")',
      '    setattr(args,key,original)',
      'digests["NOTICE"]="bad"',
      'try: flex.validate_profile_args(args)',
      'except ValueError: pass',
      'else: raise AssertionError("bad notice accepted")',
      'print("ok")',
    ]).trim()).toBe('ok');
  });
});

describe.skipIf(!hasMlx)('Pika Flex native MLX numeric contract', () => {
  it('runs six re-noise updates on independently shifted knots with fresh noise and no terminal noise draw', () => {
    expect(run([
      'import mlx.core as mx, numpy as np',
      'from types import SimpleNamespace, MethodType',
      'from _minimax_h3_mlx_flex import build_schedule, CONTRACT',
      '# Minimal scheduler interface; the production probe independently pins the upstream implementation bytes.',
      'def scheduler_type(shift):',
      '    scheduler=SimpleNamespace(_step_index=None)',
      '    def set_timesteps(sigmas):',
      '        scheduler.sigmas=mx.array(sigmas); scheduler.timesteps=mx.array([1-s for s in sigmas[:-1]])',
      '    scheduler.set_timesteps=set_timesteps',
      '    scheduler.index_for_timestep=lambda t: scheduler.timesteps.tolist().index(t)',
      '    return scheduler',
      'for shift in (12,3):',
      '    scheduler=build_schedule(scheduler_type,shift)',
      '    knots=np.array([1,.75,.5,.25,.1,.04,0],dtype=np.float32)',
      '    expected_sigmas=shift*knots/(1+(shift-1)*knots)',
      '    assert np.allclose(scheduler.sigmas.tolist(),expected_sigmas,rtol=1e-6)',
      '    assert len(scheduler.timesteps)==6',
      '    mx.random.seed(19); noises=[mx.random.normal((4,)) for _ in range(5)]; mx.eval(*noises)',
      '    mx.random.seed(19); state=mx.zeros((4,)); expected=mx.zeros((4,))',
      '    for i,t in enumerate(scheduler.timesteps.tolist()):',
      '        predicted=expected+float(np.float32(1)-np.float32(t))*mx.ones((4,))',
      '        following=float(expected_sigmas[i+1])',
      '        expected=predicted if i==5 else (1-following)*predicted+following*noises[i]',
      '        state=scheduler.step(mx.ones((4,)),t,state); mx.eval(state,expected)',
      '        assert bool(mx.allclose(state,expected,atol=1e-6)), (i,state,expected)',
      '    assert scheduler._step_index==6',
      'print("ok")',
    ]).trim()).toBe('ok');
  });

  it('applies original F32 Pika tensors at manifest alpha=rank in BF16 while retaining quantized base and style scale', () => {
    expect(run([
      'import mlx.core as mx, mlx.nn as nn',
      'from minimax_h3_lora import apply_loras',
      'from _minimax_h3_mlx_flex import adapter_spec',
      'class Attention(nn.Module):',
      '    def __init__(self): super().__init__(); self.heads=2; self.head_dim=4; self.qkv_proj=nn.Linear(32,24,bias=False)',
      'class Block(nn.Module):',
      '    def __init__(self): super().__init__(); self.attn=Attention()',
      'class DiT(nn.Module):',
      '    def __init__(self): super().__init__(); self.blocks=[Block()]',
      'model=DiT(); nn.quantize(model,group_size=32,bits=8)',
      'base=model.blocks[0].attn.qkv_proj; packed=base.weight; x=mx.ones((1,32)); before=base(x); mx.eval(before)',
      'with tempfile.TemporaryDirectory() as temp:',
      '    path=Path(temp)/"pika.safetensors"; style=Path(temp)/"style.safetensors"',
      '    mx.save_safetensors(str(path),{"transformer_blocks.0.attn.to_q.lora_A.default.weight":mx.ones((128,32)),"transformer_blocks.0.attn.to_q.lora_B.default.weight":mx.ones((8,128))})',
      '    mx.save_safetensors(str(style),{"transformer_blocks.0.attn.to_q.lora_A.weight":mx.ones((2,32)),"transformer_blocks.0.attn.to_q.lora_B.weight":mx.ones((8,2))},metadata={"alpha":"2"})',
      '    apply_loras(model,[adapter_spec(path),{"path":style,"scale":.5}])',
      '    wrapped=model.blocks[0].attn.qkv_proj; delta=wrapped(x)-before; mx.eval(delta)',
      '    expected=mx.array([4128.0]*4+[0.0]*8+[4128.0]*4+[0.0]*8).reshape(1,24)',
      '    assert bool(mx.allclose(delta,expected,atol=.01)), delta',
      '    assert wrapped.base is base and base.weight is packed',
      '    assert wrapped.adapters[0].down.dtype==mx.bfloat16 and wrapped.adapters[0].scale==1',
      '    assert wrapped.adapters[1].scale==.5',
      'print("ok")',
    ]).trim()).toBe('ok');
  });
});
