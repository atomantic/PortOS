import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_wan22_cuda.py');

// Probe for an interpreter that actually RUNS rather than assuming a name. On
// Windows a box with no Store-installed Python still has `python` on PATH as an
// alias STUB: it exists, exits non-zero, and prints "Python was not found", so a
// name-only choice passes here and then every case dies with an opaque "Command
// failed". Null when there is genuinely none, so the suite skips.
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8',
  timeout: 10_000,
});

// Import the runner as a module without executing main(). Every heavy import
// (torch, diffusers) is deferred inside main(), which is what makes this
// possible in a bare interpreter — no CUDA runtime is installed here.
const importRunner = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("generate_wan22_cuda", script)',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');

describe.skipIf(!pyBin)('generate_wan22_cuda.py', () => {
  // The guard itself is `_checkpoint_index_guard.py`, exercised through
  // generate_minimax_h3_cuda.test.js. What is only true here is that this
  // runner calls it at all — diffusers hands the snapshot straight to
  // accelerate, which has no fixed release for GHSA-4j2p-28q2-5m79, so a
  // missing call is a silent arbitrary-file-read.
  it('screens the snapshot index before diffusers can load it', () => {
    const output = runPython(`${importRunner}\n${[
      'import argparse, json, tempfile, types',
      'with tempfile.TemporaryDirectory() as temp:',
      '    snapshot = Path(temp) / "snapshot"',
      '    snapshot.mkdir()',
      '    (Path(temp) / "outside.safetensors").write_text("not a checkpoint")',
      '    (snapshot / "model.safetensors.index.json").write_text(',
      '        json.dumps({"weight_map": {"layer.weight": "../outside.safetensors"}}))',
      '    sys.modules["huggingface_hub"] = types.SimpleNamespace(',
      '        snapshot_download=lambda **kw: str(snapshot))',
      '    def unreachable(*a, **kw):',
      '        raise AssertionError("diffusers reached with an unsafe checkpoint index")',
      '    sys.modules["torch"] = types.SimpleNamespace(cuda=types.SimpleNamespace(',
      '        is_available=unreachable), float32="f32", bfloat16="bf16", Generator=unreachable)',
      '    sys.modules["diffusers"] = types.SimpleNamespace(',
      '        AutoencoderKLWan=types.SimpleNamespace(from_pretrained=unreachable),',
      '        WanPipeline=types.SimpleNamespace(from_pretrained=unreachable))',
      '    sys.modules["diffusers.utils"] = types.SimpleNamespace(export_to_video=unreachable)',
      '    runner.parse_args = lambda: argparse.Namespace(',
      '        model_repo="example/wan", model_revision="main", prompt="p", negative_prompt="",',
      '        width=640, height=640, num_frames=41, fps=24, steps=8, guidance=5.0, seed=1,',
      '        output=str(Path(temp) / "out.mp4"))',
      '    try:',
      '        runner.main()',
      '    except ValueError as exc:',
      '        assert "escapes its component directory" in str(exc), exc',
      '        print("rejected before loading")',
      '    else:',
      '        raise AssertionError("Unsafe index reached the loader")',
    ].join('\n')}`);
    expect(output.trim()).toBe('rejected before loading');
  });
});
