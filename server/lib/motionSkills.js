import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Optional third-party agent skills that teach motion-design technique.
 * `npm run setup:motion -- --skills` installs them user-wide through the
 * `skills` CLI; a launch-video run can then ask its agent to consult them.
 * They are technique references only: every render still goes through the
 * PortOS seek(t) composition contract and its launch-video gates.
 */
export const MOTION_SKILL_PACKS = Object.freeze([
  Object.freeze({
    id: 'hyperframes',
    label: 'HyperFrames',
    source: 'heygen-com/hyperframes',
    skills: Object.freeze(['hyperframes-animation', 'hyperframes-creative', 'motion-graphics', 'product-launch-video']),
    description: 'HTML motion-graphics, product-launch and animation craft guides',
  }),
  Object.freeze({
    id: 'remotion',
    label: 'Remotion',
    source: 'remotion-dev/skills',
    skills: Object.freeze(['remotion-best-practices']),
    description: 'Content, animation and effects best practices',
  }),
  Object.freeze({
    id: 'claude-animation',
    label: 'Claude Animation',
    source: 'buildwithhanif/claude-animation-skill',
    skills: Object.freeze(['claude-animation']),
    description: 'Hand-drawn 2D animation rigs, pens and synthesized sound',
  }),
]);

// The skills CLI writes the canonical copy to ~/.agents/skills (read by Codex)
// and links it into ~/.claude/skills for Claude Code.
const motionSkillDirs = (home = homedir()) => [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')];

/** Each pack with the skill names found on disk; `installed` means all of them. */
export function detectMotionSkills({ home = homedir(), exists = existsSync } = {}) {
  const dirs = motionSkillDirs(home);
  return MOTION_SKILL_PACKS.map(pack => {
    const found = pack.skills.filter(name => dirs.some(dir => exists(join(dir, name, 'SKILL.md'))));
    return { id: pack.id, label: pack.label, description: pack.description, skills: [...pack.skills], found, installed: found.length === pack.skills.length };
  });
}

// Agents the skills CLI links each installed skill into (Claude Code + Codex
// cover the CoS providers that read skill folders).
const SKILL_AGENTS = ['claude-code', 'codex'];

/** The `skills` CLI invocation that installs one pack user-wide, non-interactively. */
export function skillInstallCommand(pack) {
  return ['npx', ['-y', 'skills@latest', 'add', pack.source, '--global', '--yes', '--agent', ...SKILL_AGENTS, '--skill', ...pack.skills]];
}
