#!/usr/bin/env node
/**
 * Evidence helper for .github/workflows/runtime-image-security.yml: SBOM +
 * vulnerability inventories for the pinned runtime container images (#15656).
 *
 *   node scripts/runtime-image-security.js describe <target>          # KEY=value lines for $GITHUB_ENV
 *   node scripts/runtime-image-security.js build supercollider        # docker build, product argv + labels
 *   node scripts/runtime-image-security.js rapier-project <dir>       # package.json for the inline npm pin
 *   node scripts/runtime-image-security.js verify --target <id> --arch <arch> --sbom <f> --scan <f> --out <dir> [--strict]
 *   node scripts/runtime-image-security.js unavailable --out <dir>    # report targets this checkout cannot scan
 *
 * Targets are derived from the recipes themselves (docker-compose.yml,
 * docker/*), never a second copy of a digest, so a recipe edit moves the scan
 * with it and a recipe that loses its digest pin fails here. `verify` treats a
 * malformed, empty or partial scanner output as a failure: a scanner that did
 * not run is never reported as zero findings.
 *
 * Builtins only (plus the pure supercollider runtime constants), so it runs on
 * a bare runner checkout with no `npm ci`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SUPERCOLLIDER_IMAGE,
  SUPERCOLLIDER_RECIPE_DIR,
  SUPERCOLLIDER_SUPPORTED_ARCHITECTURES,
  buildSuperColliderBuildArgs,
  hashSuperColliderRecipe,
} from '../server/lib/superColliderRuntime.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const COMPOSE_PATH = 'docker-compose.yml';
export const EIDOVERSE_RECIPE_PATH = 'docker/eidoverse-video/Dockerfile';
export const REVIEWS_PATH = 'docker/runtime-image-security.reviews.json';
export const EVIDENCE_SCHEMA = 1;

const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown'];
// A fix removes the finding from the scan, so "fixed" is not a disposition: a finding still detected is never suppressed by one.
const DISPOSITIONS = ['not-reachable', 'blocked'];

/** Targets this checkout cannot scan, reported instead of faked (acceptance: "explicitly unavailable"). */
export const UNAVAILABLE_TARGETS = Object.freeze([{
  id: 'eidoverse-render-parent',
  recipe: EIDOVERSE_RECIPE_PATH,
  subject: '`eidoverse:render` parent image and the `deno.json`/`deno.lock` build context',
  reason: 'The parent image is built from the independent eidoverse-video checkout and its Deno/npm lock lives in that external build context; neither ships in this repository, so no image or lock digest can be inventoried here.',
  owner: 'anima-research/eidoverse-video',
  nextStep: 'Obtain the pinned parent image digest and deno.lock from the owning build and scan them there (or feed them in as a new target); the opt-in "Eidoverse real acceptance" workflow builds the pair but is functional evidence, not a security inventory.',
}]);

const lineValue = (text, re, label, recipe) => {
  const match = text.match(re);
  if (!match) throw new Error(`${recipe}: could not find ${label}`);
  return match;
};

/**
 * Derive every scan target from the recipe sources.
 * @param {{compose: string, supercolliderDockerfile: string, eidoverseDockerfile: string, supercolliderRecipeFiles: {name: string, content: string}[]}} sources
 */
