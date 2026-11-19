import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PINNED_DB_IMAGE } from './lib/dbImage.js';
import { workflowJobs } from './lib/workflowJobs.js';
import {
  UNAVAILABLE_TARGETS,
  deriveTargets,
  loadTargets,
  markActionable,
  runCli,
  validateSbom,
  validateScan,
  verifyRun,
} from './runtime-image-security.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/runtime-image-security.yml');
const targets = loadTargets();

const sbomFor = (types, extra = {}) => ({
  descriptor: { name: 'syft', version: '1.55.0' },
  source: { type: 'image', metadata: { imageID: 'sha256:example' } },
  distro: { id: 'debian', versionID: '13' },
  artifacts: types.map((type, i) => ({ name: `pkg${i}`, version: '1.0', type })),
  ...extra,
});
const matchFor = (id, severity, name = 'libexample', version = '1.0', fix = { state: 'fixed', versions: ['1.1'] }) => ({
  vulnerability: { id, severity, fix },
  artifact: { name, version, type: 'deb' },
});
const scanFor = (matches) => ({
  descriptor: { name: 'grype', version: '0.121.0', db: { status: { valid: true, schemaVersion: 'v6.1.10', built: '2026-11-11T00:00:00Z' }, providers: {} } },
  source: { type: 'image', target: { imageID: 'sha256:example' } },
  matches,
});

