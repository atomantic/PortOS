import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ffmpegInstallCommand, parseMotionSetupArgs, skillInstallCommand } from './setup-motion.js';
import { MOTION_SKILL_PACKS, detectMotionSkills } from '../server/lib/motionSkills.js';

describe('motion studio setup', () => {
  it('selects skill packs by id and refuses unknown ones before installing anything', () => {
    expect(parseMotionSetupArgs(['--skills']).skills).toEqual(MOTION_SKILL_PACKS.map(pack => pack.id));
    expect(parseMotionSetupArgs(['--skills=remotion', '--yes'])).toMatchObject({ skills: ['remotion'], yes: true });
    expect(() => parseMotionSetupArgs(['--skills=remotion,nope'])).toThrow('Unknown skill pack: nope');
    expect(() => parseMotionSetupArgs(['--force'])).toThrow('Unknown option');
  });

  it('installs each pack user-wide without prompts, for the agents CoS runs', () => {
    const pack = MOTION_SKILL_PACKS.find(entry => entry.id === 'hyperframes');
    const [command, args] = skillInstallCommand(pack);
    expect(command).toBe('npx');
    // --global/--yes keep an unattended setup from hanging on a scope prompt.
    expect(args).toEqual(['-y', 'skills@latest', 'add', 'heygen-com/hyperframes', '--global', '--yes',
      '--agent', 'claude-code', 'codex', '--skill', ...pack.skills]);
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
