import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NAV_COMMANDS } from '../../../lib/navManifest.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

// #7419 repeated the #7414 hand-sweep — a SECOND breadcrumb split into runtimes
// no LOCAL_RUNTIMES row was in scope for (fleetLlmHost.js, the Persistent Mind
// recommenders, llamaServerManager.js, the playground back-link). Each of those
// now resolves its page from `getNavPageForPath`/`expandPageToken` instead of a
// literal, so this scans the whole server+client tree for the next one typed by
// hand — a net, not a proof: a lexer-assisted line scan, not an AST pass.
describe('shipped copy names a Models page by route, never by literal (#7419)', () => {

  const MODELS_TAB_LABELS = [...new Set(
    NAV_COMMANDS.filter((c) => c.section === 'Models' && c.label).map((c) => c.label),
  )];

  // Longest-first so "Abuse Guard" cannot be shadowed by a shorter overlapping
  // label (none currently overlap, but a future label might).
  const BREADCRUMB_PATTERN = new RegExp(
    `Models\\s*→\\s*(${MODELS_TAB_LABELS.slice().sort((a, b) => b.length - a.length)
      .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'g',
  );

  // Deliberate weights-catalog references #7419 leaves alone: the LLMs page
  // they name has not moved, and rewriting them buys nothing a literal
  // "Models → LLMs" doesn't already say correctly.
  const ALLOWLISTED_FILES = new Set([
    'server/lib/navManifest.js',
  ]);

  /**
   * Blank every comment — `//…`, `/* … *\/`, and the `{/* … *\/}` JSX form,
   * which is the same block-comment syntax wrapped in a brace — while leaving
   * string/template literals and JSX text untouched, so a hardcoded breadcrumb
   * SHIPPED to a user still matches. Line-based and conservative: once a line
   * opens a block comment it blanks every line through the one that closes it,
   * so a rule merely DESCRIBED across a JSDoc block can't trip the guard.
   */
  function blankBlockComments(src) {
    let inBlock = false;
    return src.split('\n').map((line) => {
      if (inBlock) {
        if (line.includes('*/')) inBlock = false;
        return '';
      }
      if (/^\s*\/\//.test(line)) return '';
      if (/^\s*(\/\*|\{\/\*)/.test(line)) {
        if (!line.includes('*/')) inBlock = true;
        return '';
      }
      return line;
    }).join('\n');
  }

  function breadcrumbOffenders(src) {
    const code = blankBlockComments(src);
    return [...code.matchAll(BREADCRUMB_PATTERN)].map((match) => match[0]);
  }

  const trackedSources = (repoRoot = REPO_ROOT) => trackedFiles(repoRoot, [
    'server/**/*.js', 'client/src/**/*.js', 'client/src/**/*.jsx',
  ]).filter((f) => !f.includes('.test.'));

  const scanBreadcrumbs = (repoRoot = REPO_ROOT, readSource = readText) => trackedSources(repoRoot)
    .filter((file) => !ALLOWLISTED_FILES.has(file))
    .flatMap((file) => breadcrumbOffenders(readSource(join(repoRoot, file), 'utf8')).map((text) => `${file}: ${text}`));

  let fixture;
  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  });

  function sourceFixture() {
    fixture = mkdtempSync(join(tmpdir(), 'breadcrumb-scan-'));
    mkdirSync(join(fixture, 'client/src/components'), { recursive: true });
    writeFileSync(join(fixture, 'client/src/components/deleted.jsx'), 'export default null;');
    writeFileSync(join(fixture, 'client/src/components/present source.jsx'), 'const msg = "Start it from Models → Runtimes.";');
    execFileSync('git', ['init', '--quiet'], { cwd: fixture });
    execFileSync('git', ['add', '.'], { cwd: fixture });
    unlinkSync(join(fixture, 'client/src/components/deleted.jsx'));
    return fixture;
  }

  it('scans present sources after an unstaged deletion and still detects prohibited copy', () => {
    const root = sourceFixture();
    expect(execFileSync('git', ['ls-files', '--deleted'], { cwd: root, encoding: 'utf8' }))
      .toContain('client/src/components/deleted.jsx');
    expect(scanBreadcrumbs(root)).toEqual(['client/src/components/present source.jsx: Models → Runtimes']);
    writeFileSync(join(root, 'client/src/components/present source.jsx'), 'const msg = "Open Models → Abuse Guard to repair it.";');
    expect(scanBreadcrumbs(root)).toEqual(['client/src/components/present source.jsx: Models → Abuse Guard']);
  });

  it('propagates read failures for a present tracked source', () => {
    const root = sourceFixture();
    const denied = Object.assign(new Error('source read denied'), { code: 'EACCES' });
    expect(() => scanBreadcrumbs(root, () => { throw denied; })).toThrow(denied);
    unlinkSync(join(root, 'client/src/components/present source.jsx'));
    mkdirSync(join(root, 'client/src/components/present source.jsx'));
    expect(() => scanBreadcrumbs(root)).toThrow();
  });

  it('scans the whole tree', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise let
    // every assertion below pass by scanning nothing at all.
    expect(trackedSources().length).toBeGreaterThan(800);
  });

  it('recognizes a real hardcoded breadcrumb as an offense', () => {
    // Proves the extractor still catches a violation — without this the scan
    // below could go vacuously green after a regex/comment-blanking regression.
    expect(breadcrumbOffenders('const msg = "Start it from Models → Runtimes.";')).toEqual(['Models → Runtimes']);
  });

  it('recognizes the current Abuse Guard breadcrumb as a route-derived-copy violation', () => {
    expect(breadcrumbOffenders('const msg = "Open Models → Abuse Guard to repair it.";')).toEqual(['Models → Abuse Guard']);
  });

  it('flags a hardcoded breadcrumb outside the allowlist', () => {
    const offenders = scanBreadcrumbs();
    expect(offenders).toEqual([]);
  });
});
