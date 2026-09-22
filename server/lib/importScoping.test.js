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
  ['services/codeReview.js', 'lib/validation.js',
    'reads reviewer vocabulary from its pure declaring module without the validation barrel'],
  ['services/backup.js', 'services/socket.js',
    'loads socket/auth listeners only when a failed scheduled DB dump needs the global socket'],
  ['services/eidoverseWorld.js', 'services/eidoverseWorldSources.js',
    'uses pure Eidoverse signals without eagerly loading source readers'],
  ['services/eidoverseTravel.js', 'services/eidoverseWorldSources.js',
    'uses pure Eidoverse signals without eagerly loading source readers'],
  ['services/eidoverseWorld.test.js', 'services/eidoverseWorldSources.js',
    'uses pure Eidoverse signals without eagerly loading source readers'],
  ['services/eidoverseTravel.test.js', 'services/eidoverseWorldSources.js',
    'uses pure Eidoverse signals without eagerly loading source readers'],
  ['lib/eidoverseWorldSignals.js', 'services/eidoverseWorldSources.js',
    'uses pure Eidoverse signals without eagerly loading source readers'],

  ['services/imageGen/local.js', 'services/localMemory.js',
    'loads GPU memory management only for generation, not gallery reads'],
  ['services/imageGen/local.js', 'services/imageGen/regen.js',
    'loads pixel comparison only for a regeneration, not gallery reads'],
  ['services/persistentMindSupervisor.js', 'services/persistentMindContext.js',
    'loads context and memory orchestration only after a turn is admitted'],
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
  ['services/review.js', 'services/reviewActionAdapters.js',
    'owns source-owned completion policy without the queue action adapters'],
];

