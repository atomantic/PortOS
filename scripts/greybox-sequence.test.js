import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('plans without browser/provider work and refuses to overwrite an existing output', () => {
  const root = mkdtempSync(join(tmpdir(), 'greybox-sequence-cli-'));
  const output = join(root, 'export');
  const script = fileURLToPath(new URL('./greybox-sequence.js', import.meta.url));
  const input = fileURLToPath(new URL('../docs/examples/greybox-sequence.json', import.meta.url));
  const args = [script, '--input', input, '--output', output, '--plan-only'];
  try {
    expect(execFileSync(process.execPath, args, { encoding: 'utf8' })).toContain('Planned 480 frames');
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
    expect(manifest).toMatchObject({ status: 'planned', fps: 24 });
    expect(manifest.frames).toHaveLength(480);
    expect(manifest.sourceSha256).toBe(createHash('sha256').update(readFileSync(join(output, 'source.json'))).digest('hex'));
    const canary = join(output, 'keep.txt');
    writeFileSync(canary, 'preserved');
    expect(() => execFileSync(process.execPath, args, { stdio: 'pipe' })).toThrow();
    expect(readFileSync(canary, 'utf8')).toBe('preserved');
    expect(() => execFileSync(process.execPath, [script, '--input', input, '--output', join(root, 'unknown'), '--shot', 'missing', '--plan-only'], { stdio: 'pipe' })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
