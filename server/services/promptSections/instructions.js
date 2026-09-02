/**
 * Skill-template routing and bounded AGENTS.md / CLAUDE.md discovery.
 */

import { join, basename } from 'path';
import { readdir } from 'fs/promises';
import { homedir } from 'os';
import { PATHS, tryReadFile } from '../../lib/fileUtils.js';
import { AGENT_INSTRUCTIONS_FILENAME, CLAUDE_BRIDGE_FILENAME } from '../../lib/agentInstructionsFile.js';

const SKILLS_DIR = join(PATHS.root, 'data/prompts/skills');

/**
 * Skill template keyword matchers.
 * Each entry maps a skill template filename to its trigger keywords.
 * Order matters — first match wins, so more specific patterns come first.
 */
const SKILL_MATCHERS = [
  {
    skill: 'module-hygiene',
    keywords: ['module-hygiene', 'module hygiene']
  },
  {
    skill: 'data-safety',
    keywords: ['data-safety', 'upgrade-safety', 'schema parity', 'schemaversion', 'seed file', 'data.reference']
  },
  {
    skill: 'simplify',
    keywords: ['dead code', 'unused export', 'duplication', 'copy-paste', 'unreferenced']
  },
  {
    skill: 'security-audit',
    keywords: ['security', 'audit', 'vulnerability', 'xss', 'injection', 'owasp', 'cve', 'penetration', 'hardening', 'sanitize', 'authorization']
  },
  {
    skill: 'mobile-responsive',
    keywords: ['mobile', 'responsive', 'tablet', 'breakpoint', 'viewport', 'touch', 'swipe', 'small screen', 'media query', 'mobile-friendly', 'adaptive']
  },
  {
    skill: 'bug-fix',
    keywords: ['fix', 'bug', 'broken', 'error', 'crash', 'issue', 'not working', 'fails', 'regression', 'defect']
  },
  {
    skill: 'refactor',
    keywords: ['refactor', 'reorganize', 'restructure', 'clean up', 'simplify', 'extract', 'consolidate', 'decouple', 'modularize']
  },
  {
    skill: 'documentation',
    keywords: ['document', 'documentation', 'docs', 'readme', 'jsdoc', 'api docs', 'guide', 'tutorial', 'changelog']
  },
  {
    skill: 'feature',
    keywords: ['add', 'create', 'implement', 'build', 'new', 'feature', 'support', 'enable', 'integrate', 'endpoint', 'page', 'component']
  }
];

const SKILL_NAMES = new Set(SKILL_MATCHERS.map(({ skill }) => skill));
const TASK_TYPE_SKILL_ALIASES = Object.freeze({
  security: 'security-audit',
});

const skillForTaskType = (task) => {
  const taskTypes = [
    task?.metadata?.analysisType,
    task?.metadata?.taskAnalysisType,
    task?.metadata?.selfImprovementType,
  ];
  for (const taskType of taskTypes) {
    if (typeof taskType !== 'string') continue;
    const normalized = taskType.trim().toLowerCase();
    if (Object.hasOwn(TASK_TYPE_SKILL_ALIASES, normalized)) {
      return TASK_TYPE_SKILL_ALIASES[normalized];
    }
    if (SKILL_NAMES.has(normalized)) return normalized;
  }
  return null;
};

// Domain templates complement (rather than replace) the lifecycle template
// selected above. Keep this list narrow: broad graphics terms would add prompt
// weight to tasks that do not involve scene construction or rendering.
const DOMAIN_SKILL_MATCHERS = [
  {
    skill: 'threejs-visual',
    patterns: [
      /\bthree(?:\.?js)\b/,
      /\breact[-\s]?three[-\s]?fiber\b/,
      /\br3f\b/,
      /\bwebgl\s+scene\b/,
    ],
  },
];

/**
 * Detect the best matching skill template for a task based on description keywords.
 * @param {Object} task - Task object with description
 * @returns {string|null} Skill template name or null if no match
 */
export function detectSkillTemplate(task) {
  const taskTypeSkill = skillForTaskType(task);
  if (taskTypeSkill) return taskTypeSkill;

  const desc = (task?.description || '').toLowerCase();
  for (const matcher of SKILL_MATCHERS) {
    if (matcher.keywords.some(kw => desc.includes(kw))) {
      return matcher.skill;
    }
  }
  return null;
}

/**
 * Detect one optional domain template to append after the primary lifecycle
 * template. Domain routing is deliberately independent so, for example, a
 * Three.js security audit keeps its security guidance.
 * @param {Object} task - Task object with description
 * @returns {string|null} Domain skill template name or null
 */