describe('target derivation from the recipes', () => {
  it('reads the pinned digests the product recipes already guard, not a second copy', () => {
    expect(targets.pgvector.imageRef).toBe(PINNED_DB_IMAGE);
    expect(targets.supercollider.baseImage).toMatch(/^debian:trixie-\S+@sha256:[0-9a-f]{64}$/);
    expect(targets.supercollider.recipeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(targets.supercollider.architectures).toEqual(['amd64', 'arm64']);
    expect(targets['eidoverse-rapier'].recipeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(targets['eidoverse-rapier']).toMatchObject({ package: '@dimforge/rapier3d-compat', packageVersion: '0.14.0', declaredParent: 'eidoverse:render' });
  });

  it('refuses a recipe that loses its digest pin instead of scanning a moving tag', () => {
    const sources = {
      compose: read('docker-compose.yml'),
      supercolliderDockerfile: read('docker/supercollider/Dockerfile'),
      eidoverseDockerfile: read('docker/eidoverse-video/Dockerfile'),
      supercolliderRecipeFiles: [],
    };
    expect(() => deriveTargets({ ...sources, compose: sources.compose.replace(/@sha256:[0-9a-f]{64}/, '') })).toThrow('not pinned by sha256 digest');
    expect(() => deriveTargets({ ...sources, supercolliderDockerfile: sources.supercolliderDockerfile.replace(/(ARG DEBIAN_IMAGE=\S+)@sha256:\S+/, '$1') })).toThrow('not pinned by sha256 digest');
  });
});

describe('fail-closed evidence validation', () => {
  it('rejects an empty, foreign or ecosystem-incomplete SBOM', () => {
    expect(() => validateSbom({}, targets.pgvector)).toThrow('not a syft JSON document');
    expect(() => validateSbom(sbomFor([]), targets.pgvector)).toThrow('zero packages');
    expect(() => validateSbom(sbomFor(['npm']), targets.pgvector)).toThrow('no deb packages');
    expect(() => validateSbom(sbomFor(['deb'], { distro: undefined }), targets.pgvector)).toThrow('no OS distro');
    expect(validateSbom(sbomFor(['deb', 'npm']), targets.pgvector)).toMatchObject({ packageCount: 2, packageTypes: ['deb', 'npm'] });
    expect(validateSbom({ ...sbomFor(['npm']), distro: undefined }, targets['eidoverse-rapier']).packageCount).toBe(1);
  });

  it('never reads a missing or truncated scan as zero findings, but accepts a real zero-match result', () => {
    expect(() => validateScan(null)).toThrow('not a grype JSON document');
    expect(() => validateScan({ descriptor: { name: 'grype' } })).toThrow('not a grype JSON document');
    expect(() => validateScan(scanFor([{ vulnerability: {}, artifact: {} }]))).toThrow('without a vulnerability id');
    expect(validateScan(scanFor([])).findings).toEqual([]);
  });

  it('de-duplicates, buckets unknown severities and orders findings by severity', () => {
    const { counts, findings } = validateScan(scanFor([
      matchFor('CVE-2026-0002', 'Low'), matchFor('CVE-2026-0001', 'Critical'), matchFor('CVE-2026-0001', 'Critical'), matchFor('CVE-2026-0003', 'Weird'),
    ]));
    expect(counts).toMatchObject({ Critical: 1, Low: 1, Unknown: 1 });
    expect(findings.map((f) => f.id)).toEqual(['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-0003']);
  });

  it('names a pgvector newest-digest reference derived from the pin, and no other target has one', () => {
    expect(targets.pgvector.latestImageRef).toBe('pgvector/pgvector:pg17');
    expect(targets.supercollider.latestImageRef).toBeUndefined();
    expect(targets['eidoverse-rapier'].latestImageRef).toBeUndefined();
  });
});

describe('markActionable', () => {
  const findings = (...matches) => validateScan(scanFor(matches)).findings;
  const unfixed = { state: 'wont-fix', versions: [] };

  it('flags only High/Critical findings with a fix that the newest digest no longer carries', () => {
    const scanned = findings(
      matchFor('CVE-1', 'Critical', 'libfoo'),
      matchFor('CVE-2', 'High', 'libfoo'),
      matchFor('CVE-3', 'Medium', 'libfoo'),
      matchFor('CVE-4', 'High', 'libfoo', '1.0', unfixed),
      matchFor('CVE-5', 'High', 'libfoo'),
    );
    const latest = findings(matchFor('CVE-5', 'High', 'libfoo'), matchFor('CVE-4', 'High', 'libfoo', '1.0', unfixed));
    const marked = markActionable(scanned, latest);
    expect(marked.filter((f) => f.actionable).map((f) => f.id)).toEqual(['CVE-1', 'CVE-2']);
  });

  it('never flags anything without a newest-digest scan, because a fix alone does not prove the newest image has it', () => {
    expect(markActionable(findings(matchFor('CVE-1', 'Critical')), null).some((f) => f.actionable)).toBe(false);
  });

  it('matches the newest digest by advisory and package, so another package carrying the advisory stays actionable', () => {
    const marked = markActionable(findings(matchFor('CVE-1', 'High', 'libfoo')), findings(matchFor('CVE-1', 'High', 'libbar')));
    expect(marked[0].actionable).toBe(true);
  });
});

describe('verifyRun', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rts-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const run = (matches, extra = {}) => {
    const out = [];
    const code = verifyRun({
      target: 'pgvector', arch: 'arm64', sbomPath: write('sbom.json', sbomFor(['deb'])), scanPath: write('scan.json', scanFor(matches)),
      outDir: join(dir, 'out'), env: { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '7' }, imageId: 'sha256:abc', repoDigests: 'x@sha256:def', latest: { repoDigests: `pgvector/pgvector@${PINNED_DB_IMAGE.split('@')[1]}` }, summarize: (t) => out.push(t), annotate: () => {}, ...extra,
    });
    return { code, text: out.join('\n'), provenance: JSON.parse(readFileSync(join(dir, 'out/provenance.json'), 'utf8')) };
  };

  // pgvector must be given newest-digest evidence; the same-digest case needs no scan.
  const SAME = { repoDigests: `pgvector/pgvector@${PINNED_DB_IMAGE.split('@')[1]}` };
  const NEWER = { repoDigests: `pgvector/pgvector@sha256:${'9'.repeat(64)}` };
  const newerScan = (matches) => ({ ...NEWER, sbomPath: write('latest-sbom.json', sbomFor(['deb'])), scanPath: write('latest-scan.json', scanFor(matches)) });

  it('records provenance (image, digest, recipe, commit, architecture) and lists every finding without failing on it', () => {
    const { code, text, provenance } = run([matchFor('CVE-2026-1', 'High', 'libexample', '1.0', { state: 'wont-fix', versions: [] }), matchFor('CVE-2026-2', 'Negligible')], { strict: true, latest: SAME });
    expect(code).toBe(0);
    expect(provenance).toMatchObject({ target: 'pgvector', arch: 'arm64', gitSha: 'a'.repeat(40), recipe: { path: 'docker-compose.yml' }, ref: { image: PINNED_DB_IMAGE, imageId: 'sha256:abc', repoDigests: ['x@sha256:def'] }, scan: { counts: { High: 1, Negligible: 1 } }, latest: { newer: false } });
    expect(text).toContain('CVE-2026-1');
    expect(text).toContain('CVE-2026-2');
    expect(text).toContain('a pin bump cannot remove any finding');
    expect(JSON.parse(readFileSync(join(dir, 'out/findings.json'), 'utf8')).findings.every((f) => !f.actionable)).toBe(true);
  });

  it('passes when a fixed High finding is still present in the newest digest', () => {
    const matches = [matchFor('CVE-2026-1', 'High')];
    expect(run(matches, { strict: true, latest: newerScan(matches) }).code).toBe(0);
  });

  it('fails a strict run on a High/Critical finding the newest digest fixes, naming the image and the digest', () => {
    const errors = [];
    const { code, text } = run([matchFor('CVE-2026-1', 'Critical')], { strict: true, latest: newerScan([]), annotate: (t) => errors.push(t) });
    expect(code).toBe(3);
    expect(errors.join('\n')).toContain(PINNED_DB_IMAGE);
    expect(text).toContain(`sha256:${'9'.repeat(64)}`);
    expect(text).toContain('bump the pin');
  });

  it('only reports the same actionable finding outside strict mode (pull requests)', () => {
    expect(run([matchFor('CVE-2026-1', 'High')], { latest: newerScan([]), annotate: () => {} }).code).toBe(0);
  });

  it('fails closed when the newest digest differs but was not scanned, or when pgvector gets no newest-digest evidence', () => {
    expect(() => run([], { latest: NEWER })).toThrow('was not scanned');
    expect(() => run([], { latest: null })).toThrow('needs the newest-digest evidence');
    expect(() => run([], { latest: newerScan([]), scanPath: write('s2.json', scanFor([])) , target: 'supercollider', arch: 'amd64' })).toThrow('no newest-digest reference');
  });

  it('rejects an empty SBOM for the newest digest', () => {
    const latest = { ...NEWER, sbomPath: write('empty.json', sbomFor([])), scanPath: write('empty-scan.json', scanFor([])) };
    expect(() => run([], { latest })).toThrow('zero packages');
  });

  it('rejects an unsupported architecture and invalid scanner output', () => {
    expect(() => run([], { arch: 'riscv64' })).toThrow('not scanned for architecture');
    expect(() => run([], { scanPath: write('bad.json', { matches: [] }) })).toThrow('not a grype JSON document');
  });

  it('refuses zero-match results without a usable database or the supplied SBOM source', () => {
    const bare = { descriptor: { name: 'grype', version: '0.121.0' }, matches: [] };
    expect(() => run([], { scanPath: write('bare.json', bare) })).toThrow('no usable vulnerability database');
    const badDb = scanFor([]);
    badDb.descriptor.db.status.valid = false;
    expect(() => run([], { scanPath: write('db.json', badDb) })).toThrow('no usable vulnerability database');
    const olderScan = scanFor([]);
    olderScan.descriptor.db = olderScan.descriptor.db.status;
    expect(run([], { scanPath: write('older-db.json', olderScan) }).code).toBe(0);
    const unrelated = scanFor([]);
    unrelated.source.target.imageID = 'sha256:another-image';
    expect(() => run([], { scanPath: write('unrelated.json', unrelated) })).toThrow('does not match the supplied SBOM');
    expect(run([]).code).toBe(0);
  });

  it('binds an npm-pin scan to the SBOM directory source too', () => {
    const source = '/scanner/rapier';
    const sbom = sbomFor(['npm'], { source: { type: 'directory', metadata: { path: source } } });
    const scan = { ...scanFor([]), source: { type: 'directory', target: source } };
    expect(verifyRun({ target: 'eidoverse-rapier', arch: 'any', sbomPath: write('npm-sbom.json', sbom),
      scanPath: write('npm-scan.json', scan), outDir: join(dir, 'out'), summarize: () => {} })).toBe(0);
    scan.source.target = '/scanner/other';
    expect(() => verifyRun({ target: 'eidoverse-rapier', arch: 'any', sbomPath: write('npm-sbom.json', sbom),
      scanPath: write('npm-scan.json', scan), outDir: join(dir, 'out'), summarize: () => {} })).toThrow('does not match the supplied SBOM');
  });
});

describe('uncovered inputs are reported, never faked', () => {
  it('names the external renderer parent with its owning project and writes a machine-readable gap', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'rts-')), 'gap');
    const summary = join(out, '..', 'summary.md');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(runCli(['unavailable', '--out', out], { GITHUB_SHA: 'b'.repeat(40), GITHUB_STEP_SUMMARY: summary })).toBe(0);
    stdout.mockRestore();
    const gap = JSON.parse(readFileSync(join(out, 'eidoverse-render-parent.unavailable.json'), 'utf8'));
    expect(gap).toMatchObject({ status: 'unavailable', owner: 'anima-research/eidoverse-video', gitSha: 'b'.repeat(40) });
    expect(readFileSync(summary, 'utf8')).toContain('not zero findings');
    expect(UNAVAILABLE_TARGETS.map((t) => t.recipe)).toEqual(['docker/eidoverse-video/Dockerfile']);
    rmSync(join(out, '..'), { recursive: true, force: true });
  });
});

