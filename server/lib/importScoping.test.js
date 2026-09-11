/**
 * Import-scoping guards (#6009).
 *
 * The Linux CI server suite spends more wall time importing modules than
 * running assertions, and almost none of that is any one test's fault: a
 * handful of widely-reached modules each pulled a subtree they only needed a
 * constant (or a boot-time function) from, and every test file downstream paid
 * for the whole thing. Narrowing those imports cut the suite's static module
 * instantiations — the sum, over all 1,588 server test files, of the modules in
 * each one's import closure — from ~115.5k to ~94.5k (-18%).
 *
 * That is a property nothing else in the tree defends, and it regresses
 * silently: re-pointing one of these imports back at the convenient barrel
 * still passes every behavioral test, it just quietly re-adds thousands of
 * module instantiations to CI. So each narrowing is pinned here as a negative
 * reachability assertion, paired with a positive control (per the contract in
 * `staticImportGraph.js`: a resolver gap must not be able to make the walk look
 * clean).
 *
 * BEFORE narrowing one of these — or any other production import — read the
 * "Import scoping" section of `server/AGENTS.md`. Bypassing a barrel that a
 * suite `vi.mock()`s reaches the real implementation instead of the double, and
 * the failure surfaces in an unrelated test file.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { staticImportClosure, staticImportSpecifiers } from './staticImportGraph.js';

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Server-relative POSIX paths, so a failure names `lib/db.js` rather than the
// absolute path of whoever's checkout is running the suite.
const abs = (relative) => join(SERVER_DIR, ...relative.split('/'));
const reaches = (entry, target) => staticImportClosure(abs(entry)).files.has(abs(target));

// Each row: the entry that was narrowed, the module it must no longer
const NARROWED = [
  ['services/github.js', 'services/settings.js',
    'loads settings only for secret operations, not repository reads or sync'],
  ['services/sharing/peerSyncPush.js', 'services/writersRoom/bibleSync.js',
    'loads bible asset handling only for Writers Room work pushes'],
  ['services/sharing/peerSyncReceive.js', 'services/writersRoom/bibleSync.js',
    'loads bible asset handling only for Writers Room work receives'],
  ['services/persistentMindAttachments.js', 'services/persistentMindSupervisor.js',
    'owns screenshot attachment lifecycle without supervisor turn execution'],
  ['services/mtplxModelManager.js', 'services/huggingFaceCatalog.js',
    'reads repository ages through shared metadata without catalog selection'],
  ['services/huggingFaceMetadata.js', 'services/pipeline/musicGen.js',
    'owns Hub transport and caching independently of audio rendering'],
  ['lib/providerFamilies.js', 'lib/grok.js',
    'shares browser-safe family identity without Grok filesystem helpers'],
  ['services/promptSections/instructions.js', 'services/taskScheduleRegistry.js',
    'needs task names, which scheduledTaskTypes.js declares'],
  ['services/agentAppWorkspace.js', 'services/promptRunner.js',
    'resolves app records without AI-backed JIRA title generation'],
  ['services/agentAppWorkspace.js', 'services/jira.js',
    'reads workspace metadata without ticket creation'],
  ['services/agentAppWorkspace.js', 'services/agentPromptBuilder.js',
    'owns workspace resolution independently of prompt assembly'],
  ['services/providerRuntimeInstaller.js', 'lib/harnessOutput.js',
    'loads version and catalog parsers only when probing a harness'],
  ['lib/db.js', 'lib/db/schema/index.js',
    'the DDL composer is boot-only — ensureSchemaImpl() imports it lazily'],
  ['lib/pipelineValidation.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SCOPES/CHECK_SEVERITIES, not the 13 check-definition modules'],
  ['lib/editorial/severityConfig.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SEVERITIES only'],
  ['services/pipeline/series.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SEVERITIES only'],
  ['services/pipeline/applyCuts.js', 'lib/editorial/checkRegistry.js',
    'needs CUT_TYPES/SAFE_CUT_TYPES only'],
  ['services/apps.js', 'lib/validation.js',
    'needs sanitizeTaskMetadata, which cosValidation.js declares'],
  ['services/memoryEmbeddings.js', 'services/memoryBackend.js',
    'needs DEFAULT_MEMORY_CONFIG, which memoryConfig.js declares'],
  ['lib/llmRoutePin.js', 'lib/storyBible.js',
    'needs trimTo, which textUtils.js declares'],
  ['lib/slashdoInvocation.js', 'lib/tuiHandshake.js',
    'needs inferTuiCommand, which providerVendors.js declares'],
  ['services/voice/tools/pipeline.js', 'services/pipeline/issues.js',
    'needs only the pure pipelineStages.js identity leaf'],
  ['services/cosTaskIntake.js', 'lib/validation.js',
    'needs SWARM_COUNT_* and the reviewer normalizers, which cosValidation.js / reviewerConfig.js declare'],
  ['services/brainStorage.js', 'services/instances.js',
    'needs getInstanceId, which instanceIdentity.js declares'],
  ['services/memoryDB.js', 'services/instances.js',
    'needs getInstanceId, which instanceIdentity.js declares'],
  ['services/worktreeManager.js', 'services/instances.js',
    'needs getInstanceId, which instanceIdentity.js declares'],
  ['services/catalogDB/ingredients.js', 'services/instances.js',
    'needs getInstanceId, which instanceIdentity.js declares'],
  ['routes/systemHealth.js', 'services/instances.js',
    'needs getInstanceId, which instanceIdentity.js declares'],
  // #6837: the string predicates / bounders live in textUtils.js; these pure
  // leaves used to reach the whole story bible (crypto + fileUtils) for isStr.
  ['lib/storyArc.js', 'lib/storyBible.js',
    'needs isStr / trimTo / trimToClause, which textUtils.js declares'],
  ['lib/styleGuide.js', 'lib/storyBible.js',
    'needs isStr / trimTo, which textUtils.js declares'],
  ['lib/sharingOrigin.js', 'lib/storyBible.js',
    'needs isStr / trimTo, which textUtils.js declares'],
  ['lib/renderSlot.js', 'lib/storyBible.js',
    'needs isStr / trimTo, which textUtils.js declares'],
];

describe('narrowed imports stay narrow (#6009)', () => {
  it.each(NARROWED)('%s no longer statically reaches %s — it %s', (entry, target) => {
    expect(reaches(entry, target)).toBe(false);
  });

  // Positive controls. Without these the negatives above would also pass if
  // `staticImportClosure` stopped resolving these files at all.
  it('still sees the modules the narrowed entries were pointed AT', () => {
    expect(reaches('services/persistentMindSupervisor.js', 'services/persistentMindAttachments.js')).toBe(true);
    expect(reaches('services/persistentMindAttachments.js', 'lib/fileUtils.js')).toBe(true);
    expect(reaches('services/mtplxModelManager.js', 'services/huggingFaceMetadata.js')).toBe(true);
    expect(reaches('services/huggingFaceCatalog.js', 'services/huggingFaceMetadata.js')).toBe(true);
    expect(reaches('services/huggingFaceMetadata.js', 'services/huggingFaceRepoCache.js')).toBe(true);
    expect(reaches('services/promptSections/instructions.js', 'lib/scheduledTaskTypes.js')).toBe(true);
    expect(reaches('services/agentAppWorkspace.js', 'lib/fileUtils.js')).toBe(true);
    expect(reaches('lib/pipelineValidation.js', 'lib/editorial/checkInfra/taxonomy.js')).toBe(true);
    expect(reaches('services/apps.js', 'lib/cosValidation.js')).toBe(true);
    expect(reaches('services/memoryEmbeddings.js', 'services/memoryConfig.js')).toBe(true);
    expect(reaches('lib/llmRoutePin.js', 'lib/textUtils.js')).toBe(true);
    expect(reaches('lib/slashdoInvocation.js', 'lib/providerVendors.js')).toBe(true);
    expect(reaches('services/voice/tools/pipeline.js', 'lib/pipelineStages.js')).toBe(true);
    expect(reaches('services/instances.js', 'services/instanceIdentity.js')).toBe(true);
    expect(reaches('lib/storyBible.js', 'lib/textUtils.js')).toBe(true);
  });

  // And a control on the other side: the barrels themselves still reach what
  // they re-export, so "nobody reaches checkRegistry" is a statement about the
  // narrowed callers, not about a broken registry.
  it('leaves the editorial barrel and the schema composer intact', () => {
    expect(reaches('lib/editorial/checkRegistry.js', 'lib/editorial/checks/proseStyle.js')).toBe(true);
    expect(reaches('lib/db/schema/index.js', 'lib/db/schema/catalog.js')).toBe(true);
  });
});

// Serve must never acquire outbound peer registration through shared CLI support.
describe('Tailcat shared owners stay independent of forwarding (#6570)', () => {
  it.each(['services/tailcatServe.js', 'services/tailcatRuntime.js', 'lib/tailcatAddress.js'])(
    '%s does not reach forward orchestration or instance registration', (entry) => {
      const closure = staticImportClosure(abs(entry)).files;
      expect(closure.has(abs(entry))).toBe(true);
      expect(closure.has(abs('services/tailcatPeer.js'))).toBe(false);
      expect(closure.has(abs('services/instances.js'))).toBe(false);
    },
  );

  it('both dial directions reach the shared owners and forwarding retains registration', () => {
    for (const entry of ['services/tailcatPeer.js', 'services/tailcatServe.js']) {
      expect(reaches(entry, 'services/tailcatRuntime.js')).toBe(true);
      expect(reaches(entry, 'lib/tailcatAddress.js')).toBe(true);
    }
    expect(reaches('services/tailcatRuntime.js', 'lib/tailcatVersion.js')).toBe(true);
    expect(reaches('services/tailcatPeer.js', 'services/instances.js')).toBe(true);
  });
});

// This install's federation identity moved out of services/instances.js into
// its own leaf (#6836) so a one-line id read no longer statically loads the
// peer-orchestration closure — the Tailscale status parser, the
// federated-media probe, and the socket relay — that instances.js pulls in.
describe('instance identity stays a leaf (#6836)', () => {
  it('reaches no server/services/* module besides itself', () => {
    const closure = staticImportClosure(abs('services/instanceIdentity.js')).files;
    const servicesLeaks = [...closure]
      .filter((file) => file !== abs('services/instanceIdentity.js'))
      .filter((file) => relative(SERVER_DIR, file).startsWith(`services${sep}`));
    expect(servicesLeaks, `instanceIdentity.js must stay a leaf — also reaches: ${servicesLeaks.map((f) => relative(SERVER_DIR, f)).join(', ')}`).toEqual([]);
  });

  it('reaches none of the peer-orchestration modules the pre-split id read used to drag in', () => {
    const closure = staticImportClosure(abs('services/instanceIdentity.js')).files;
    expect(closure.has(abs('lib/tailscale.js'))).toBe(false);
    expect(closure.has(abs('lib/peerHttpClient.js'))).toBe(false);
    expect(closure.has(abs('services/peerSocketRelay.js'))).toBe(false);
    expect(closure.has(abs('services/federatedMediaConsumer.js'))).toBe(false);
  });

  // Positive control: without this, a broken resolver could make the leaf
  // closure look empty and the negatives above would pass vacuously.
  it('still reaches the file I/O + mutex helpers it declares', () => {
    expect(reaches('services/instanceIdentity.js', 'lib/fileUtils.js')).toBe(true);
    expect(reaches('services/instanceIdentity.js', 'lib/asyncMutex.js')).toBe(true);
  });
});

/**
 * Deferred imports (#6156).
 *
 * The other shape from the AGENTS.md section: not a constant reachable from a
 * lighter module, but a dependency that only a run/boot path executes. #6009
 * used it once (`ensureSchemaImpl`); these are the rest of the head of the
 * distribution — the four heaviest remaining edges were all "imported at module
 * scope, called only once a run is actually executing".
 *
 * Each row is asserted BOTH ways. The negative alone would also pass if someone
 * deleted the call entirely, which is a different (and probably wrong) change
 * than the one this row is defending; the positive pins the `await import()`
 * that has to remain in its place.
 */