export function detectDomainSkillTemplate(task) {
  const desc = (task?.description || '').toLowerCase();
  for (const matcher of DOMAIN_SKILL_MATCHERS) {
    if (matcher.patterns.some((pattern) => pattern.test(desc))) {
      return matcher.skill;
    }
  }
  return null;
}

/**
 * Resolve the primary lifecycle template and at most one domain guide.
 * @param {Object} task - Task object with description
 * @returns {string[]} Ordered template names
 */
export function detectSkillTemplates(task) {
  return [detectSkillTemplate(task), detectDomainSkillTemplate(task)].filter(Boolean);
}

/**
 * Load a skill template from disk if it exists.
 * @param {string} skillName - Name of the skill template file (without .md)
 * @returns {Promise<string|null>} Template content or null
 */
export async function loadSkillTemplate(skillName) {
  const content = await tryReadFile(join(SKILLS_DIR, `${skillName}.md`));
  if (content) console.log(`🎯 Loaded skill template: ${skillName}`);
  return content;
}

/**
 * Load ordered templates as one prompt section, retaining the primary guidance
 * even when an optional domain template is unavailable on an older install.
 * @param {string[]} skillNames - Ordered skill template names
 * @param {(skillName: string) => Promise<string|null>} loadTemplate - Loader seam for tests
 * @returns {Promise<string|null>} Joined template content or null
 */
export async function loadSkillTemplates(skillNames, loadTemplate = loadSkillTemplate) {
  const templates = await Promise.all(skillNames.map((skillName) => (
    Promise.resolve(loadTemplate(skillName)).catch((err) => {
      console.log(`⚠️ Skill template load failed for ${skillName}: ${err.message}`);
      return null;
    })
  )));
  return templates.filter(Boolean).join('\n\n') || null;
}

// Nested agent-instruction discovery bounds (#3866). On-demand nested memory
// files are a Claude Code feature — an API-provider agent reads nothing
// natively, so PortOS has to splice them in itself or a subtree rule (including
// a data-loss guard) never reaches that class of agent. The walk is bounded on
// three axes so a repo that grows nested files can't silently balloon every
// agent prompt or turn one prompt build into a full-tree crawl.
const NESTED_AGENT_MD_MAX_DEPTH = 5;
const NESTED_AGENT_MD_MAX_FILES = 10;
const NESTED_AGENT_MD_MAX_DIRS = 2000;
// Dot-directories are skipped wholesale (covers `.git`), so these are the
// non-dot trees that are either vendored, generated, or runtime state. The list
// is deliberately polyglot: an agent workspace is any app PortOS manages, not
// just this repo, so a Rust `target/` or a Go `vendor/` would otherwise burn the
// directory budget on generated files.
const NESTED_AGENT_MD_SKIP_DIRS = new Set([
  'node_modules', 'data', 'data.reference', 'dist', 'build', 'coverage',
  'out', 'obj', 'bin', 'target', 'vendor', 'tmp', 'venv', 'Pods', '__pycache__',
]);

// Instruction filenames in preference order (#4852). `AGENTS.md` is the
// cross-vendor standard PortOS now ships; `CLAUDE.md` stays discoverable because
// a managed app may still carry only that name, and a plain rename would
// silently drop its context. A directory holding both contributes exactly ONE
// entry — otherwise this repo's four nested pairs would count as eight against
// NESTED_AGENT_MD_MAX_FILES and the budget would overflow without a signal.
const AGENT_INSTRUCTION_FILENAMES = [AGENT_INSTRUCTIONS_FILENAME, CLAUDE_BRIDGE_FILENAME];

/**
 * True for a bridge `CLAUDE.md` whose entire body is an `@AGENTS.md` import —
 * how PortOS and its scaffolders keep Claude Code (which has no configurable
 * memory filename) reading the shared file. It carries no content of its own, so
 * splicing it would add a useless one-line section to every agent prompt and
 * burn a slot against the file cap.
 * @param {string} content
 */
const isImportOnlyInstructionFile = (content) => {
  const lines = String(content)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  if (!lines.every((line) => /^@\S+$/.test(line))) return false;
  return lines.some((line) => basename(line.slice(1)).toLowerCase() === 'agents.md');
};

/**
 * Read one instruction file, collapsing "absent", "empty", and "import-only
 * bridge" to the same null so callers can fall through to the next candidate.
 * @param {string} path
 * @returns {Promise<string|null>} trimmed content, or null
 */
const readInstructionFile = async (path) => {
  const content = await tryReadFile(path);
  if (!content?.trim()) return null;
  if (basename(path) === CLAUDE_BRIDGE_FILENAME && isImportOnlyInstructionFile(content)) return null;
  return content.trim();
};

