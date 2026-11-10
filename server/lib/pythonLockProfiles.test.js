import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JEV_PYTHON_PACKAGES } from './jev.js';
import { MODEL_ABUSE_GUARD_PYTHON_PACKAGES } from './modelAbuseGuard.js';
import { PRIVATE_UV_VERSION } from './privateUv.js';
import { LOCK_PROFILES, lockEntryText, lockProfileUnsupportedReason, planLockedRepair } from './pythonLockProfiles.js';

const directPins = (lockFile) => readFileSync(lockFile.replace('.lock.txt', '.txt'), 'utf8')
  .split('\n').filter((line) => /^[A-Za-z0-9]/.test(line)).map((line) => line.trim());

describe('locked runtime profiles', () => {
  it.each(Object.values(LOCK_PROFILES))('$id lock hashes every entry and documents a dated, reproducible regeneration', (profile) => {
    const lock = readFileSync(profile.lockFile, 'utf8');
    const entries = lock.split(/\n(?=[A-Za-z0-9])/).filter((entry) => /^[A-Za-z0-9][\w.-]*==/.test(entry));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry, entry.split(' ')[0]).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    expect(lock).toContain('--exclude-newer <UTC date at least 7 days ago>');
    expect(lock).toContain('--generate-hashes');
    expect(lock).toContain('OSV');
  });

  it('keeps the Prompt Guard and jev JS pins identical to the source requirements the lock was compiled from', () => {
    const source = directPins(LOCK_PROFILES['guard-runtime'].lockFile);
    expect(source).toEqual([...MODEL_ABUSE_GUARD_PYTHON_PACKAGES]);
    expect([...JEV_PYTHON_PACKAGES]).toEqual([...MODEL_ABUSE_GUARD_PYTHON_PACKAGES]);
    const lock = readFileSync(LOCK_PROFILES['guard-runtime'].lockFile, 'utf8');
    for (const spec of source) expect(lock, spec).toContain(`${spec.replace('huggingface_hub', 'huggingface-hub')} ;`);
  });

  it('keeps the mflux-video superset on the same mflux direct pins as the shared mflux lock', () => {
    const mflux = directPins(LOCK_PROFILES.mflux.lockFile);
    const video = directPins(LOCK_PROFILES['mflux-video'].lockFile);
    expect(mflux.length).toBeGreaterThan(0);
    for (const pin of mflux) expect(video).toContain(pin);
  });

  it('locks the AuK and Laya runtimes with the build backend their commit-pinned source installs use', () => {
    const locks = Object.fromEntries(['auk-mlx', 'laya-mlx'].map((id) => [id, readFileSync(LOCK_PROFILES[id].lockFile, 'utf8')]));
    // Installed with --no-build-isolation: an absent backend would silently fall back to nothing, not to PyPI.
    expect(locks['auk-mlx']).toMatch(/^setuptools==/m);
    expect(locks['auk-mlx']).toMatch(/^torch==2\.7\./m);
    expect(locks['laya-mlx']).toMatch(/^hatchling==/m);
    expect(locks['laya-mlx']).toMatch(/^mlx==0\.32\./m);
    for (const profile of [LOCK_PROFILES['auk-mlx'], LOCK_PROFILES['laya-mlx']]) {
      expect(lockProfileUnsupportedReason(profile, { platform: 'darwin', arch: 'arm64' })).toBeNull();
      expect(lockProfileUnsupportedReason(profile, { platform: 'linux', arch: 'x64' })).toMatch(/no hash-pinned lock/);
    }
  });

  it('pins the private uv bootstrap to the version PortOS runs, with a digest for every distribution', () => {
    const { lockFile } = LOCK_PROFILES['uv-bootstrap'];
    expect(directPins(lockFile)).toEqual([`uv==${PRIVATE_UV_VERSION}`]);
    const lock = readFileSync(lockFile, 'utf8');
    expect(lock).toContain(`uv==${PRIVATE_UV_VERSION}`);
    expect(lock.match(/--hash=sha256:/g).length).toBeGreaterThan(5);
  });

  it('extracts exactly one distribution, with its hashes, for a targeted force-reinstall', () => {
    const entry = lockEntryText(LOCK_PROFILES['mflux-video'], 'mlx-video-with-audio');
    expect(entry).toMatch(/^mlx-video-with-audio==/);
    expect(entry.match(/^[A-Za-z0-9][\w.-]*==/gm)).toHaveLength(1);
    expect(entry).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    expect(lockEntryText(LOCK_PROFILES['mflux-video'], 'not-a-package')).toBe('');
  });

  it('refuses hosts no lock environment covers with a precise report', () => {
    const guard = LOCK_PROFILES['guard-runtime'];
    expect(lockProfileUnsupportedReason(guard, { platform: 'linux', arch: 'x64' })).toBeNull();
    expect(lockProfileUnsupportedReason(guard, { platform: 'darwin', arch: 'x64' })).toMatch(/no hash-pinned lock for darwin\/x64/);
    expect(lockProfileUnsupportedReason(LOCK_PROFILES.mflux, { platform: 'win32', arch: 'x64' })).toMatch(/win32\/x64/);
  });

  describe('generic repair dispatch', () => {
    it('chooses the smallest lock owning every requested package, by pip name or specifier', () => {
      expect(planLockedRepair(['mflux', 'transformers', 'opencv-python', 'huggingface_hub'], { appleSilicon: true }).profile.id).toBe('mflux');
      expect(planLockedRepair(['mflux', 'mlx_vlm', 'mlx-video-with-audio>=0.1.35'], { appleSilicon: true }).profile.id).toBe('mflux-video');
    });

    it('reports packages no lock covers instead of solving them', () => {
      const plan = planLockedRepair(['mflux', 'diffusers'], { appleSilicon: true });
      expect(plan.profile).toBeUndefined();
      expect(plan.unresolved).toEqual([{ name: 'diffusers', reason: expect.stringContaining('hash-pinned') }]);
      expect(planLockedRepair(['numpy'], { appleSilicon: false }).unresolved).toHaveLength(1);
    });
  });
});