// [entry, target, why, specifier] — same first three columns as NARROWED above,
// plus the specifier the call site must still name in its `await import()`.
const DEFERRED = [
  ['services/codeReview.js', 'services/lmStudioManager.js',
    'reads the live endpoint only for a selected LM Studio review', './lmStudioManager.js'],
  ['services/codeReview.js', 'services/ollamaManager.js',
    'reads endpoints and model capabilities only for an Ollama review', './ollamaManager.js'],
  ['services/codeReview.js', 'services/mtplxServerManager.js',
    'resolves the managed daemon only for an MTPLX review', './mtplxServerManager.js'],
  ['services/agentManagement.js', 'lib/privateSecuritySandbox.js',
    'loads sandbox cleanup only for private assessments', '../lib/privateSecuritySandbox.js'],
  ['services/cos.js', 'services/persistentMindAdapter.js',
    'is registered once at daemon start, but pulls the CoS tool registry, voice tools, ask service and image-gen backends',
    './persistentMindAdapter.js'],
  ['services/promptRunner.js', 'services/providerExecutionReadiness.js',
    'runs readiness only on the TUI execution branch, not when a run is built or classified',
    './providerExecutionReadiness.js'],
  ['services/promptRunner.js', 'services/tuiPromptRunner.js',
    'drags node-pty in through services/shell.js for a branch most promptRunner suites never take',
    './tuiPromptRunner.js'],
  ['services/settings.js', 'services/userActions.js',
    'makes one ledger write reaching the DB layer, from a module nearly every service imports',
    './userActions.js'],
  ['services/runner.js', 'services/ollamaAgentContext.js',
    'needs the daemon manager only for an ollama-backed CLI run; the call was already predicate-gated',
    './ollamaAgentContext.js'],
];

