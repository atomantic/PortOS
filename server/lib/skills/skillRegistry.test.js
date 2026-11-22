import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSkillIndex,
  formatSkillIndexForPrompt,
  hostSkillPlatform,
  parseSkillMarkdown,
  parseSupportPath,
  readSkillDocument,
  readSkillSupportFile,
  resolveSkillRef,
  scanSkillSource,
  skillRunsOnPlatform,
  toSkillSummary,
} from './skillRegistry.js';

let base;
const skillMd = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nSteps.\n`;
const put = async (path, content) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'portos-skill-registry-'));
  // project tier: shadows local "deploy"
  await put(join(base, 'project', 'deploy', 'SKILL.md'), skillMd('deploy', 'Project deploy procedure'));
  // local tier: a category folder plus a same-tier name collision
  await put(join(base, 'local', 'devops', 'deploy', 'SKILL.md'), skillMd('deploy', 'Local deploy procedure'));
  await put(join(base, 'local', 'devops', 'deploy', 'references', 'checklist.md'), '- [ ] tag release\n');
  await put(join(base, 'local', 'devops', 'deploy', 'scripts', 'run.sh'), 'echo deploy\n');
  await put(join(base, 'local', 'writing', 'notes', 'SKILL.md'), skillMd('notes', 'Write notes'));
  await put(join(base, 'local', 'research', 'notes', 'SKILL.md'), skillMd('notes', 'Research notes'));
  await put(join(base, 'local', 'mac-only', 'SKILL.md'), skillMd('mac-only', 'Mac thing', 'platforms: [darwin]\n'));
  await put(join(base, 'local', 'broken', 'SKILL.md'), '---\nname: [unclosed\n---\nbody');
  // a skill whose supporting file is a symlink out of the skill directory
  await put(join(base, 'outside-secret.txt'), 'secret');
  await put(join(base, 'local', 'leaky', 'SKILL.md'), skillMd('leaky', 'Has a symlinked reference'));
  await mkdir(join(base, 'local', 'leaky', 'references'), { recursive: true });
  await symlink(join(base, 'outside-secret.txt'), join(base, 'local', 'leaky', 'references', 'secret.md'));
  // a symlinked skill directory is never discovered
  await symlink(join(base, 'project', 'deploy'), join(base, 'local', 'linked-skill'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const scanAll = async () => {
  const project = await scanSkillSource({ tier: 'project', key: 'project', root: join(base, 'project') });
  const local = await scanSkillSource({ tier: 'local', key: 'local', root: join(base, 'local') });
  return { project, local, index: buildSkillIndex([...local.skills, ...project.skills]) };
};

describe('parseSkillMarkdown', () => {
  it('parses agentskills.io frontmatter leniently and refuses invalid YAML', () => {
    const parsed = parseSkillMarkdown('---\nname: x\ndescription: d\nlicense: MIT\nplatforms: [macos, win32]\nversion: 1.2\n---\nbody');
    expect(parsed.ok).toBe(true);
    expect(parsed.frontmatter).toMatchObject({ name: 'x', description: 'd', license: 'MIT', platforms: ['macos', 'windows'], version: '1.2' });
    expect(parsed.body).toBe('body');
    expect(parseSkillMarkdown('no frontmatter').frontmatter).toEqual({});
    expect(parseSkillMarkdown('---\nname: [x\n---\n').ok).toBe(false);
    expect(parseSkillMarkdown('---\nplatforms: [beos]\n---\n').ok).toBe(false);
  });
});

describe('discovery, precedence and ambiguity', () => {
  it('discovers nested skills, skips symlinked directories and reports invalid ones', async () => {
    const { local } = await scanAll();
    const paths = local.skills.map((skill) => skill.path).sort();
    expect(paths).toEqual(['devops/deploy', 'leaky', 'mac-only', 'research/notes', 'writing/notes']);
    expect(local.invalid.map((entry) => entry.path)).toEqual(['broken']);
    expect(local.skills.find((skill) => skill.path === 'devops/deploy').category).toBe('devops');
  });

  it('lets a higher tier shadow a lower one and refuses a same-tier bare-name collision', async () => {
    const { index } = await scanAll();
    expect(resolveSkillRef(index, 'deploy')).toMatchObject({ ok: true, skill: { id: 'project:deploy' } });
    expect(index.shadowed).toEqual([{ id: 'local:devops/deploy', name: 'deploy', tier: 'local', shadowedBy: 'project:deploy' }]);
    // A shadowed skill stays reachable by exact id or path.
    expect(resolveSkillRef(index, 'local:devops/deploy')).toMatchObject({ ok: true, skill: { tier: 'local' } });
    expect(resolveSkillRef(index, 'devops/deploy')).toMatchObject({ ok: true, skill: { tier: 'local' } });

    expect(resolveSkillRef(index, 'notes')).toEqual({ ok: false, code: 'SKILL_AMBIGUOUS', candidates: ['local:research/notes', 'local:writing/notes'] });
    expect(resolveSkillRef(index, 'writing/notes')).toMatchObject({ ok: true, skill: { id: 'local:writing/notes' } });
    expect(resolveSkillRef(index, 'missing')).toEqual({ ok: false, code: 'SKILL_NOT_FOUND' });
  });

  it('gates skills by host platform', async () => {
    const { local } = await scanAll();
    const macOnly = local.skills.find((skill) => skill.name === 'mac-only');
    expect(skillRunsOnPlatform(macOnly, 'macos')).toBe(true);
    expect(skillRunsOnPlatform(macOnly, 'linux')).toBe(false);
    expect(hostSkillPlatform('darwin')).toBe('macos');
    expect(hostSkillPlatform('win32')).toBe('windows');
  });
});

describe('progressive reads', () => {
  it('Level 0 carries no host path and Level 1 lists supporting files', async () => {
    const { index } = await scanAll();
    const skill = resolveSkillRef(index, 'devops/deploy').skill;
    const summary = toSkillSummary(skill);
    expect(summary).toEqual({ id: 'local:devops/deploy', name: 'deploy', description: 'Local deploy procedure', category: 'devops', tier: 'local', path: 'devops/deploy', platforms: null });
    const doc = await readSkillDocument(skill);
    expect(doc.content).toContain('# deploy');
    expect(doc.files).toEqual([{ path: 'references/checklist.md', bytes: 18 }, { path: 'scripts/run.sh', bytes: 12 }]);
  });

  it('Level 2 reads a supporting file and refuses traversal, non-support paths and symlink escape', async () => {
    const { index } = await scanAll();
    const skill = resolveSkillRef(index, 'devops/deploy').skill;
    expect(await readSkillSupportFile(skill, 'references/checklist.md')).toMatchObject({ ok: true, level: 2, content: '- [ ] tag release\n' });
    for (const bad of ['../../outside-secret.txt', 'references/../../x', '/etc/passwd', 'SKILL.md', 'references', 'C:/x', 'references\\x.md']) {
      expect(await readSkillSupportFile(skill, bad)).toEqual({ ok: false, code: 'SKILL_PATH_INVALID' });
    }
    expect(await readSkillSupportFile(skill, 'references/missing.md')).toEqual({ ok: false, code: 'SKILL_FILE_NOT_FOUND' });
    const leaky = resolveSkillRef(index, 'leaky').skill;
    expect(await readSkillSupportFile(leaky, 'references/secret.md')).toEqual({ ok: false, code: 'SKILL_PATH_ESCAPE' });
    expect(parseSupportPath('templates/a/b.md')).toEqual(['templates', 'a', 'b.md']);
  });

  it('formats a capped Level 0 index for prompts', () => {
    expect(formatSkillIndexForPrompt([])).toBe('');
    const section = formatSkillIndexForPrompt([{ id: 'local:a', name: 'a', description: 'Do A' }]);
    expect(section).toContain('## Procedural Skills');
    expect(section).toContain('- `local:a` (a) — Do A');
    const many = Array.from({ length: 55 }, (_, i) => ({ id: `local:s${i}`, name: `s${i}`, description: '' }));
    expect(formatSkillIndexForPrompt(many)).toContain('…and 5 more');
  });
});