describe('narrowed imports stay narrow (#6009)', () => {
  it.each(NARROWED)('%s no longer statically reaches %s — it %s', (entry, target) => {
    expect(reaches(entry, target)).toBe(false);
  });

  // Positive controls. Without these the negatives above would also pass if
  // `staticImportClosure` stopped resolving these files at all.
  it('still sees the modules the narrowed entries were pointed AT', () => {
    expect(reaches('services/eidoverseWorld.js', 'lib/eidoverseWorldSignals.js')).toBe(true);
    expect(reaches('services/eidoverseTravel.js', 'lib/eidoverseWorldSignals.js')).toBe(true);
    expect(reaches('services/eidoverseWorld.test.js', 'services/eidoverseWorldProjection.js')).toBe(true);
    expect(reaches('services/eidoverseWorldSources.js', 'lib/eidoverseWorldSignals.js')).toBe(true);
    expect(reaches('services/eidoverseWorldSources.js', 'services/apps.js')).toBe(true);
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
  ['services/reviewQueue.js', 'services/cosAgentFeedback.js',
    'loads feedback persistence only when gathering or rating CoS feedback',
    './cosAgentFeedback.js'],
  ['services/reviewQueue.js', 'services/askPromote.js',
    'loads Ask promotion orchestration only for an explicit promotion action',
    './askPromote.js'],
  ['services/reviewQueue.js', 'services/backup.js',
    'reads backup status only while gathering the failed-backup producer',
    './backup.js'],
  ['services/reviewQueue.js', 'services/reviewActionAdapters.js',
    'adapts stored review and notification rows only while building the queue',
    './reviewActionAdapters.js'],
  ['services/notifications.js', 'services/reviewActionAdapters.js',
    'classifies action history only on notification mutations',
    './reviewActionAdapters.js'],
  ['services/telegramForward.js', 'services/reviewActionAdapters.js',
    'adapts a notification only when a forward is actually sent',
    './reviewActionAdapters.js'],
  ['services/videoGen/generateVideo.js', 'services/videoGen/ensureWeights.js',
    'provisions MiniMax H3 weights only for an actual H3 render',
    './ensureWeights.js'],
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
 * Hoisted test imports (#7951).
 *
 * The inverse of DEFERRED, and it defends a runner budget rather than a module
 * count. A test file that loads a large graph with `await import()` INSIDE an
 * `it()` or a `beforeAll` pays vitest's transform pipeline for that whole graph
 * the first time any worker touches it, and that cost is charged against
 * `testTimeout` / `hookTimeout`. Measured under a full `cd server && npm test`
 * on macOS, against ~445ms for the same import in a quiet node process:
 *
 *   routes/imageGen.js ......... 29,789ms   (beforeAll -> "Hook timed out in 10000ms")
 *   services/cosToolRegistry.js  34,571ms   (it()      -> "Test timed out in 10000ms")
 *   routes/settings.js ......... 28,184ms   (it(), then 530-970ms per re-import)
 *
 * Under the flat 10s budget these files failed with zero failing assertions, in
 * suites the change under test never touched — which is exactly how a real
 * regression rides through a habitually-red `npm test`. Moving the same import
 * to file scope pays it during module collection, which is not budgeted at all.
 *
 * #7951 also raised testTimeout/hookTimeout to 30s, which is what covers the
 * ~269 test files whose in-test `await import()` is deliberate and cannot be
 * hoisted. These rows are still the load-bearing half: a 30s budget does not
 * make a 35s import fit, and the raise is a ceiling for the tail rather than a
 * licence to put a heavy cold load back inside a timed region. It regresses
 * silently — pushing one of these imports back into a hook still passes on a
 * quiet machine and only fails under full-suite contention — so each is pinned
 * here.
 *
 * Asserted BOTH ways, like DEFERRED above: the file must still name the
 * specifier (a row whose import was deleted is a different change), and the
 * call must still sit ahead of the first test/hook registration in the file.
 */
// [test file, specifier it must import at file scope, why]
const HOISTED = [
  ['routes/imageGen.multipart.test.js', './imageGen.js',
    'the route graph costs ~30s to transform cold, which a beforeAll charges to hookTimeout'],
  ['services/beeperOutboxHumanGate.test.js', './cosToolRegistry.js',
    'the CoS tool registry costs ~35s to transform cold, which an it() charges to testTimeout'],
  ['routes/settings.secretsStrip.test.js', './settings.js',
    'warms the graph once so each vi.resetModules() re-import costs under a second'],
  ['routes/peerSyncAuthIntegration.test.js', './peerSync.js',
    'warms the peer-sync route graph once, for the same vi.resetModules() reason'],
  ['routes/peerSyncAuthIntegration.test.js', '../services/auth.js',
    'warms the auth service the first test reaches before it can build an app'],
];

// Everything up to the first test/hook registration is module-collection scope.
// Anchored to statement position (start of a line, optionally indented) rather
// than matched anywhere in the source: `it()` and `beforeAll` are ordinary
// English in a comment, and a bare \b match finds those too — which is how the
// first draft of this guard reported a hoisted import as un-hoisted because the
// comment ABOVE it explained which hook the import had been moved out of.
const FIRST_REGISTRATION = /^[ \t]*(?:describe|it|test|beforeAll|beforeEach|afterAll|afterEach)\s*(?:\.\w+)?\s*\(/m;

describe('heavy test imports stay hoisted to file scope (#7951)', () => {
  it.each(HOISTED)('%s imports %s before any test or hook — it %s', (entry, specifier) => {
    const src = readFileSync(abs(entry), 'utf-8');
    const call = `import('${specifier}')`;
    const first = src.indexOf(call);
    expect(
      first,
      `${entry} no longer contains ${call}. If ${specifier} is genuinely unused now, delete `
        + 'this row — do not move the import back into a test or a hook.',
    ).toBeGreaterThan(-1);

    const registration = src.search(FIRST_REGISTRATION);
    expect(
      registration,
      `${entry} registers no test or hook, so this row is guarding the wrong file.`,
    ).toBeGreaterThan(-1);

    // The FIRST load is the one that matters: it is what pays the transform.
    // A later `import()` of the same specifier from inside a test — which the
    // `vi.resetModules()` files do deliberately, to get a fresh instance — costs
    // the sub-second re-import measured above, so those occurrences are fine.
    expect(
      first,
      `${entry} loads ${specifier} first at offset ${first}, after the first test/hook `
        + `registration at ${registration}. That import's cold transform cost is then `
        + 'charged against testTimeout/hookTimeout — keep the first load at file scope (#7951).',
    ).toBeLessThan(registration);
  });

  // Positive control: the regex must actually FIND a registration in a file
  // that has one, or every row above would pass by comparing against -1.
  it('recognizes a test registration in a file that plainly has one', () => {
    const src = readFileSync(abs('services/beeperOutboxHumanGate.test.js'), 'utf-8');
    expect(src.search(FIRST_REGISTRATION)).toBeGreaterThan(-1);
    expect(FIRST_REGISTRATION.test("  it('does a thing', () => {")).toBe(true);
    expect(FIRST_REGISTRATION.test('beforeAll(async () => {')).toBe(true);
    expect(FIRST_REGISTRATION.test("const x = await import('./settings.js');")).toBe(false);
    // The anchoring the first draft lacked: prose is not a registration.
    expect(FIRST_REGISTRATION.test('// moved out of the `it()` that asserts on them')).toBe(false);
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
// #6992 adds the existing hostShutdown latch to GitHub command completion and
// branch reconciliation. Its dependencies were already in these callers'
// closures; the measured baseline 103,190 -> 103,228 is the shutdown module
// itself in 38 additional suite closures, not a new heavy subtree. Preserve
// the existing headroom by accounting for exactly that additive lifecycle edge.
// #7239 points cosValidation.js, peerSyncValidation.js and taskBlockCategories.js
// at the task vocabularies declared in lib/taskParser.js, so the HTTP enum, the
// peer wire enum and the block-category set cannot drift from what TASKS.md can
// actually represent. taskParser.js is a zero-import leaf, so each edge costs
// exactly one module in a suite that did not already reach it: this branch's own
// delta is +92 — 60 such suites plus the new lib/peerSyncValidation.test.js
// closure (32). There is nothing to narrow — the leaf IS the narrow form — so
// raise by exactly that delta and keep the existing headroom. The measured total
// is 103,356 after rebasing onto a main that grew by 36 on its own.
// The yt-dlp update path adds services/ytdlpUpdate.js (closure 22 — 17 of them
// lib/bufferedSpawn.js, which the Video Downloader route already reached) and
// its own test file. The measured whole-tree delta is +16: nearly everything
// ytdlpUpdate.js reaches was already in some suite's closure, so the cost is
// the new modules themselves rather than a new heavy subtree. There is nothing
// to narrow — bufferedSpawn IS how this tree captures a subprocess's output —
// so raise by exactly that delta and keep the existing headroom.
// The preflight task card (#7258) adds lib/preflightPlan.js — a zero-import
// leaf — and services/preflightTaskCard.js, which reaches only cosTaskStore.js
// (already in every closure that drains on-demand requests). Nearly all of the
// measured +136 is the barrel: registering the leaf in lib/index.js, which the
// module-organization rule requires, instantiates one more module in every
// closure that reaches the barrel. There is nothing to narrow — the leaf pulls
// nothing — so raise by exactly that delta and keep the existing headroom.
// The idle-review steal's card hand-off measures +1: one new test file, which
// reaches cosTaskGenerator.js through `await import()` (after its vi.mocks, as
// that suite must), so its static closure is itself alone. Its one new module
// edge — preflightTaskCard.js → taskScheduleConstants.js, for the "only a USER
// origin is carded" policy — is free: onDemandDrain.js already reached that
// leaf directly, and gave up its own edge to the same shared helper. Nothing to
// narrow — a deferred import IS the narrow form.
// The Codex quota-freshness fix measures +4: providerUsage.js and
// providerQuotaShare.js stop hand-rolling "which reading is newer" and reach for
// lwwTimestamp.js (the canonical LWW polarity) plus singleFlight.js. Both are
// dependency-free leaves, so the delta is the two modules themselves across the
// handful of closures that reach these services — there is no subtree behind
// them to narrow, and deferring a compare used on every passive quota read
// would trade the whole point of the shared rule for four instantiations.
// Decks (Create → Decks) measures +393 after narrowing everything that could
// be: the route module, the boot-time hook, the render service and the prompt
// services all defer their heavy subtrees (DB, prompt runner, media queue,
// image-gen dispatcher) to the request that needs them. What remains is the
// closures of the six new suites themselves — the DB-backed route suite reaches
// db.js, the hook suite reaches the media queue, the prompt/render suites reach
// the modules they mock — plus the two pure leaves the lib barrel gains and the
// schema composer's decks.js, counted by the suites that load those barrels.
// Pinning the shipped image-gen model defaults to the seeded provider catalog
// measures +7, all of it ONE new test file's own closure: imageGenCapabilities.js
// and the generationModes.js leaf behind it, plus providerModels.js and its
// three leaves, reached so the guard can assert the agy pin is the tier
// pickAntigravityRelayModel would choose rather than a second hand-maintained
// opinion. It reads data.reference/providers.json as JSON rather than importing
// the toolkit's own catalog module precisely to avoid dragging that subtree in,
// and no production module gained an edge — so raise by exactly that delta and
// keep the headroom.
// Federating card decks (record kind `deck`) measures +30: `services/decks.js`
// becomes a static edge of the four peer-sync modules a new federated kind must
// register in (recordKinds.js, peerSync.js, tombstoneGc.js,
// conflictJournalResolver.js), dragging the one subtree it owns that those
// modules did not already reach — `lib/deckTemplates.js` and the deck
// validation/prompt leaves beside it. Everything else it imports (db.js,
// conflictJournal.js, recordEvents.js, renderTargets.js) those four already
// had. There is no narrowing available: the descriptor table needs the getter
// and merger at module scope, by construction. The federation suite that
// covers it (services/decksSync.db.test.js) measures a further +40, all of it
// that one new test file's own closure — decks.js plus the syncWire/db-gate
// leaves it asserts against, no production edge. Raise by exactly those deltas.
// Surfacing stored model pins the provider catalog has retired (#7315) measures
// +38. 11 are the modelPinReconcile leaf suite's own closure: the leaf plus
// providerModels.js and its leaves, plus localProviderRuntime.js — the leaf
// delegates its base membership rule to that module's `modelPinIsOffered`
// rather than re-deriving it, which is what gives the audit the local-daemon
// carve-out (an Ollama-backed provider's stored `models` is a stale snapshot,
// so judging a pin against it reports a serving model as retired). 4 are the
// route suite, which reaches the route through a dynamic import and statically
// pulls only express and two error/test leaves. The audit suite adds nothing —
// it reaches everything through vi.mock + await import. The rest is
// routes/providers.js gaining services/modelPinAudit.js, whose own closure is
// 34 light files: settings.js (already reached), imageGenCapabilities.js, and
// dependency-free leaves. Its three HEAVY stores — apps.js, taskSchedule.js,
// providers.js — stay behind memoized call-site `await import()`, without which
// that one edge alone measured +449.
// Giving the screened pull-request surface ONE definition (#7323) measures +68.
// All of it is the new pure leaf `lib/prReviewContent.js` landing in the closure
// of the 68 files that already reach `services/issueWatcher.js`,
// `services/prReviewerSecurity.js`, or the `lib/` barrel — +1 file each. Its own
// closure adds nothing: it imports only `lib/modelAbuseGuard.js`, which every one
// of those already had. There is no narrowing available, and deferring it would
// defeat the point — the preflight STAMPS a content fingerprint that the
// coordinator RECOMPUTES before it acts, the check fails closed, and two builders
// that drift apart disable review, CI approval, and merge for every external PR.
// Putting both halves in one pure leaf is what keeps the contract test out of the
// coordinator's service subtree entirely.
// Splitting the model-pin membership rule out of `localProviderRuntime.js` into
// the browser-safe leaf `modelPinMembership.js` (#7327) measures +297. Almost
// all of it is one extra module NODE, not a new subtree: `localProviderRuntime`
// is reached from a great many suites and now instantiates the leaf beside it,
// so each of those closures grows by one. The rest is the leaf's own suite —
// the leaf plus `providerModels.js`, `localEndpoint.js` and `ports.js`, all of
// which that suite's predecessor already pulled. Nothing gained an edge into a
// heavy subtree, and the split REMOVES one for the browser, which is its point:
// `localProviderRuntime` reaches `opencodeConfig.js` → `zod` to resolve
// ENDPOINTS, a question no picker asks. Raise by exactly that delta.
// #7328 raised this by a further 2: the retired-pin notifier's new suite and the
// module it statically imports, lib/mirrorParity.js (dependency-free), for the
// bootstrap source contract. Both the notifier and the audit behind it are
// reached through `await import()`, so neither is in that closure — and
// bootstrap.js gaining a static import of the notifier cost nothing, because no
// server test file statically reaches bootstrap.js.
// +80 for services/agentSentinelSweep.test.js: a new leaf suite whose closure is
// the sweep, lib/agentSentinel.js and the fileUtils chain those two already
// share with the rest of the suite. No new edge into a heavy subtree — a new
// test file simply costs its own closure once.
// #7326 extends the audit to the per-record `imageModelId` pins: +7 on top of
// that (104,487), raised by exactly the delta the way #7327 did. All 7 is the two new
// suites' OWN closures — modelPinRecords.test.js and modelPinRecords.db.test.js
// each reach `services/modelPinRecords.js` plus its three light leaves (db.js,
// renderTargets.js, runtimeEnv.js). Neither statically imports a record service:
// the DB suite seeds and reads with raw SQL and lets `clearRecordPin` pull
// decks.js the way production does, which is worth ~41 on its own. The production
// change adds NO import to any module — the collector sits behind the same
// memoized call-site `await import()` as the audit's other three stores, and the
// mode -> provider map stays in modelPinAudit.js rather than moving to a shared
// leaf, which would have cost ~54 (one more file in the static closure of every
// suite reaching routes/providers.js).
// Making the local image runtime describe itself the same way everywhere
// measures +65, and every one of those is the module-catalog rule rather than a
// heavy edge. The vocabulary the layers share — the status probe, the renderer's
// pre-flight refusal, regen.js, and the client, which re-exports it through
// imageGenModes.js so no component hand-copies a remedy kind — has to be a
// leaf under lib/ (it imports only runners.js), and registering a new lib/ file
// in index.js is mandatory (lib/index.test.js fails without it), which puts
// imageRuntimeRemedies.js into the closure of the ~57 suites that reach the
// barrel; the rest reach it through services/imageGen/local.js and regen.js,
// which classify a model's runtime with the same helper, plus the new suite's
// own closure. The diagnosis module itself (localRuntime.js, which pulls the
// model registry and the setup-check cache) measured a further +111 from the
// image-gen dispatcher and is NOT in this number: checkConnection reaches it
// through a memoized call-site await import(), so the ~110 suites that never
// probe a local runtime do not pay for it.
// The managed-app `.quality.json` publisher raises this by a further 38, all of
// it in two new suites, none of it a new edge into a widely-reached module:
// `services/git.commit.test.js` pays git.js's closure (~34) to pin that an
// automated commit is scoped to literal pathspecs, and
// `services/appQualitySnapshotFile.test.js` plus crud.js's static import of that
// dependency-free module account for the rest. The publisher itself reaches
// git.js and appQualityFederation.js through `await import()`, and the audit
// hook reaches the publisher the same way, so neither is in any closure.
// `lib/terminalReplay.js` raises this by a further 37 — one instantiation per
// test file whose closure reaches the `lib/index.js` barrel, and nothing more.
// It cannot be narrowed away: the catalog rule (root AGENTS.md) requires every
// new `server/lib/` module to be re-exported from the barrel, and
// `lib/index.test.js` fails without it. The module is deliberately
// dependency-free (a few regexes over a string), so it adds no edge into any
// subtree — its only consumer, `services/shell.js`, deep-imports it directly.
// Auditing reviewer and task-template model pins (#7339) measures +41, and none
// of it is a new edge into a heavy subtree. The shared reviewer -> provider-record
// table is a pure leaf (`lib/reviewerProviderMatchers.js`) importing only
// `providerModels.js`, `providerTypes.js` and `arrayUtils.js`, which every module
// that can reach it already instantiates; registering it in the `lib/` barrel is
// mandatory (`lib/index.test.js`) and costs one node in each barrel reacher's
// closure, and its own suite pulls those leaves plus `reviewerConfig.js`. The
// remaining ~22 is `services/modelPinAuditNotifier.js` taking its ONE static
// import — `lib/modelPinReconcile.js`, so the card and the panel name a pin's
// provider records with the same function — which lands in that module's own
// suite and in `bootstrap.js`'s closure; no server test file statically reaches
// `bootstrap.js`, so the production edge costs nothing. The two stores the new
// collectors read stay behind the audit's memoized call-site `await import()`
// (`services/taskTemplates.js` is never in a static closure), and
// `modelPinAudit.js` gaining `reviewerConfig.js` / `goalFidelity.js` cost
// nothing — `routes/providers.js` already reaches both through
// `lib/validation.js`.
// Fixing the sibling-process port mis-attribution (#7357) measures +37, all of
// it a new boundary test file plus one dependency-free leaf. The attribution
// rules live in `lib/ecosystemProcessPorts.js`, which imports nothing, so the
// ~13 existing closures that reach the two services now sharing it each gain one
// node. `services/appPortConfig.test.js` has to go through the real filesystem
// (the regression is "the config file must come back byte-identical", which the
// route suite's mocked writer cannot observe), so it pays its own closure. That
// closure is 24 rather than 83 because the same change moved `deriveUiPort` —
// three pure lines the write-back path was importing the whole 81-module
// `services/appListEnrichment.js` for — down into that leaf, which
// re-exports it for its existing callers.
//
// Raised to 106,200 for the Persistent Mind forge-issue capability, and to
// restore the documented ~1.5k of headroom. The capability's own net share is
// +34, because the new suite's closure (~94) is most of the way offset by the
// managed-app roster it shares with the task capability, which replaced a second
// app/tracker reader. The headroom is the larger half of this raise: #7357 above
// had already landed the number at EXACTLY the measured total, so any addition
// at all failed it — the same zero-headroom state #6305 raised it out of, and
// that is what makes this a budget rather than a high-water mark. Measured after
// both changes: 104,739.
//
// Raised to 107,700 for the Eidoverse foundation promote gate (#7455).
// Measured after the change: 106,329, so its own cost is +132. Most of that is
// ONE node on each of the ~60 closures that reach `services/userActions.js`,
// which now imports the extracted leaf `lib/secretKeys.js` instead of
// declaring `isSecretKey` inline — the extraction is what lets the federation
// gate ask the same question, and the leaf has no imports of its own, so the
// alternative was a second copy of the table. The rest is four small new
// suites and the mandatory `lib/` barrel rows. Nothing heavy gained an edge:
// the promote path's assay dependency is reached only from the ledger service,
// which only `routes/eidoverseWorldRoutes.js` imports. The remainder of the
// raise restores the ~1.5k of headroom this is meant to carry — the previous
// number had drifted back to three above the measured total, the same
// zero-headroom state #6305 raised it out of, where any addition at all fails.
//
// Raised to 109,200 for the Kilo Code and OpenChamber harnesses. Measured after
// the change: 107,699, so their own cost is +816 against the 106,883 this stood
// at beforehand. There is no new edge into a heavy subtree: `lib/kilo.js` and
// `lib/openchamber.js` are browser-safe leaves whose whole closure is
// `providerModels.js`, and almost all of the cost is those two nodes appearing
// on each of the ~375 closures that already reach `lib/providerVendors.js` —
// adding a vendor to that registry is what makes it one row instead of N call
// sites, and this is the price of the row. The rest is three new suites
// (`lib/kilo.test.js`, `lib/openchamber.test.js`, `lib/providerHarnesses.test.js`)
// and the mandatory `lib/` barrel rows. Two leaves rather than one is
// deliberate: OpenChamber is not a fork of Kilo or of OpenCode's argv — it is a
// control plane with a different prompt-delivery contract — and the "one file
// per vendor" split is what has kept each of these readable.
// The remainder of the raise restores the ~1.5k of headroom this is meant to
// carry: the previous number had drifted to ONE above the measured total, the
// zero-headroom state #6305 raised it out of, where any addition at all fails.
//
// Raised to 110,700 for the stale git lock fix (#7513). Measured after the
// change: 109,282, so its own cost is +82 — one new test file
// (`services/git.staleLock.test.js`) reaching `services/git.js`'s existing
// closure to cover `pull`/`syncBranch`/`ensureLatest`'s lock-clearing paths.
// No new heavy edge: `git.js` was already reached by a dozen other server
// test files. The remainder restores headroom the previous number had worn
// down to zero.
//
// Raised to 111,500 for `lib/jobFormFields.js`, the per-job configuration-form
// vocabulary + schemas: a NEW leaf on `lib/cosValidation.js` — one node on each
// of the ~131 closures that already reach the job schema, dragging no subtree
// with it (its only import is `zod`, which every one of those closures already
// carries). That is the shape this budget is meant to allow: the cost is one
// module, not a new heavy edge.
//
// This raise and the #7513 one above landed on INDEPENDENT branches, so the
// ceiling is re-measured against the combined tree rather than resolved by
// taking the larger of the two competing numbers — that would bank headroom
// neither branch ever verified. Measured after both: 109,991 (so jobFormFields
// costs +709 over #7513's 109,282), and the ceiling keeps the ~1.5k of real
// headroom this budget exists to carry rather than being pinned to the
// measurement.
// 111,500 → 111,700 (#7563): `routes/providers.js` gained `providerServices.js`
// and `providerGraph.js` gained `providerServiceInstances.js`, each one file
// deep, plus two new suites.
// 111,700 → 112,900 (#7564): the composite provider-id grammar is ONE
// dependency-free leaf (`lib/providerRef.js`) reached through `zodCompat.js`
// by every suite that validates a selection field, and its mirror
// (`aiToolkit/internal/providerRef.js`) by every suite that reaches the
// toolkit's provider service or validation — one node each on ~700 closures,
// no subtree. The resolver itself (`services/compositeProviders.js`) is
// reached only by `await import()` from the run paths and the routes, so its
// graph-store closure stays off every suite that does not test it. Measured
// after the change: 112,576, with five new suites; the ceiling keeps the same
// ~300 of headroom the previous number carried.
// 112,900 → 113,300 (#7567 rebase): three suites merged in parallel — the
// SWE-bench and LiveCodeBench benchmark sources (#7590, 154-module closures
// each, self-contained) and the CoS activity calendar (#7591, 44) — each fit
// under the ceiling alone and overshot it together by 82. No widely-reached
// module gained an eager import (the per-module closure diff against the
// pre-merge tree shows only those three new entries growing). Measured after
// the merge: 112,982; the ceiling keeps the same ~300 of headroom.
// 113,300 → 113,700 (CoS spawn-window settlement): `lib/cosSpawnWindow.js` is a
// dependency-free leaf, so it adds one node per closure that reaches it — six
// server modules (`routes/cosTaskRoutes.js`, `routes/cosInsightRoutes.js`,
// `routes/systemHealth.js`, `services/cos.js`, `services/activeProcessing.js`,
// `services/systemResources.js`) plus its own suite. No subtree. Measured after
// the change: 113,350 — the pre-change tree had already eroded to within single
// digits of the old ceiling, so this restores the ~350 of headroom the recent
// entries carry rather than leaving the next unrelated commit to trip it.
// 113,700 → 114,200 (#7609 catalog extraction lens): `lib/catalogSourceKinds.js`
// is a dependency-free leaf — the scrap source-kind vocabulary plus the
// extraction lens each kind implies — so it adds one node per closure that
// reaches it: `lib/catalogValidation.js` (which builds its ingest enum from
// the ids), `services/catalogExtraction.js`, the lib barrel, and its own
// suite. No subtree, and no widely-reached module gained an edge into one.
// Measured before 113,568, after 113,814; its whole share is 246. The
// alternative is what this issue exists to close: the lens re-declared as a
// private Set inside the extractor, parallel to the source-kind list at the
// Zod boundary, where a new ingest source silently reads a memoir through the
// fiction lens. Restores the ~390 of headroom the recent entries carry.
// 114,200 → 114,650 (agent loopback API token): two dependency-free-by-design
// leaves and one small service. `lib/agentApiToken.js` (the env-var name plus the
// `curl` argument that spends it) adds one node to the 22 closures that reach a
// prompt builder; `lib/localReviewBridge.js` (the review-bridge script path,
// over `fileUtils`, which those closures already carry) adds one to 75, most of
// them via `services/cosTaskPrompts.js` — it replaces the same `join(PATHS.root,
// …)` that builder open-coded. `services/agentApiAuth.js` reaches the auth/session
// subtree, so the widely-reached direct-CLI spawner takes it through an
// `await import()` instead; the TUI and runner spawn sites keep the static edge,
// which 12 closures pay. No existing widely-reached module gained an eager edge
// into a subtree. Measured before 114,119, after 114,253; its whole share is 134.
// Restores the ~400 of headroom the recent entries carry — main had eroded to 81,
// which is why an unrelated parallel merge kept tripping this.
// 114,650 → 115,100 (#7664 Brain threads): a new record type with a route, a
// ref registry and four suites. `lib/threadRefKinds.js` is a dependency-free
// leaf (the (kind, id) vocabulary plus its URL builder) and adds one node to
// the 35 closures reaching `lib/brainValidation.js`, plus the lib barrel.
// `services/threadRefs.js` keeps its single-kind lookups behind
// `await import()`, so the only static edges it adds are `lib/db.js` and
// `services/brainStorage.js` — both already carried by `routes/brain.js`, the
// one closure that reaches the new route. The rest is the suites themselves:
// `routes/brainThreads.test.js` is 162 of the 206, which is what ANY route test
// costs (express + the route under test), and the drift guard reaches the
// resolver through `await import()` so it costs 2 instead of 27. Measured
// before 114,486, after 114,692; its whole share is 206. Restores the ~400 of
// headroom the recent entries carry — main had eroded to 164 again.
// 115,100 → 115,300 (#7662 quota staleness): `lib/fleetQuotas.js` and
// `services/providerUsage.js` gain a new edge into `lib/quotaWindows.js`, a
// dependency-free leaf (staleness now needs the same window-period classifier
// the quota-burn gate already used) — so every closure that reaches either
// module without already reaching `quotaWindows.js` through `quotaBurn.js`
// pays one node for it. No subtree. Measured before 114,692, after 114,853;
// restores the ~400 of headroom the recent entries carry.
// 115,300 → 115,900 (#7643 scope adherence): three new lib leaves
// (`prdClauses.js`, `scopeAdherence.js`, `scopeAdherenceReasons.js`) and four
// suites. The leaves are cheap and the barrel rows they add cost 3 in total —
// `bm25.js`, `memoryQuery.js`, `textUtils.js`, `markdownText.js` and `jev.js`
// are all already reachable from `lib/index.js`. The whole share is 196, and
// 180 of it is `routes/apps/scopeAdherence.test.js` alone, which is what ANY
// route test using `validateRequest` costs (express + the route + the
// validation barrel): its siblings in that directory run 93 to 600, so it sits
// mid-pack. `services/scopeAdherence.test.js` costs 1, because the service
// reaches `jevRouter.js`, `untrustedContent.js` and `jev.js` only through
// `await import()`. Measured before 115,283, after 115,479; restores the ~400
// of headroom the recent entries carry — main had eroded to 17.
// 116,500 → 116,900 (post-fleet host import growth): the current server suite
// measures 116,547 static instantiations. This restores the established ~400
// headroom while the import graph remains unchanged by this PR.
// 116,100 → 116,500 (fleet host inbound usage): one new lib leaf,
// `fleetHostUsage.js`, one new service (`fleetLlmUsage.js`) and their two
// suites. The leaf's only edge is `openAiChatStream.js` for `normalizeUsage`,
// which `lib/index.js` already re-exports, so nothing gains a subtree — the
// whole share is the two new nodes once per reaching suite plus the two new
// test files' own closures. Measured before 116,066, after 116,111 (+45);
// restores the ~400 of headroom the recent entries carry — main had eroded
// to 34.
// The current tree also carries three avoidable operational edges: the review
// queue's feedback store, its action adapters, and H3 weight provisioning were
// imported at module scope even though each runs only from an explicit queue,
// mutation, forwarding, or H3-render path. Keep those boundaries deferred so
// unrelated server suites do not pay their subtrees.
// 116,500 -> 116,600 (reviewer configuration health): the health route's
// code-review mock adds 47 measured static instantiations across the suite;
// the production route keeps the service import dynamic to avoid that graph.
const MAX_STATIC_INSTANTIATIONS = 116900;


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