describe('deferred imports stay deferred (#6156)', () => {
  it.each(DEFERRED)('%s no longer statically reaches %s — it %s', (entry, target) => {
    expect(reaches(entry, target)).toBe(false);
  });

  it.each(DEFERRED)('%s still lazily imports %s at its call site', (entry, target, why, specifier) => {
    const src = readFileSync(abs(entry), 'utf-8');
    expect(
      src.includes(`import('${specifier}')`),
      `${entry} no longer contains a dynamic import('${specifier}'). If ${target} is genuinely unused now, delete this row — do not restore a static import.`,
    ).toBe(true);
  });

  // Positive control, mirroring the one above: these targets are real modules
  // with real graphs, so a resolver gap can't be what makes the negatives pass.
  it('still sees the deferred modules from their own entry points', () => {
    expect(reaches('services/persistentMindAdapter.js', 'services/cosToolRegistry.js')).toBe(true);
    expect(reaches('services/tuiPromptRunner.js', 'services/shell.js')).toBe(true);
  });
});

/**
 * The trend metric, as a budget.
 *
 * The rows above are exact: each defends one edge. This defends the property
 * they exist for — that the suite as a whole does not drift back toward
 * importing what it never runs — and it is the only assertion here that catches
 * a NEW heavy edge somewhere nobody has thought to add a row for.
 *
 * It is a budget, not a high-water mark. It sits ~1.5k above the measured total
 * so ordinary growth (a new service plus its suite) does not fail it, while the
 * shape this file exists to catch — one eager edge into a heavy subtree,
 * multiplied by every suite crossing it — moves the number by thousands.
 *
 * If a change pushes past it, first ask whether the new import belongs at module
 * scope at all. If it does, raise the number in the same commit and say what was
 * added. When a narrowing drops the total well below it, lower it — a budget
 * nobody tightens stops measuring anything.
 *
 * History, over the test files under `server/` only — the same denominator
 * #6009 reported, and what `serverTestFiles()` below walks:
 *   115,519 before #6009 · 96,233 after · 83,439 after #6156 · 85,105 after #5992 (orchestration profiles service & routes).
 *
 * Raised to 88,000 in #6305. The budget had drifted to within single digits of
 * the measured total, so the next ordinary addition was always going to trip it
 * — #6305's own share is ~43 (two new suites, plus one leaf service module,
 * `services/codexOssSupport.js`, reached by the 14 suites that cross
 * `services/providerPrerequisites.js`). That is the ordinary growth this budget
 * is documented to tolerate, not the shape it exists to catch, so the fix is to
 * restore the ~1.5k headroom the number is supposed to carry rather than to
 * inch it up by a hundred each time. It stays thousands below what ONE eager
 * edge into a heavy subtree costs, which is what actually has to fail here.
 */