describe('workflow contract', () => {
  const jobs = workflowJobs(workflow);

  it('is independent of the required CI Gate and never runs privileged PR code', () => {
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toMatch(/(?:contents|actions|packages): write/);
    expect(read('.github/workflows/ci.yml')).not.toContain('runtime-image-security');
    for (const trigger of ['schedule:', 'workflow_dispatch:', 'pull_request:', '- docker/**', '- docker-compose.yml']) expect(workflow).toContain(trigger);
  });

  it('pins every action by full commit SHA and every scanner binary by version and archive checksum', () => {
    for (const [, ref] of workflow.matchAll(/uses:\s*(\S+)/g)) expect(ref).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow).toMatch(/SYFT_VERSION: \d+\.\d+\.\d+/);
    expect(workflow).toMatch(/GRYPE_VERSION: \d+\.\d+\.\d+/);
    const sums = [...workflow.matchAll(/(?:SYFT|GRYPE)_SHA256_(?:AMD64|ARM64): (\S+)/g)].map((m) => m[1]);
    expect(sums).toHaveLength(4);
    for (const sum of sums) expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(jobs.scan).toContain('sha256sum -c -');
  });

  it('scans every derived target on each supported architecture, on a runner of that architecture', () => {
    const included = [...workflow.matchAll(/\{ target: (\S+), arch: (\S+), runner: (\S+) \}/g)].map(([, target, arch, runner]) => ({ target, arch, runner }));
    for (const target of Object.values(targets)) {
      expect(included.filter((row) => row.target === target.id).map((row) => row.arch).sort()).toEqual([...target.architectures].sort());
    }
    for (const row of included.filter((r) => r.arch === 'arm64')) expect(row.runner).toBe('ubuntu-24.04-arm');
  });

  it('fails on scanner errors, validates before upload, and keeps the actionable-finding gate strict only off pull requests', () => {
    expect(workflow).toContain('node scripts/ci-dependabot-admission.js');
    expect(jobs.scan).not.toContain('continue-on-error');
    expect(jobs.scan).not.toContain('|| true');
    expect(jobs.scan).toContain('[ "$GITHUB_EVENT_NAME" != pull_request ] && args+=(--strict)');
    expect(jobs.scan).toContain('--latest-digests');
    expect(workflow).not.toContain('reviews.json');
    expect(jobs.scan.indexOf('Validate evidence and record provenance')).toBeLessThan(jobs.scan.indexOf('Save SBOM, scan and provenance'));
    expect(jobs.scan).toContain('if: always()');
    expect(jobs.unavailable).toContain('runtime-image-security.js unavailable');
  });
});

describe('Dependabot digest updates', () => {
  const dependabot = read('.github/dependabot.yml');
  const entry = (ecosystem) => dependabot.split(/^ {2}- package-ecosystem: /m).find((block) => block.startsWith(`${ecosystem}\n`));

  it('updates the compose pin at the repository root and every docker/ recipe weekly', () => {
    expect(entry('docker-compose')).toMatch(/directory: \/\n/);
    expect(entry('docker-compose')).toMatch(/interval: weekly/);
    expect(entry('docker')).toMatch(/directories:\n\s+- \/docker\/\*\n/);
    expect(entry('docker')).toMatch(/interval: weekly/);
  });

  it('points at directories that exist and hold the pinned recipes', () => {
    expect(read('docker-compose.yml')).toContain('pgvector/pgvector:');
    for (const dir of ['supercollider', 'eidoverse-video']) expect(read(`docker/${dir}/Dockerfile`)).toContain('FROM ');
  });
});