export function deriveTargets({ compose, supercolliderDockerfile, eidoverseDockerfile, supercolliderRecipeFiles }) {
  const [, pgvectorRef] = lineValue(compose, /^\s*image:\s*(pgvector\/pgvector:\S+)\s*$/m, 'the pgvector image', COMPOSE_PATH);
  if (!DIGEST_RE.test(pgvectorRef)) throw new Error(`${COMPOSE_PATH}: ${pgvectorRef} is not pinned by sha256 digest`);

  const scDockerfilePath = `${SUPERCOLLIDER_RECIPE_DIR}/Dockerfile`;
  const [, debianImage] = lineValue(supercolliderDockerfile, /^ARG DEBIAN_IMAGE=(\S+)\s*$/m, 'ARG DEBIAN_IMAGE', scDockerfilePath);
  if (!DIGEST_RE.test(debianImage)) throw new Error(`${scDockerfilePath}: ${debianImage} is not pinned by sha256 digest`);
  const [, snapshot] = lineValue(supercolliderDockerfile, /^ARG DEBIAN_SNAPSHOT=(\S+)\s*$/m, 'ARG DEBIAN_SNAPSHOT', scDockerfilePath);
  const [, scVersion] = lineValue(supercolliderDockerfile, /^ARG SC_VERSION=(\S+)\s*$/m, 'ARG SC_VERSION', scDockerfilePath);

  const [, parent] = lineValue(eidoverseDockerfile, /^FROM\s+(\S+)/m, 'the FROM parent', EIDOVERSE_RECIPE_PATH);
  const [, rapierName, rapierVersion] = lineValue(eidoverseDockerfile, /\bnpm:(@[^\s@/]+\/[^\s@]+|[^\s@/]+)@(\d[^\s]*)/, 'the inline npm pin', EIDOVERSE_RECIPE_PATH);

  return {
    pgvector: {
      id: 'pgvector',
      kind: 'image',
      architectures: ['amd64', 'arm64'],
      recipe: COMPOSE_PATH,
      imageRef: pgvectorRef,
      expectedPackageTypes: ['deb'],
    },
    supercollider: {
      id: 'supercollider',
      kind: 'image',
      architectures: [...SUPERCOLLIDER_SUPPORTED_ARCHITECTURES],
      recipe: SUPERCOLLIDER_RECIPE_DIR,
      recipeHash: hashSuperColliderRecipe(supercolliderRecipeFiles),
      imageRef: SUPERCOLLIDER_IMAGE,
      baseImage: debianImage,
      debianSnapshot: snapshot,
      sourceVersion: scVersion,
      expectedPackageTypes: ['deb'],
    },
    'eidoverse-rapier': {
      id: 'eidoverse-rapier',
      kind: 'npm-pin',
      architectures: ['any'],
      recipe: EIDOVERSE_RECIPE_PATH,
      // The pin is the identity, but a Dockerfile edit around it (e.g. the lock context) still stales the evidence.
      recipeHash: createHash('sha256').update(eidoverseDockerfile.replace(/\r\n?/g, '\n')).digest('hex'),
      package: rapierName,
      packageVersion: rapierVersion,
      declaredParent: parent,
      expectedPackageTypes: ['npm'],
    },
  };
}

export function loadTargets(root = REPO_ROOT) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const scDir = join(root, SUPERCOLLIDER_RECIPE_DIR);
  const supercolliderRecipeFiles = readdirSync(scDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, content: readFileSync(join(scDir, entry.name), 'utf8') }));
  return deriveTargets({
    compose: read(COMPOSE_PATH),
    supercolliderDockerfile: read(`${SUPERCOLLIDER_RECIPE_DIR}/Dockerfile`),
    eidoverseDockerfile: read(EIDOVERSE_RECIPE_PATH),
    supercolliderRecipeFiles,
  });
}

/** Throws unless the SBOM is a non-empty syft document covering the target's expected package ecosystems. */
export function validateSbom(sbom, target) {
  if (sbom?.descriptor?.name !== 'syft' || !Array.isArray(sbom.artifacts)) {
    throw new Error('SBOM is not a syft JSON document (missing descriptor or artifacts)');
  }
  if (sbom.artifacts.length === 0) throw new Error('SBOM lists zero packages; an empty inventory is a scanner failure, not a clean image');
  const types = [...new Set(sbom.artifacts.map((artifact) => artifact.type))].sort();
  for (const expected of target.expectedPackageTypes) {
    if (!types.includes(expected)) throw new Error(`SBOM has no ${expected} packages (found: ${types.join(', ') || 'none'}); the ${expected} inventory is missing`);
  }
  if (target.kind === 'image' && !sbom.distro?.id) throw new Error('SBOM carries no OS distro, so OS package advisories cannot be matched');
  return { packageCount: sbom.artifacts.length, packageTypes: types, syftVersion: sbom.descriptor.version ?? null, distro: sbom.distro ? `${sbom.distro.id} ${sbom.distro.versionID ?? sbom.distro.version ?? ''}`.trim() : null };
}