// #6350: Pi's vendor leaf is necessarily reached by the shared dispatcher.
// Deferring catalog/version parsers removes 296 instantiations (88,360 →
// 88,064). Restore the documented ~1.5k allowance for ordinary leaf growth;
// keep the negative runtime-installer guard above so eager parsing cannot return.
//
// #6377 measures 89,889. Its share is ~389, and it is the tolerated shape, not
// the one this budget exists to catch: two new LEAF vocabulary modules with no
// subtree behind them — `lib/taskTargetScope.js` (four constants, zero imports)
// and `lib/quotaBurnTaskRef.js` (pure shape + resolver, importing only
// `objects.js`, which every reacher already had). They are reached by the ~200
// suites that cross `lib/quotaBurnConfig.js`, so a leaf costs ~200 apiece with
// nothing to defer. Restore the ~1.5k allowance again rather than inching the
// number up by a few hundred per PR.
//
// #6368 adds `lib/callerModePolicy.js`, another zero-dependency leaf reached by
// the routing boundary and the lib barrel (~92 instantiations). Same tolerated
// shape; it fits inside the allowance above.
//
// #6375 adds `lib/autonomousJobIntervals.js` — the autonomous-job cadence
// vocabulary `cosValidation.js` validates against, so ~194 suites reach it. It is
// a zero-import leaf (its time units are declared locally precisely so it drags
// nothing); the alternative is re-declaring the cadence list at the Zod boundary,
// which is the drift that issue exists to close. Fits inside the allowance above.
//
// #6364 retires the server/client copy convention, splitting four pure leaves
// out of modules the client now imports (`bibleLimits.js` out of `storyBible.js`,
// `portosUrls.js` out of `ports.js`, `youtubeUrlAssert.js` out of `youtubeUrl.js`,
// `avatarStyles.js` in from the client tree). Each is one extra NODE on a path
// that already existed — a flatter graph, not a new eager edge into a heavy
// subtree. Fits inside the allowance above.
//
// #6380 measures 91,710 — the ~1.5k allowance restored at #6377 is spent, so
// re-measure and restore it rather than inching. The +371 is ONE new suite,
// `services/cosTaskGenerator.auditMode.test.js`, and its cost IS its point: it
// generates a real audit task through `cosTaskGenerator.js` (274) and renders
// the final agent prompt from it through `agentPromptBuilder.js` (+94
// marginal), because the file-issues mode is enforced across exactly that seam
// and neither half alone can prove an issues-only run cannot acquire
// commit/push/PR instructions. No new eager edge into a heavy subtree: the
// production change adds only `lib/auditCatalog.js` (a zero-import leaf) to
// `autonomousJobs/skillTemplates.js`, worth 2.
// #6434: after deferring the private sandbox at all three CoS call sites,
// this branch measures 93,722 versus 93,229 on its current main base. The
// remaining +493 is the shared policy/provenance leaves and two boundary
// suites, not an eager sandbox/runtime subtree. Main already exceeded the
// previous ceiling; restore the documented ~1.5k ordinary-growth allowance.
// The DEFERRED row above prevents the avoidable sandbox edge from returning.
//
// #6442 adds 344 on top of that base (94,066), which fits inside the allowance
// #6434 restored — so the ceiling stays put. All 344 is three NEW suites and
// none of it a new eager edge; the production change adds no import its module
// did not already reach. The largest,
// services/pipeline/editorial/reviewStaleness.test.js (198), earns its reach:
// only the real SOURCE_RESOLVERS table can prove the evolution lens has its own
// fingerprint token, so a lens edit stales a review while a want/need edit does
// not. services/pipeline/arcPlanner/context.test.js (78) and
// lib/editorial/checks/characterArcEvolution.test.js (68) are boundary tests
// over modules those trees already instantiate.
// #6532: same-origin Eidoverse proxy (`eidoverseProxy.js` + route allowlist)
// loaded via the host mount at boot. Measured 95,246 on this branch (+46 over
// the prior ceiling) — ordinary growth for an intentional main-server edge,
// not an eager heavy subtree. Raise the ceiling to keep the ~1.5k allowance.
//
// Replacing five client hand-copies of server constants (the component and page
// mirrors the earlier sweeps left) with imports added two pure leaves the
// browser bundle reads: `lib/characterIntegrityVocabulary.js`
// (split out of `characterIntegrity.js`, which reaches `crypto`) and
// `lib/creativeBriefLimits.js` (the caps both creative validation modules
// enforce). Measured 95,470 (+223 over main's 95,247): `creativeBriefLimits.js`
// +206 (every suite that reaches `creativeCommissionValidation.js` through
// `validation.js`'s flat re-export), `uuid.js` +56 (newly reached through
// `seriesCharacterArc.js`), the vocabulary leaf +24, less the five deleted
// mirror suites — leaves with nothing behind them to defer, the tolerated shape,
// not an eager edge. Restore the ~1.5k allowance.
//
// #6590 is the same shape again: the image-gen capability literals the client
// hand-copied (input-image caps, the prompt rule, the shipped default
// models/effort, the aspect-ratio alphabets) moved out of three
// `services/imageGen/*` modules — unreachable from the browser bundle because
// they import `errorHandler.js` — into one dependency-free leaf,
// `lib/imageGenCapabilities.js`. Measured 96,975 (+108 over main's 96,867): the
// leaf is +1 in each of the 108 closures that already reached `imageGen/modes.js`,
// and it pulls in nothing new (its only import, `generationModes.js`, was
// already in every one of them). A leaf with nothing behind it to defer is the
// tolerated shape. The allowance had drifted to ~30 again, so restore the ~1.5k.
//
// #6617 is that shape once more: collapsing `runAgentSpawn`'s eight hand-copied
// block-and-bail epilogues into one helper meant lifting the steps they were
// tangled with out of the orchestrator — `lib/publicReviewSpawnGate.js`,
// `lib/agentRegistrationRecord.js`, `lib/taskGenerationOverrides.js` and
// `services/publicReviewSpawnInput.js`. Measured 98,642 (+142 over main's
// 98,500): four modules appearing as +1 each in the closures that already
// reached `agentLifecycle.js`, pulling in nothing those closures lacked. The
// one edge that WOULD have been new — `agentRegistrationRecord.js` reaching
// `normalizeReviewers` through the 123-module `validation.js` catch-all — is
// narrowed to its declaring leaf, `reviewerConfig.js`, so it contributes
// nothing. Restore the ~1.5k allowance.
// Beeper adds 22 server suites (1,045 instantiations) and 933 instantiations
// across existing suites, primarily dependency-free validation/attachment
// leaves. Measured against current main: 99,794 -> 101,772. No new heavy eager
// subtree is introduced; retain the standard roughly 1,500 allowance.
//
// #6816 is the #6590/#6617 shape again: `creativeCommissionValidation.js`'s
// generation-key spec (GENERATION_KEY_DEFS / ABILITY_GENERATION_SPEC and the
// quality/aspect-ratio/backend enums) moved into a new dependency-free leaf,
// `creativeCommissionSpec.js`, so the client form can import it directly
// instead of hand-copying it. Its only imports (`generationModes.js`,
// `renderTargets.js`) were already reached by every closure that reaches
// `creativeCommissionValidation.js` (itself widely reached through
// `validation.js`'s flat re-export, per the #6617 note above), so the new leaf
// contributes +1 to each of those ~230 closures and pulls in nothing new.
// Measured against current main: 103,076 -> 103,308. Restore the ~1.5k allowance.
//
// #6836 is the opposite shape — a DECREASE, not a new leaf's small additive
// cost: this install's federation identity (UNKNOWN_INSTANCE_ID, ensureSelf,
// getSelf, getInstanceId, ensureInstanceId, updateSelf, the data/instances.json
// file I/O + mutex) moved out of services/instances.js into the dependency-free
// services/instanceIdentity.js leaf above. The 22 callers that only needed an
// id read no longer statically load instances.js's peer-orchestration closure
// (the Tailscale status parser, the federated-media probe, the socket relay,
// ~30 modules). Measured against current main: 103,462 -> 101,702 (-1,760);
// suites whose closure reaches services/instances.js: 181 -> 33. Lower the
// ceiling to the new measured total plus the standard ~1.5k allowance.
const MAX_STATIC_INSTANTIATIONS = 103202;


