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
  reconcileFindings,
  runCli,
  validateReviews,
  validateSbom,
  validateScan,
  verifyRun,
} from './runtime-image-security.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/runtime-image-security.yml');
const targets = loadTargets();

const sbomFor = (types, extra = {}) => ({
  descriptor: { name: 'syft', version: '1.55.0' },
  distro: { id: 'debian', versionID: '13' },
  artifacts: types.map((type, i) => ({ name: `pkg${i}`, version: '1.0', type })),
  ...extra,
});
const matchFor = (id, severity, name = 'libexample', version = '1.0') => ({
  vulnerability: { id, severity, fix: { state: 'fixed', versions: ['1.1'] } },
  artifact: { name, version, type: 'deb' },
});
const scanFor = (matches) => ({ descriptor: { name: 'grype', version: '0.121.0' }, matches });

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

  it('requires rationale and a tracker reference for every reviewed disposition', () => {
    expect(validateReviews({ schema: 1, reviews: [] })).toEqual([]);
    expect(() => validateReviews({ schema: 1, reviews: [{ target: 'pgvector', id: 'CVE-1', disposition: 'blocked', rationale: 'x' }] })).toThrow('needs rationale and tracking');
    expect(() => validateReviews({ schema: 1, reviews: [{ target: 'pgvector', id: 'CVE-1', disposition: 'fixed', rationale: 'x', tracking: '#1' }] })).toThrow('disposition must be one of');
    expect(() => validateReviews({ reviews: [] })).toThrow('expected');
    expect(() => validateReviews(JSON.parse(read('docker/runtime-image-security.reviews.json')))).not.toThrow();
  });

  it('keeps the shipped ledger unambiguous: a derived target, a pinned package version and a tracker reference per entry', () => {
    const reviews = validateReviews(JSON.parse(read('docker/runtime-image-security.reviews.json')));
    const keys = reviews.map((r) => `${r.target}|${r.id}|${r.package}|${r.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const review of reviews) {
      expect(Object.keys(targets)).toContain(review.target);
      expect(review.package && review.version).toBeTruthy();
      expect(review.tracking).toMatch(/^#\d+$/);
    }
  });

  it('scopes a review to its target and, when named, its package, installed version and architecture', () => {
    const findings = validateScan(scanFor([matchFor('CVE-1', 'High', 'libfoo', '1.0'), matchFor('CVE-1', 'High', 'libbar'), matchFor('CVE-1', 'High', 'libfoo', '2.0')])).findings;
    const reviews = [{ target: 'pgvector', id: 'CVE-1', package: 'libfoo', version: '1.0', arch: 'amd64', disposition: 'blocked', rationale: 'no upstream fix', tracking: '#9' }];
    const split = reconcileFindings(findings, reviews, 'pgvector', 'amd64');
    expect(split.reviewed.map((f) => `${f.package}@${f.version}`)).toEqual(['libfoo@1.0']);
    expect(split.unreviewed.map((f) => `${f.package}@${f.version}`).sort()).toEqual(['libbar@1.0', 'libfoo@2.0']);
    expect(reconcileFindings(findings, reviews, 'pgvector', 'arm64').reviewed).toEqual([]);
    expect(reconcileFindings(findings, reviews, 'supercollider', 'amd64').reviewed).toEqual([]);
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
      outDir: join(dir, 'out'), env: { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '7' }, imageId: 'sha256:abc', repoDigests: 'x@sha256:def', summarize: (t) => out.push(t), ...extra,
    });
    return { code, text: out.join('\n'), provenance: JSON.parse(readFileSync(join(dir, 'out/provenance.json'), 'utf8')) };
  };

  it('records provenance (image, digest, recipe, commit, architecture) and tolerates findings outside strict mode', () => {
    const { code, text, provenance } = run([matchFor('CVE-2026-1', 'High')]);
    expect(code).toBe(0);
    expect(provenance).toMatchObject({ target: 'pgvector', arch: 'arm64', gitSha: 'a'.repeat(40), recipe: { path: 'docker-compose.yml' }, ref: { image: PINNED_DB_IMAGE, imageId: 'sha256:abc', repoDigests: ['x@sha256:def'] }, scan: { counts: { High: 1 } } });
    expect(text).toContain('CVE-2026-1');
  });

  it('fails strict runs on unreviewed findings and passes once each is reviewed with a tracker reference', () => {
    expect(run([matchFor('CVE-2026-1', 'Low')], { strict: true }).code).toBe(3);
    const reviewLedger = { schema: 1, reviews: [{ target: 'pgvector', id: 'CVE-2026-1', disposition: 'blocked', rationale: 'No patched Debian build yet', tracking: '#1' }] };
    expect(run([matchFor('CVE-2026-1', 'Low')], { strict: true, reviewLedger }).code).toBe(0);
  });

  it('rejects an unsupported architecture and invalid scanner output', () => {
    expect(() => run([], { arch: 'riscv64' })).toThrow('not scanned for architecture');
    expect(() => run([], { scanPath: write('bad.json', { matches: [] }) })).toThrow('not a grype JSON document');
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

  it('fails on scanner errors, validates before upload, and keeps findings strict only off pull requests', () => {
    expect(workflow).toContain('node scripts/ci-dependabot-admission.js');
    expect(jobs.scan).not.toContain('continue-on-error');
    expect(jobs.scan).not.toContain('|| true');
    expect(jobs.scan).toContain('[ "$GITHUB_EVENT_NAME" != pull_request ] && args+=(--strict)');
    expect(jobs.scan.indexOf('Validate evidence and record provenance')).toBeLessThan(jobs.scan.indexOf('Save SBOM, scan and provenance'));
    expect(jobs.scan).toContain('if: always()');
    expect(jobs.unavailable).toContain('runtime-image-security.js unavailable');
  });
});