/** Throws unless the document is a grype JSON result; returns severity counts and de-duplicated findings. */
export function validateScan(scan, sbom = null) {
  if (scan?.descriptor?.name !== 'grype' || !Array.isArray(scan.matches)) {
    throw new Error('Scan result is not a grype JSON document (missing descriptor or matches)');
  }
  // Grype 0.121 wraps ProviderStatus in db.status; older reports expose it
  // directly. A descriptor alone does not prove a usable DB ran.
  const db = scan.descriptor.db?.status ?? scan.descriptor.db;
  if (db?.valid !== true || !db.schemaVersion || !Number.isFinite(Date.parse(db.built))) {
    throw new Error('Scan result has no usable vulnerability database');
  }
  const source = scan.source;
  if (!source?.type || !source.target) throw new Error('Scan result has no source identity');
  if (sbom) {
    // Grype preserves the Syft SBOM source (syft_sbom_provider.go), exposing
    // image metadata as target and directory metadata as the path string.
    const metadata = sbom.source?.metadata;
    const matchesSource = source.type === sbom.source?.type && (
      source.type === 'image' ? typeof metadata?.imageID === 'string' && metadata.imageID.length > 0 && source.target.imageID === metadata.imageID
        : source.type === 'directory' && typeof metadata?.path === 'string' && metadata.path.length > 0 && source.target === metadata.path
    );
    if (!matchesSource) throw new Error('Scan result source does not match the supplied SBOM');
  }
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  const seen = new Set();
  const findings = [];
  for (const match of scan.matches) {
    const id = match?.vulnerability?.id;
    const artifact = match?.artifact;
    if (!id || !artifact?.name) throw new Error('Scan result contains a match without a vulnerability id or package');
    const key = `${id}|${artifact.name}|${artifact.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const severity = SEVERITIES.includes(match.vulnerability.severity) ? match.vulnerability.severity : 'Unknown';
    counts[severity] += 1;
    findings.push({
      id,
      severity,
      package: artifact.name,
      version: artifact.version ?? null,
      type: artifact.type ?? null,
      fixState: match.vulnerability.fix?.state ?? null,
      fixedIn: match.vulnerability.fix?.versions ?? [],
    });
  }
  const severityRank = (f) => SEVERITIES.indexOf(f.severity);
  findings.sort((a, b) => severityRank(a) - severityRank(b) || a.id.localeCompare(b.id) || a.package.localeCompare(b.package));
  return { counts, findings, grypeVersion: scan.descriptor.version ?? null, db: scan.descriptor.db ?? null };
}

/** Throws on a malformed review ledger; every disposition needs rationale and a tracker/PR reference. */
export function validateReviews(doc) {
  if (doc?.schema !== EVIDENCE_SCHEMA || !Array.isArray(doc.reviews)) throw new Error(`${REVIEWS_PATH}: expected { schema: ${EVIDENCE_SCHEMA}, reviews: [] }`);
  for (const review of doc.reviews) {
    const where = `${REVIEWS_PATH}: review ${review?.target}/${review?.id}`;
    if (!review?.target || !review?.id) throw new Error(`${where} needs target and id`);
    if (!DISPOSITIONS.includes(review.disposition)) throw new Error(`${where} disposition must be one of ${DISPOSITIONS.join(', ')}`);
    if (!review.rationale || !review.tracking) throw new Error(`${where} needs rationale and tracking (issue/PR reference)`);
  }
  return doc.reviews;
}

/**
 * Split findings into those covered by a reviewed disposition and those still
 * unreviewed. A review is scoped to its target and advisory, and to the package,
 * installed version and architecture whenever it names them, so a changed
 * package version or another architecture's finding is re-reviewed.
 */
export function reconcileFindings(findings, reviews, targetId, arch = null) {
  const mine = reviews.filter((review) => review.target === targetId);
  const reviewFor = (finding) => mine.find((review) => review.id === finding.id
    && (!review.package || review.package === finding.package)
    && (!review.version || review.version === finding.version)
    && (!review.arch || review.arch === arch));
  const reviewed = [];
  const unreviewed = [];
  for (const finding of findings) {
    const review = reviewFor(finding);
    if (review) reviewed.push({ ...finding, disposition: review.disposition, tracking: review.tracking });
    else unreviewed.push(finding);
  }
  return { reviewed, unreviewed };
}

const MAX_SUMMARY_ROWS = 40;

export function renderSummary({ provenance, counts, unreviewed, reviewedCount }) {
  const { target, arch, ref, sbom } = provenance;
  const lines = [
    `### Runtime image security: ${target} (${arch})`,
    '',
    `- Subject: \`${ref.image ?? ref.package}\`${ref.imageId ? ` (image ID \`${ref.imageId}\`)` : ''}`,
    `- Recipe: \`${provenance.recipe.path}\`${provenance.recipe.sha256 ? ` (recipe sha256 \`${provenance.recipe.sha256.slice(0, 12)}\`)` : ''}; commit \`${String(provenance.gitSha).slice(0, 12)}\``,
    `- SBOM: ${sbom.packageCount} packages (${sbom.packageTypes.join(', ')}); syft ${sbom.syftVersion}${sbom.distro ? `; ${sbom.distro}` : ''}`,
    `- Findings: ${SEVERITIES.map((severity) => `${severity} ${counts[severity]}`).join(', ')}; ${reviewedCount} reviewed, ${unreviewed.length} unreviewed`,
    '',
  ];
  if (unreviewed.length) {
    lines.push('| Severity | Advisory | Package | Installed | Fix |', '| --- | --- | --- | --- | --- |');
    for (const finding of unreviewed.slice(0, MAX_SUMMARY_ROWS)) {
      lines.push(`| ${finding.severity} | ${finding.id} | ${finding.package} | ${finding.version ?? ''} | ${finding.fixedIn.join(', ') || finding.fixState || ''} |`);
    }
    if (unreviewed.length > MAX_SUMMARY_ROWS) lines.push('', `${unreviewed.length - MAX_SUMMARY_ROWS} more in the uploaded findings.json.`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderUnavailable(entry) {
  return [
    `### Runtime image security: ${entry.id} UNAVAILABLE`,
    '',
    `- Not scanned: ${entry.subject} (recipe \`${entry.recipe}\`).`,
    `- Why: ${entry.reason}`,
    `- Owning project: ${entry.owner}.`,
    `- Next step: ${entry.nextStep}`,
    '- This is a coverage gap, not zero findings.',
    '',
  ].join('\n');
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Validate one scanner run and write its provenance + findings. Returns the exit
 * code: 0 recorded, 3 strict and unreviewed findings remain. Invalid evidence throws.
 */
export function verifyRun({ target, arch, sbomPath, scanPath, outDir, strict = false, env = process.env, root = REPO_ROOT, dbStatusPath = null, imageId = null, repoDigests = null, reviewLedger = null, summarize = (text) => process.stdout.write(`${text}\n`) }) {
  const def = loadTargets(root)[target];
  if (!def) throw new Error(`Unknown target: ${target}`);
  if (!def.architectures.includes(arch)) throw new Error(`${target} is not scanned for architecture ${arch}`);
  const sbomDocument = readJson(sbomPath);
  const sbom = validateSbom(sbomDocument, def);
  const scan = validateScan(readJson(scanPath), sbomDocument);
  const reviews = validateReviews(reviewLedger ?? readJson(join(root, REVIEWS_PATH)));
  const { reviewed, unreviewed } = reconcileFindings(scan.findings, reviews, target, arch);

  const provenance = {
    schema: EVIDENCE_SCHEMA,
    target,
    arch,
    gitSha: env.GITHUB_SHA ?? null,
    runId: env.GITHUB_RUN_ID ?? null,
    generatedAt: new Date().toISOString(),
    ref: def.kind === 'image'
      ? { image: def.imageRef, imageId, repoDigests: repoDigests ? repoDigests.split(',').filter(Boolean) : [], baseImage: def.baseImage ?? null }
      : { package: `${def.package}@${def.packageVersion}` },
    recipe: { path: def.recipe, sha256: def.recipeHash ?? null, debianSnapshot: def.debianSnapshot ?? null },
    sbom,
    scan: { grypeVersion: scan.grypeVersion, db: scan.db, dbStatus: dbStatusPath ? readJson(dbStatusPath) : null, counts: scan.counts },
    scope: def.kind === 'npm-pin'
      ? `Inline ${def.package}@${def.packageVersion} npm pin resolved from the registry at scan time; does not cover the eidoverse:render parent or its deno.lock.`
      : 'Every OS package and library in the built image.',
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(join(outDir, 'findings.json'), `${JSON.stringify({ schema: EVIDENCE_SCHEMA, target, arch, reviewed, unreviewed }, null, 2)}\n`);
  summarize(renderSummary({ provenance, counts: scan.counts, unreviewed, reviewedCount: reviewed.length }));
  return strict && unreviewed.length > 0 ? 3 : 0;
}

const parseFlags = (argv) => {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    if (name === 'strict') flags.strict = true;
    else flags[name] = argv[++i];
  }
  return flags;
};

const summaryWriter = (env) => (text) => {
  process.stdout.write(`${text}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

export function runCli(argv, env = process.env) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (command === 'describe') {
    const target = loadTargets()[rest[0]];
    if (!target) throw new Error(`Unknown target: ${rest[0]}`);
    const out = { TARGET_ID: target.id, TARGET_KIND: target.kind, TARGET_RECIPE: target.recipe, TARGET_IMAGE_REF: target.imageRef ?? '', TARGET_PACKAGE: target.package ? `${target.package}@${target.packageVersion}` : '', TARGET_RECIPE_SHA256: target.recipeHash ?? '' };
    for (const [key, value] of Object.entries(out)) process.stdout.write(`${key}=${value}\n`);
    return 0;
  }
  if (command === 'build' && rest[0] === 'supercollider') {
    const { recipeHash } = loadTargets().supercollider;
    execFileSync('docker', buildSuperColliderBuildArgs({ recipeDir: join(REPO_ROOT, SUPERCOLLIDER_RECIPE_DIR), recipeHash }), { stdio: 'inherit' });
    return 0;
  }
  if (command === 'rapier-project') {
    const { package: name, packageVersion } = loadTargets()['eidoverse-rapier'];
    mkdirSync(rest[0], { recursive: true });
    writeFileSync(join(rest[0], 'package.json'), `${JSON.stringify({ name: 'portos-eidoverse-rapier-pin', private: true, version: '0.0.0', dependencies: { [name]: packageVersion } }, null, 2)}\n`);
    return 0;
  }
  if (command === 'verify') {
    return verifyRun({
      target: flags.target,
      arch: flags.arch,
      sbomPath: flags.sbom,
      scanPath: flags.scan,
      outDir: flags.out,
      strict: Boolean(flags.strict),
      dbStatusPath: flags['db-status'] ?? null,
      imageId: flags['image-id'] ?? null,
      repoDigests: flags['repo-digests'] ?? null,
      env,
      summarize: summaryWriter(env),
    });
  }
  if (command === 'unavailable') {
    mkdirSync(flags.out, { recursive: true });
    const summarize = summaryWriter(env);
    for (const entry of UNAVAILABLE_TARGETS) {
      writeFileSync(join(flags.out, `${entry.id}.unavailable.json`), `${JSON.stringify({ schema: EVIDENCE_SCHEMA, status: 'unavailable', gitSha: env.GITHUB_SHA ?? null, ...entry }, null, 2)}\n`);
      summarize(renderUnavailable(entry));
      process.stdout.write(`::warning title=Runtime image security coverage gap::${entry.id} is unavailable (${entry.owner} owns the input)\n`);
    }
    return 0;
  }
  throw new Error('Usage: runtime-image-security.js describe|build|rapier-project|verify|unavailable');
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}