const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist', 'data']);
const serverTestFiles = (dir = SERVER_DIR, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      serverTestFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.test.js')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

/**
 * `staticImportClosure` re-reads and re-parses every module it walks, so calling
 * it once per suite re-parses widely-shared modules thousands of times. That is
 * fine for the handful of single-entry assertions above and far too slow here:
 * ~1,600 entries took 18s on a CI runner and blew the 10s testTimeout.
 *
 * Same walk, with the per-file specifier list memoized across entries. The
 * agreement test below pins it to the shared implementation so the two cannot
 * drift into measuring different things.
 */
const depsCache = new Map();
const resolvedDeps = (file) => {
  const cached = depsCache.get(file);
  if (cached) return cached;
  const deps = [...new Set(
    staticImportSpecifiers(file)
      .filter((spec) => spec.startsWith('.'))
      .map((spec) => resolve(dirname(file), spec))
      .filter((path) => existsSync(path)),
  )];
  depsCache.set(file, deps);
  return deps;
};

const closureSize = (entry) => {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of resolvedDeps(file)) if (!seen.has(dep)) stack.push(dep);
  }
  return seen.size;
};

// Same memoized walk as closureSize, but stops the moment it finds `target`
// instead of counting the whole closure — used by the #6836 reach-count test
// below, which only needs a yes/no per file, not a total.
const closureReaches = (entry, target) => {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (file === target) return true;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of resolvedDeps(file)) if (!seen.has(dep)) stack.push(dep);
  }
  return false;
};

