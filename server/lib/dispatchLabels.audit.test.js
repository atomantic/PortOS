/**
 * Repository-wide audit: planner-driven GitHub/GitLab issue-create
 * instructions mention the independent model/effort vocabularies (and
 * contributor labels), or import the shared contract that does.
 *
 * Historical prompt snapshots, tests, and the monitoring-only
 * self-diagnostics summary are excluded on purpose.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCAN_ROOTS = ['server', 'AGENTS.md', '.claude/skills'];
const SKIP_DIR = new Set(['node_modules', 'data']);
const SKIP_FILE = [
  /integrity\.snapshot\.json$/,
  /selfDiagnostics\.js$/,
  /versions\.js$/,
  /\.test\.js$/,
];

const CREATE_RE = /(?:gh|glab)\s+issue\s+create\s+--/;
const IMPORTS_CONTRACT_RE = /from ['"].*dispatchLabels\.js['"]/;
const MODEL_RE = /model:light\|medium\|heavy|model:light\/medium\/heavy|"model": "light \| medium \| heavy"|model:<tier>/;
const EFFORT_RE = /effort:low\|medium\|high\|xhigh\|max|effort:low\/medium\/high\/xhigh\/max|"effort": "low \| medium \| high \| xhigh \| max"|effort:<level>/;
const GOOD_FIRST_RE = /good first issue|good-first-issue|goodFirstIssue/;

function walk(dir, root, acc = []) {
  for (const name of readdirSync(dir)) {
    if ((name.startsWith('.') && name !== '.claude') || SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(root, full);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walk(full, root, acc);
      continue;
    }
    if (!/\.(js|md)$/.test(name)) continue;
    if (SKIP_FILE.some((re) => re.test(rel))) continue;
    acc.push(full);
  }
  return acc;
}

function collect(repoRoot = ROOT) {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const full = join(repoRoot, root);
    try {
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, repoRoot, files);
      else if (st.isFile()) files.push(full);
    } catch {
      // missing optional root
    }
  }
  return files
    .map((file) => ({ file, src: readFileSync(file, 'utf8') }))
    .filter(({ src }) => CREATE_RE.test(src));
}

describe('issue-create paths mention dispatch + contributor labels (#4351)', () => {
  const hits = collect();

  it('keeps the issue-label audit bounded to authored files beside nested dependencies and data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portos-dispatch-audit-'));
    try {
      const authored = [join(root, 'server', 'planner.js'), join(root, '.claude', 'skills', 'planner', 'SKILL.md')];
      const generated = [join(root, 'server', 'node_modules', 'example', 'index.js'), join(root, 'server', 'data', 'private.js')];
      for (const file of [...authored, ...generated]) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, 'gh issue create --title synthetic');
      }
      expect(collect(root).map(({ file }) => file).sort()).toEqual(authored.sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds the planner-driven create sites', () => {
    const rels = hits.map(({ file }) => relative(ROOT, file));
    expect(rels.some((r) => r.includes('workTracker.js'))).toBe(true);
    expect(rels.some((r) => r.includes('quotaBurnPresets.js'))).toBe(true);
    expect(rels.some((r) => r.includes('prompts.js'))).toBe(true);
    expect(rels.some((r) => r.includes('selfDiagnostics.js'))).toBe(false);
  });

  it('each create site names both dispatch axes and good first issue, or imports the shared contract', () => {
    const missing = hits
      .map(({ file, src }) => {
        const rel = relative(ROOT, file);
        if (IMPORTS_CONTRACT_RE.test(src)) return null;
        const gaps = [];
        if (!MODEL_RE.test(src)) gaps.push('model:');
        if (!EFFORT_RE.test(src)) gaps.push('effort:');
        if (!GOOD_FIRST_RE.test(src)) gaps.push('good first issue');
        return gaps.length ? `${rel}: missing ${gaps.join(', ')}` : null;
      })
      .filter(Boolean);
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