/**
 * Collect nested per-directory instruction files (the workspace root is excluded
 * — its caller reads it separately and must keep it first). Depth-first in
 * lexicographic order, so the result is deterministic and prompt caching stays
 * stable across builds.
 * @param {string} workspaceDir
 * @returns {Promise<Array<{ rel: string, content: string }>>} e.g. `[{ rel: 'server/AGENTS.md', … }]`
 */
async function findNestedAgentInstructionFiles(workspaceDir) {
  const found = [];
  let dirsVisited = 0;

  const walk = async (dir, relDir, depth) => {
    if (found.length >= NESTED_AGENT_MD_MAX_FILES) return;
    if (depth > NESTED_AGENT_MD_MAX_DEPTH) return;
    if (dirsVisited >= NESTED_AGENT_MD_MAX_DIRS) return;
    dirsVisited += 1;

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    // A nested directory carrying its own `.git` is a submodule or vendored
    // checkout (`lib/slashdo` here) — its instructions are that project's, not
    // this workspace's. Detected structurally rather than by an allowlist of
    // paths, which would silently stop matching the moment the workspace root is
    // something other than this repo's root.
    if (depth > 0 && entries.some((entry) => entry.name === '.git')) return;
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const subdirs = [];
    const instructionNames = new Set();
    for (const entry of sorted) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (NESTED_AGENT_MD_SKIP_DIRS.has(entry.name)) continue;
        subdirs.push({ path: join(dir, entry.name), rel });
        // Symlinked directories are deliberately NOT followed — a link back up
        // the tree would loop, and the depth cap alone wouldn't make the result
        // meaningful. A symlinked instruction *file* is still read (below).
      } else if (AGENT_INSTRUCTION_FILENAMES.includes(entry.name)) {
        instructionNames.add(entry.name);
      }
    }

    // One entry per directory. Content is read here rather than by the caller so
    // an import-only bridge can be dropped before it consumes a slot against the
    // file cap — filtering after the walk would let a directory of bridges push
    // real instructions out of the budget.
    if (relDir) {
      for (const name of AGENT_INSTRUCTION_FILENAMES) {
        if (!instructionNames.has(name)) continue;
        const content = await readInstructionFile(join(dir, name));
        if (!content) continue;
        found.push({ rel: `${relDir}/${name}`, content });
        break;
      }
      if (found.length >= NESTED_AGENT_MD_MAX_FILES) return;
    }

    for (const sub of subdirs) {
      if (found.length >= NESTED_AGENT_MD_MAX_FILES) return;
      await walk(sub.path, sub.rel, depth + 1);
    }
  };

  await walk(workspaceDir, '', 0);
  return found;
}

/**
 * Read agent-instruction files for agent context.
 * Reads the global (`~/.claude/CLAUDE.md`), the workspace-root `AGENTS.md` (or
 * `CLAUDE.md`), and every nested instruction file under the workspace (#3866) —
 * nested last, each as its own labeled section, so precedence still reads
 * root-then-specific.
 */
export async function getAgentInstructionsContext(workspaceDir) {
  const contexts = [];

  // Claude Code's own global memory location — a user-level path, not a repo
  // convention, so it keeps the CLAUDE.md name (#4852).
  const globalPath = join(homedir(), '.claude', 'CLAUDE.md');
  const globalContent = await tryReadFile(globalPath);
  if (globalContent?.trim()) {
    contexts.push({ type: 'Global Instructions', path: globalPath, content: globalContent.trim() });
  }

  // Workspace-root instructions, `AGENTS.md` preferred.
  for (const name of AGENT_INSTRUCTION_FILENAMES) {
    const projectPath = join(workspaceDir, name);
    const projectContent = await readInstructionFile(projectPath);
    if (projectContent) {
      contexts.push({ type: 'Project Instructions', path: projectPath, content: projectContent });
      break;
    }
  }

  // Nested per-directory instructions, appended after the root file.
  for (const { rel, content } of await findNestedAgentInstructionFiles(workspaceDir)) {
    contexts.push({ type: `Project Instructions (${rel})`, path: join(workspaceDir, rel), content });
  }

  if (contexts.length === 0) {
    return null;
  }

  let section = '## Agent Instructions\n\n';
  section += 'The following instructions must be followed when working on this task:\n\n';

  for (const ctx of contexts) {
    section += `### ${ctx.type}\n`;
    section += `Source: \`${ctx.path}\`\n\n`;
    section += ctx.content + '\n\n';
  }

  return section;
}
