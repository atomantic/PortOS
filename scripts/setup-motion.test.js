import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ffmpegInstallCommands, parseMotionSetupArgs } from './setup-motion.js';
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
    expect(ffmpegInstallCommands('darwin', has(['brew']))).toEqual([['brew', 'install', 'ffmpeg']]);
    expect(ffmpegInstallCommands('darwin', has([]))).toBeNull();
    expect(ffmpegInstallCommands('win32', has(['winget']))[0][0]).toBe('winget');
  });

  it('installs on a root Linux container without sudo, refreshing the apt cache first', () => {
    const has = available => command => available.includes(command);
    expect(ffmpegInstallCommands('linux', has(['apt-get']), { isRoot: true })).toEqual([
      ['apt-get', 'update'],
      ['apt-get', 'install', '-y', 'ffmpeg']
    ]);
  });

  it('prefixes non-root Linux installs with sudo, or sudo -n when non-interactive', () => {
    const has = available => command => available.includes(command);
    const interactive = ffmpegInstallCommands('linux', has(['apt-get', 'sudo']), { isRoot: false });
    expect(interactive).toEqual([['sudo', 'apt-get', 'update'], ['sudo', 'apt-get', 'install', '-y', 'ffmpeg']]);
    const quiet = ffmpegInstallCommands('linux', has(['dnf', 'sudo']), { isRoot: false, nonInteractive: true, canSudoNonInteractive: () => true });
    expect(quiet).toEqual([['sudo', '-n', 'dnf', 'install', '-y', 'ffmpeg']]);
    expect(ffmpegInstallCommands('linux', has(['dnf', 'sudo']), { isRoot: false, nonInteractive: true, canSudoNonInteractive: () => false })).toBeNull();
    expect(ffmpegInstallCommands('linux', has(['apt-get']), { isRoot: false })).toBeNull();
  });

  it('supports pacman on Linux', () => {
    const has = available => command => available.includes(command);
    expect(ffmpegInstallCommands('linux', has(['pacman']), { isRoot: true })).toEqual([['pacman', '-S', '--noconfirm', 'ffmpeg']]);
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
