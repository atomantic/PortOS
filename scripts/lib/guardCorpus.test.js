/**
 * The shared guard corpus (`scripts/lib/guardCorpus.js`, #16996) answers every
 * pathspec shape the structural checks use exactly as `git ls-files` does: same
 * paths, same order, same treatment of deleted, untracked, ignored and
 * non-file entries. A divergence would silently narrow every check built on it,
 * so the in-memory matcher is pinned here against git itself, on a fixture
 * repository small enough to list in milliseconds.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, createGuardCorpus, pathspecMatcher, readText } from './guardCorpus.js';
import { trackedFiles, workingTreeFiles } from './trackedFiles.js';

const FILES = [
  'AGENTS.md', 'CLAUDE.md', 'a.js', 'b.mjs', 'c.cjs', 'x.generated.json', 'root.test.js', '.env.example', '.gitignore',
  'server/AGENTS.md', 'server/a.js', 'server/lib/b.mjs', 'server/lib/c.cjs', 'server/lib/b.test.js',
  'server/lib/browserSuiteGate.test.js', 'server/lib/gone.js', 'server/routes/r.js', 'server/routes/r.test.js',
  'server/lib/aiToolkit/routes/t.js', 'server/cos-runner/index.js', 'server/test/guards/tests/x.test.js',
  'client/src/App.jsx', 'client/src/lib/x.js', 'client/src/x.test.jsx', 'client/src/AGENTS.md',
  'scripts/s.js', 'scripts/migrations/001-a.js', 'scripts/lib/l.js', 'scripts/lib/l.test.js',
  '.github/workflows/ci.yml', '.github/actions/a/action.yml', '.claude/skills/x.md', 'docs/x.md',
  'dir with space/f.js', 'weird[name].js', 'q1.js', 'q22.js',
];

// Every pathspec list a check passes today, plus the shapes the matcher claims to support.
const REPO_SPECS = [
  [], ['*.generated.json'], ['*.js', '*.jsx', '*.cjs', '*.mjs'], ['*.js', '*.mjs', '*.cjs'], ['*.js'],
  ['*.test.js', '*.test.jsx'], ['*.test.js'], ['client/src/*.js', 'client/src/*.jsx'], ['scripts/*.js'],
  ['scripts/migrations/*.js'], ['server/*.js', 'server/**/*.js'], ['server/**/*.js', 'server/**/*.mjs', 'scripts/**/*.js'],
  ['server/**/*.js', 'client/src/**/*.js', 'client/src/**/*.jsx'], ['AGENTS.md', '*/AGENTS.md'], ['*AGENTS.md', '*CLAUDE.md'],
  ['.claude'], ['.github/workflows', '.github/actions'], ['server/**/*.test.js', ':!server/lib/browserSuiteGate*.test.js', ':!server/test/guards'],
  ['.'], ['./server'], ['server/'], ['q?.js'], ['[aq]*.js'], ['weird[[]name].js'], [':(exclude)*.md'], ['dir with space'],
];
const SERVER_SPECS = [['*.js', '*.mjs', '*.cjs'], ['*.js', '*.mjs'], ['*.js'], ['routes', 'lib/aiToolkit/routes', 'cos-runner/index.js'], []];
const CLIENT_SPECS = [['src'], []];
// Shapes the matcher declines: the corpus must hand them to git rather than guess.
const UNSUPPORTED = [[':(glob)**/*.js'], [':(icase)agents.md'], ['../a.js'], ['weird\\[name].js'], ['[[:alpha:]]*.js']];

