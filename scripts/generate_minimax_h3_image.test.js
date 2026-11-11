import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

// The geometry and sampler-layout helpers of the MiniMax H3-Image MLX adapter.
// They decide where every token sits in the packed sequence and which timestep
// each row reads, so a wrong row renders garbage silently on a 69 GB model run
// nobody can afford to bisect. Rendering itself needs MLX and the weights and is
// verified on Apple Silicon, not here.
const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_minimax_h3_image.py');
const pyBin = resolveTestPython();
const hasNumpy = (() => {
  if (!pyBin) return false;
  try {
    execFileSync(pyBin, ['-c', 'import numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const importRunner = [
  'import importlib.util, json, sys',
  'from pathlib import Path',
  'spec = importlib.util.spec_from_file_location("generate_minimax_h3_image", Path(sys.argv[1]))',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');
const runPython = (body) => JSON.parse(execFileSync(pyBin, ['-c', `${importRunner}\n${body}`, script], { encoding: 'utf8' }));

describe.skipIf(!hasNumpy)('generate_minimax_h3_image.py geometry', () => {
  it('renders small requests on an enlarged 32px canvas and keeps 4K UHD at native size', () => {
    const out = runPython([
      'print(json.dumps({',
      '  "square": runner.generation_canvas(1024, 1024, 2048 * 2048),',
      '  "uhd": runner.generation_canvas(3840, 2160, 2048 * 2048),',
      '  "portrait": runner.generation_canvas(768, 1344, 2048 * 2048),',
      '}))',
    ].join('\n'));
    expect(out.square).toEqual([2048, 2048]);
    expect(out.uhd).toEqual([3840, 2176]);
    const [w, h] = out.portrait;
    expect(w % 32 + h % 32).toBe(0);
    expect(w * h).toBeGreaterThanOrEqual(2048 * 2048 * 0.97);
    expect(h / w).toBeCloseTo(1344 / 768, 1);
  });

  it('accepts any size inside the pixel cap but refuses extreme aspects and too many references', () => {
    const out = runPython([
      'def check(**over):',
      '    ns = runner.parse_args(["--runtime-dir", "r", "--runtime-revision", "x", "--model-repo", "m", "--model-revision", "x",',
      '        "--text-encoder-repo", "t", "--text-encoder-revision", "x", "--prompt", "a lake", "--width", "3840", "--height", "2160",',
      '        "--seed", "1", "--output", "o.png"])',
      '    vars(ns).update(over)',
      '    try:',
      '        runner.validate_args(ns)',
      '        return "ok"',
      '    except SystemExit as error:',
      '        return str(error)',
      'print(json.dumps({',
      '  "uhd": check(),',
      '  "small": check(width=500, height=500),',
      '  "wide": check(width=4000, height=1000),',
      '  "refs": check(reference_image=["r.png"] * 17),',
      '}))',
    ].join('\n'));
    expect(out).toMatchObject({ uhd: 'ok', small: 'ok' });
    expect(out.wide).toMatch(/1:3 to 3:1/);
    expect(out.refs).toMatch(/at most 16/);
  });

  it('packs text, one frame per reference, then the target, and pins reference rows to the condition timestep', () => {
    const out = runPython([
      'layout = runner.build_layout([1, 1, 0, 1], [(4, 4), (2, 6)], 4, 8)',
      'table, plan = runner.timestep_plan([1.0, 0.75, 0.0], layout)',
      'bare_table, _ = runner.timestep_plan([1.0, 0.75, 0.0], runner.build_layout([1], [], 4, 4))',
      'pos = layout["position_ids"]',
      'tl = layout["text_len"]',
      'print(json.dumps({',
      '  "text_len": tl, "n_cond": layout["n_cond"], "seq": layout["seq_len"],',
      '  "text_t": pos[:tl, 0].tolist(), "text_hw": pos[:tl, 1:].tolist(),',
      '  "ref_t": sorted(set(pos[tl:tl + layout["n_cond"], 0].tolist())),',
      '  "target_t": sorted(set(pos[tl + layout["n_cond"]:, 0].tolist())),',
      '  "tags": layout["token_tags"].tolist(),',
      '  "table": [round(float(v), 4) for v in table],',
      '  "step_rows": [[int(r[0]), int(r[tl]), int(r[-1])] for r in plan],',
      '  "bare_table": [round(float(v), 4) for v in bare_table],',
      '}))',
    ].join('\n'));
    // Latent 4x4 and 2x6 at patch 2 give 4 + 3 rows; the 4x8 target gives 8.
    expect(out).toMatchObject({ text_len: 4, n_cond: 7, seq: 19 });
    expect(out.text_t).toEqual([0, 1, 2, 3]);
    expect(out.text_hw.flat().every(v => v === 0)).toBe(true);
    expect(out.ref_t).toEqual([4, 5]);
    expect(out.target_t).toEqual([6]);
    expect(out.tags).toEqual([1, 1, 0, 1, ...Array(15).fill(0)]);
    // t = 1 - sigma per step, plus the 0.999 condition timestep.
    expect(out.table).toEqual([0, 0.25, 0.999]);
    expect(out.step_rows).toEqual([[0, 2, 0], [1, 2, 1]]);
    expect(out.bare_table).toEqual([0, 0.25]);
  });

  it('rescales a reference only when its short edge leaves the bounds', () => {
    const out = runPython([
      'print(json.dumps({',
      '  "inside": runner.bounded_reference_size(1536, 1024, (1024, 2048)),',
      '  "small": runner.bounded_reference_size(600, 400, (1024, 2048)),',
      '  "large": runner.bounded_reference_size(6000, 4000, (1024, 2048)),',
      '}))',
    ].join('\n'));
    expect(out.inside).toBeNull();
    expect(out.small).toEqual([1536, 1024]);
    expect(out.large).toEqual([3072, 2048]);
  });

  it('refuses conditioning canvases above the pixel limit before allocating a resized image', () => {
    const out = runPython([
      'def check(w, h):',
      '    try:',
      '        runner.bounded_reference_size(w, h, (1024, 1024))',
      '        return "ok"',
      '    except SystemExit as error:',
      '        return str(error)',
      'print(json.dumps([check(1, 1000), check(1024, 1000000), check(1024, 1536)]))',
    ].join('\n'));
    expect(out.slice(0, 2)).toEqual([expect.stringContaining('20,000,000 pixels'), expect.stringContaining('20,000,000 pixels')]);
    expect(out[2]).toBe('ok');
  });
});
