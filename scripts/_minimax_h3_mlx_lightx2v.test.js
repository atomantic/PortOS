import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const runtime = join(homedir(), '.portos', 'minimax-h3-mlx');
const nativePython = join(runtime, '.venv/bin/python3');
const run = (source, executable = python) => execFileSync(executable, ['-c', [
  'import sys, json, tempfile',
  'from pathlib import Path',
  'sys.path.insert(0, str(Path.cwd() / "scripts"))',
  ...source,
].join('\n')], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });

describe.skipIf(!python)('MLX LightX2V helper boundary', () => {
  it('accepts the actual runner profile and user adapter CLI without changing stock defaults', () => {
    const output = run([
      'import generate_minimax_h3 as runner',
      'base=["helper", "--runtime-dir","runtime","--runtime-revision","pin","--checkpoint-repo","checkpoint","--checkpoint-revision","revision","--model-repo","model","--model-revision","revision","--prompt","Synthetic test","--width","1344","--height","768","--num-frames","107","--output","private.mp4"]',
      'sys.argv=base; stock=runner.parse_args(); assert stock.steps==9 and stock.speed_profile is None',
      'sys.argv=base+["--speed-profile","lightx2v-mlx-v1.3-4step","--speed-adapter","cached.safetensors","--steps","5","--lora","style.safetensors","--lora-scale","0.5"]',
      'profile=runner.parse_args(); assert profile.steps==5 and profile.speed_adapter=="cached.safetensors"',
      'assert profile.lora==["style.safetensors"] and profile.lora_scale==[0.5]',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });
  it('keeps stock calls inert and refuses an unpaired adapter or unsupported pin', () => {
    const output = run([
      'from types import SimpleNamespace',
      'from _minimax_h3_mlx_lightx2v import validate_profile_args, verify_runtime_source',
      'validate_profile_args(SimpleNamespace())',
      'for action in [lambda: validate_profile_args(SimpleNamespace(speed_adapter="x")), lambda: verify_runtime_source("missing", "stale")]:',
      '    try: action()',
      '    except ValueError: pass',
      '    else: raise AssertionError("unsupported contract accepted")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  it('validates helper arguments and refuses duplicate adapter content before loading', () => {
    const output = run([
      'from types import SimpleNamespace',
      'import _minimax_h3_mlx_lightx2v as helper',
      'spec=helper.CONTRACT',
      'helper.verify_runtime_source=lambda *_: None',
      'helper.file_digest=lambda _: spec["adapter"]["sha256"]',
      'args=SimpleNamespace(speed_profile=spec["id"], speed_adapter="cached", model_repo=spec["model"]["repo"], model_revision=spec["model"]["revision"], steps=5, width=1344, height=768, image=[], anchor=[], runtime_dir="runtime", runtime_revision=spec["runtimeRevision"], checkpoint_repo=spec["checkpoint"]["repo"], checkpoint_revision=spec["checkpoint"]["revision"], checkpoint_file=spec["checkpoint"]["files"], lora=[])',
      'helper.validate_profile_args(args)',
      'for key, value in [("steps",4),("width",768),("source_video","prior.mp4"),("checkpoint_revision","custom"),("checkpoint_file",[]),("lora",["duplicate"])]:',
      '    original=getattr(args,key,None); setattr(args,key,value)',
      '    try: helper.validate_profile_args(args)',
      '    except ValueError: pass',
      '    else: raise AssertionError(key+" accepted")',
      '    setattr(args,key,original)',
      'args.image=["image"]; args.anchor=["first"]; helper.validate_profile_args(args)',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });
});

describe.skipIf(!existsSync(nativePython))('MLX native LightX2V numeric contract', () => {
  it('uses four data-ward updates and independent video/audio shifts with the pinned scheduler', () => {
    const output = run([
      'import mlx.core as mx, importlib.util',
      'from types import SimpleNamespace',
      'from _minimax_h3_mlx_lightx2v import configure_pipeline, verify_runtime_source, CONTRACT',
      `runtime=Path(${JSON.stringify(runtime)})`,
      'verify_runtime_source(runtime, CONTRACT["runtimeRevision"])',
      'spec=importlib.util.spec_from_file_location("h3_schedule", runtime/"minimax_h3_mlx/scheduler.py")',
      'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
      'class Pipe:',
      '    config=SimpleNamespace(sigma_shift_video=12, sigma_shift_audio=3)',
      '    def _build_schedules(self, points):',
      '        pair=[module.MiniMaxH3Scheduler(s) for s in (self.config.sigma_shift_video,self.config.sigma_shift_audio)]',
      '        for scheduler in pair: scheduler.set_timesteps(points)',
      '        return pair',
      'pipe=Pipe(); grids=configure_pipeline(pipe)',
      'for shift, key in [(6,"videoSigmas"),(3,"audioSigmas")]:',
      '    expected=[shift*s/(1+(shift-1)*s) for s in CONTRACT["sigmaPoints"]]',
      '    assert max(abs(a-b) for a,b in zip(grids[key],expected))<1e-6',
      'video,audio=pipe._build_schedules(5)',
      'state=mx.array([0.0]); velocity=mx.array([1.0])',
      'for timestep in video.timesteps.tolist(): state=video.step(velocity,timestep,state)',
      'assert abs(state.item()-1.0)<1e-6, state',
      'assert video.step_index==4 and len(audio.timesteps)==4',
      'print("ok")',
    ], nativePython);
    expect(output.trim()).toBe('ok');
  });

  it('stacks speed and style residuals exactly once with metadata alpha over rank and packed base unchanged', () => {
    const output = run([
      'import mlx.core as mx, mlx.nn as nn',
      'from minimax_h3_lora import apply_loras',
      'class Attention(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.heads=2; self.head_dim=4; self.qkv_proj=nn.Linear(32,24,bias=False)',
      'class Block(nn.Module):',
      '    def __init__(self): super().__init__(); self.attn=Attention()',
      'class DiT(nn.Module):',
      '    def __init__(self): super().__init__(); self.blocks=[Block()]',
      'model=DiT(); nn.quantize(model,group_size=32,bits=8)',
      'base=model.blocks[0].attn.qkv_proj; packed=base.weight; scales=base.scales',
      'x=mx.ones((1,32)); before=base(x); mx.eval(before)',
      'with tempfile.TemporaryDirectory() as temp:',
      '    adapters=[]',
      '    for label,rank,alpha,strength in [("speed",128,8,1),("style",2,16,0.5)]:',
      '        path=Path(temp)/(label+".safetensors")',
      '        mx.save_safetensors(str(path),{"transformer_blocks.0.attn.to_q.lora_A.weight":mx.ones((rank,32)),"transformer_blocks.0.attn.to_q.lora_B.weight":mx.ones((8,rank))},metadata={"alpha":str(alpha)})',
      '        adapters.append({"path":path,"scale":strength})',
      '    apply_loras(model,adapters)',
      '    wrapped=model.blocks[0].attn.qkv_proj; after=wrapped(x); mx.eval(after)',
      '    expected=mx.array([512.0]*4+[0.0]*8+[512.0]*4+[0.0]*8).reshape(1,24)',
      '    assert bool(mx.allclose(after-before,expected,atol=0.001)), (after-before)',
      '    assert wrapped.base is base and base.weight is packed and base.scales is scales',
      '    assert len(wrapped.adapters)==2',
      'print("ok")',
    ], nativePython);
    expect(output.trim()).toBe('ok');
  });
});
