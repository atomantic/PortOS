import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ffmpegInstallCommand, parseMotionSetupArgs } from './setup-motion.js';
import { MOTION_SKILL_PACKS, detectMotionSkills } from '../server/lib/motionSkills.js';

describe('motion studio setup', () => {
  it('selects skill packs by id and refuses unknown ones before installing anything', () => {
    expect(parseMotionSetupArgs(['--skills']).skills).toEqual(MOTION_SKILL_PACKS.map(pack => pack.id));
    expect(parseMotionSetupArgs(['--skills=remotion', '--yes'])).toMatchObject({ skills: ['remotion'], yes: true });
    expect(() => parseMotionSetupArgs(['--skills=remotion,nope'])).toThrow('Unknown skill pack: nope');
    expect(() => parseMotionSetupArgs(['--force'])).toThrow('Unknown option');
  });

  it('pins every pack to an immutable commit and archive digest instead of a floating npx CLI', () => {
    for (const pack of MOTION_SKILL_PACKS) {
      expect(pack.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('uses the platform package manager for ffmpeg and reports none when unavailable', () => {
    const has = available => command => available.includes(command);
    expect(ffmpegInstallCommand('darwin', has(['brew']))).toEqual(['brew', ['install', 'ffmpeg']]);
    expect(ffmpegInstallCommand('linux', has(['apt-get']))[1]).toEqual(['apt-get', 'install', '-y', 'ffmpeg']);
    expect(ffmpegInstallCommand('darwin', has([]))).toBeNull();
  });

  it('detects skills linked into either agent skill directory', () => {
    const home = '/home/example';
    const present = new Set([join(home, '.agents', 'skills', 'remotion-best-practices', 'SKILL.md'),
      join(home, '.claude', 'skills', 'motion-graphics', 'SKILL.md')]);
    const packs = detectMotionSkills({ home, exists: path => present.has(path) });
    expect(packs.find(pack => pack.id === 'remotion')).toMatchObject({ installed: true, found: ['remotion-best-practices'] });
    expect(packs.find(pack => pack.id === 'hyperframes')).toMatchObject({ installed: false, found: ['motion-graphics'] });
    expect(packs.find(pack => pack.id === 'claude-animation').found).toEqual([]);
  });
});
