import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkFabrication, noFabricationClause } from './fabricationGuard.js';

describe('noFabricationClause', () => {
  it('names the tool as the only sanctioned producer', () => {
    const clause = noFabricationClause('generate_image');
    expect(clause).toContain('Only the generate_image tool may produce this image');
  });

  it('names the empty-handed outcome as correct', () => {
    // Without this half the agent is still measured on "a file exists", which
    // is exactly what drove it to draw one with code when the tool 429'd.
    const clause = noFabricationClause('image_gen');
    expect(clause).toContain('write nothing at that path');
    expect(clause).toContain('Reporting the failure is the correct outcome');
  });

  it('forbids the specific substitutes an agent reaches for', () => {
    const clause = noFabricationClause('generate_image');
    for (const banned of ['no code', 'no scripts', 'plotting', 'SVG', 'placeholder']) {
      expect(clause).toContain(banned);
    }
  });
});

describe('checkFabrication', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-fabguard-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a clean run that produced only the staged output', async () => {
    await writeFile(join(dir, 'output.png'), 'png bytes');
    expect(await checkFabrication(dir, 'generate_image')).toBe(null);
  });

  it('flags a drawing script left beside the output', async () => {
    await writeFile(join(dir, 'output.png'), 'png bytes');
    await writeFile(join(dir, 'render_sheet.py'), 'import matplotlib');
    const reason = await checkFabrication(dir, 'generate_image');
    expect(reason).toContain('render_sheet.py');
    expect(reason).toContain('drawn by code');
    expect(reason).toContain('generate_image was unavailable');
    expect(reason).toContain('discarded');
  });

  it('flags an interpreter cache directory', async () => {
    await mkdir(join(dir, '__pycache__'), { recursive: true });
    expect(await checkFabrication(dir, 'image_gen')).toContain('__pycache__');
  });

  it('applies the same rule at any depth', async () => {
    // A nested script counts exactly as much as one beside the output — the
    // rule must not weaken with depth.
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'draw.js'), 'canvas');
    expect(await checkFabrication(dir, 'image_gen')).toContain(join('scripts', 'draw.js'));
  });

  it('flags a nested interpreter cache too', async () => {
    await mkdir(join(dir, 'work', '__pycache__'), { recursive: true });
    await writeFile(join(dir, 'work', '__pycache__', 'x.pyc'), 'bytecode');
    expect(await checkFabrication(dir, 'image_gen')).toContain('__pycache__');
  });

  it('ignores a CLI writing its own session state into its cwd', async () => {
    // A false positive here fails an otherwise-good render, so non-source
    // leftovers must not trip the guard.
    await writeFile(join(dir, 'output.png'), 'png bytes');
    await writeFile(join(dir, 'session.log'), 'narration');
    await writeFile(join(dir, '.agy-state.json'), '{}');
    expect(await checkFabrication(dir, 'generate_image')).toBe(null);
  });

  it('returns null for a directory that no longer exists', async () => {
    await rm(dir, { recursive: true, force: true });
    expect(await checkFabrication(dir, 'generate_image')).toBe(null);
  });

  it('caps the listed residue so the error stays readable', async () => {
    for (let i = 0; i < 12; i++) await writeFile(join(dir, `f${i}.py`), 'x');
    const reason = await checkFabrication(dir, 'image_gen');
    expect(reason.match(/f\d+\.py/g)).toHaveLength(5);
  });
});