describe('server suite import budget (#6156)', () => {
  it('memoized closure walk agrees with staticImportClosure', () => {
    // A spread of entry points: two modules this PR touched, one heavy suite,
    // and a leaf. If the shared parser gains a specifier shape this walk does
    // not follow (or vice versa), these diverge.
    for (const sample of ['lib/db.js', 'lib/pipelineValidation.js', 'services/agentManagement.test.js', 'lib/editorial/checkInfra/taxonomy.js']) {
      expect(closureSize(abs(sample)), sample).toBe(staticImportClosure(abs(sample)).files.size);
    }
  });

  // Explicit timeout: this walks every server test file, which is inherently
  // more work than a unit test and runs on a shared CI runner. The memoized
  // walk brings it to ~1s locally, but the default 10s leaves no margin for a
  // slow or contended runner — and a timeout here reads as a budget failure,
  // which is exactly the wrong diagnosis.
  it(`stays under ${MAX_STATIC_INSTANTIATIONS.toLocaleString()} static module instantiations`, () => {
    const files = serverTestFiles();
    // Guards the walk itself: an empty or tiny list would make the budget pass
    // vacuously, the same failure mode the positive controls above defend.
    expect(files.length, 'found almost no test files — the walk above is broken').toBeGreaterThan(1000);

    const total = files.reduce((sum, file) => sum + closureSize(file), 0);
    expect(
      total,
      `Static module instantiations across the server suite rose to ${total.toLocaleString()}. Something added an eager import into a heavy subtree from a widely-reached module — narrow it, defer it with a call-site await import(), or raise the budget deliberately. See the "Import scoping" section of server/AGENTS.md.`,
    ).toBeLessThanOrEqual(MAX_STATIC_INSTANTIATIONS);
  }, 60_000);

  // #6836: before the identity leaf split, 181 of these files' closures reached
  // services/instances.js — for most of them (the 22 direct identity-only
  // callers plus everything downstream of the 46 test doubles) only because a
  // static id-read reachability chain touched it, not because the suite
  // actually exercises peer orchestration. Reuses the same memoized dep cache
  // as the instantiation-count walk above, so the extra pass costs a graph
  // traversal, not re-parsing.
  it('keeps fewer than 60 server test files statically reaching services/instances.js', () => {
    const files = serverTestFiles();
    const target = abs('services/instances.js');
    const reachingCount = files.filter((file) => closureReaches(file, target)).length;
    expect(
      reachingCount,
      `${reachingCount} server test files still statically reach services/instances.js (was 181 before #6836's instanceIdentity.js leaf split). If this crept back up, check for a caller that only needs identity (getInstanceId/ensureInstanceId/getSelf/ensureSelf/updateSelf/UNKNOWN_INSTANCE_ID) re-widening its import back onto instances.js instead of instanceIdentity.js.`,
    ).toBeLessThan(60);
  }, 60_000);
});

// The shared compiler must remain usable without loading project mutations.
it('keeps Video compilation independent of project storage and execution', () => {
  const closure = staticImportClosure(abs('lib/creativeDirectorVideoCompiler.js')).files;
  expect(closure.has(abs('lib/grokVideoClip.js'))).toBe(true);
  expect(closure.has(abs('lib/reactorVideoClip.js'))).toBe(true);
  expect(closure.has(abs('services/creativeDirector/projectsLogic.js'))).toBe(false);
  expect(closure.has(abs('services/creativeDirector/videoExecution.js'))).toBe(false);
  expect(closure.has(abs('lib/validation.js'))).toBe(false);
});

describe('shared provider type leaf', () => {
  it('keeps provider models independent of the type leaf and browser-safe', () => {
    expect(reaches('lib/providerModels.js', 'lib/providerTypes.js')).toBe(false);
    const closure = staticImportClosure(abs('lib/providerTypes.js'));
    expect(closure.packages.size).toBe(0);
    expect(reaches('lib/providerTypes.js', 'lib/providerModels.js')).toBe(true);
  });
});