let root;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'portos-guard-corpus-'));
  for (const file of FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), file === '.gitignore' ? 'ignored/\n' : `// ${file}\n`);
  }
  git('init', '--quiet');
  git('add', '.');
  // A symlink index entry with no file behind it: the mode is reported, presence is not.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'AGENTS.md' }).toString().trim();
  git('update-index', '--add', '--cacheinfo', `120000,${blob},.claude/link`);
  rmSync(join(root, 'server/lib/gone.js'));
  for (const file of ['server/untracked.js', 'zz-untracked.js', 'ignored/x.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '// untracked\n');
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('guard corpus pathspec parity with git (#16996)', () => {
  it('lists tracked files exactly as trackedFiles() does', () => {
    const corpus = createGuardCorpus(root);
    for (const specs of REPO_SPECS) expect(corpus.tracked(specs), JSON.stringify(specs)).toEqual(trackedFiles(root, specs));
    for (const specs of SERVER_SPECS) {
      expect(corpus.tracked(specs, { cwd: join(root, 'server') }), `server ${JSON.stringify(specs)}`).toEqual(trackedFiles(join(root, 'server'), specs));
    }
    for (const specs of CLIENT_SPECS) {
      expect(corpus.tracked(specs, { cwd: join(root, 'client') }), `client ${JSON.stringify(specs)}`).toEqual(trackedFiles(join(root, 'client'), specs));
    }
  });

  it('lists the working tree exactly as workingTreeFiles() does', () => {
    const corpus = createGuardCorpus(root);
    for (const specs of [...REPO_SPECS.slice(0, 6), ['server/**/*.test.js', ':!server/lib/browserSuiteGate*.test.js'],
    ['server/**/*.test.js', ':!server/lib/browserSuiteGate*.test.js', ':!server/test/guards'], ['server', 'scripts', 'lib']]) {
      expect(corpus.workingTree(specs), JSON.stringify(specs)).toEqual(workingTreeFiles(root, specs));
    }
    expect(corpus.workingTree(['*.js'])).toContain('zz-untracked.js');
    expect(corpus.workingTree([])).not.toContain('ignored/x.js');
  });

  it('declines pathspec magic it cannot interpret and lets git answer', () => {
    for (const specs of UNSUPPORTED) expect(pathspecMatcher(specs), JSON.stringify(specs)).toBeNull();
    const corpus = createGuardCorpus(root);
    expect(corpus.tracked([':(glob)**/*.js'])).toEqual(trackedFiles(root, [':(glob)**/*.js']));
    expect(corpus.tracked(['../a.js'], { cwd: join(root, 'server') })).toEqual(trackedFiles(join(root, 'server'), ['../a.js']));
  });

  it('reports index entries and modes whether or not the file is on disk', () => {
    const corpus = createGuardCorpus(root);
    expect(corpus.indexed(['AGENTS.md'])).toEqual([{ path: 'AGENTS.md', mode: '100644' }]);
    expect(corpus.indexed(['zz-untracked.js'])).toEqual([]);
    expect(corpus.indexed(['server/lib']).map(({ path }) => path)).toContain('server/lib/gone.js');
    expect(corpus.tracked(['server/lib'])).not.toContain('server/lib/gone.js');
    expect(corpus.indexed(['.claude'])).toEqual([{ path: '.claude/link', mode: '120000' }, { path: '.claude/skills/x.md', mode: '100644' }]);
  });

  it('reads a file once and returns fresh arrays to every caller', () => {
    const corpus = createGuardCorpus(root);
    const first = corpus.read('a.js');
    writeFileSync(join(root, 'a.js'), '// changed\n');
    expect(corpus.read(join(root, 'a.js'))).toBe(first);
    expect(createGuardCorpus(root).read('a.js')).toBe('// changed\n');
    const listing = corpus.tracked(['*.js']);
    listing.length = 0;
    expect(corpus.tracked(['*.js']).length).toBeGreaterThan(0);
    expect(corpus.derive('kind', 'key', () => 1)).toBe(1);
    expect(corpus.derive('kind', 'key', () => 2)).toBe(1);
  });

  it('reports a path that descends through a file as absent', () => {
    expect(createGuardCorpus(REPO_ROOT).lstat('package.json/index.js')).toBeNull();
  });

  it('caches reads only inside this repository', () => {
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'one');
    expect(readText(outside)).toBe('one');
    writeFileSync(outside, 'two');
    expect(readText(outside)).toBe('two');
    expect(readText(join(REPO_ROOT, 'AGENTS.md'))).toBe(readText(join(REPO_ROOT, 'AGENTS.md')));
  });

  it('decodes an existing byte read without rereading the file', () => {
    const path = join(root, 'bytes.txt');
    const text = 'first café\n';
    writeFileSync(path, text);
    const corpus = createGuardCorpus(root);
    expect(corpus.bytes(path)).toEqual(Buffer.from(text));
    writeFileSync(path, 'second\n');
    expect(corpus.read('bytes.txt')).toBe(text);
  });
});
