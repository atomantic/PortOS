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
 * clean). The aggregate backstop is no longer a fixed total: the growth
 * describe below compares this same closure walk to the merge base.
 *
 * BEFORE narrowing one of these — or any other production import — read the
 * "Import scoping" section of `server/AGENTS.md`. Bypassing a barrel that a
 * suite `vi.mock()`s reaches the real implementation instead of the double, and
 * the failure surfaces in an unrelated test file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { staticImportClosure } from './staticImportGraph.js';
import {
  evaluateWorkingTreeImportGrowth,
  formatImportGrowthReport,
  measureClosures,
  measureWorkingTree,
} from '../../scripts/lib/importGrowth.js';

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
  ['services/apps.js', 'services/pm2.js',
    'keeps PM2 process projections out of the registry graph'],
  ['services/apps.js', 'services/streamingDetect.js',
    'reads process-type vocabulary from the dependency-free leaf'],
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
    expect(reaches('services/appProcessTypes.js', 'services/appProcessTypes.js')).toBe(true);
    expect(reaches('services/streamingDetect.js', 'services/appProcessTypes.js')).toBe(true);
    expect(reaches('services/appProcessStatus.js', 'services/apps.js')).toBe(true);
    expect(reaches('services/appProcessStatus.js', 'services/pm2.js')).toBe(true);
    expect(reaches('services/memoryEmbeddings.js', 'services/memoryConfig.js')).toBe(true);
    expect(reaches('lib/llmRoutePin.js', 'lib/textUtils.js')).toBe(true);
    expect(reaches('lib/slashdoInvocation.js', 'lib/providerVendors.js')).toBe(true);
    expect(reaches('services/voice/tools/pipeline.js', 'lib/pipelineStages.js')).toBe(true);
    expect(reaches('services/instances.js', 'services/instanceIdentity.js')).toBe(true);
    expect(reaches('lib/storyBible.js', 'lib/textUtils.js')).toBe(true);
  });

  it('keeps the process-type vocabulary dependency-free', () => {
    const entry = abs('services/appProcessTypes.js');
    expect([...staticImportClosure(entry).files]).toEqual([entry]);
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

const REPO_ROOT = dirname(SERVER_DIR);

describe('server suite import growth (#7993)', () => {
  it('memoized closure walk agrees with staticImportClosure', () => {
    const read = (rel) => {
      try {
        return readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8');
      } catch {
        return null;
      }
    };
    for (const sample of ['server/lib/db.js', 'server/lib/pipelineValidation.js', 'server/services/agentManagement.test.js', 'server/lib/editorial/checkInfra/taxonomy.js']) {
      const measured = measureClosures([sample], read);
      expect(measured.total, sample).toBe(staticImportClosure(join(REPO_ROOT, ...sample.split('/'))).files.size);
    }
  });

  // The absolute ceiling this replaced failed ordinary growth: shared modules
  // are counted once per reaching suite, so the repository total climbs even
  // when no heavy edge was added. The comparison below is the backstop the
  // per-edge rows cannot be. It fails closed when the base commit cannot be
  // read — a timeout or a throw here is a guard failure, not a pass.
  it('does not fan a heavy subtree into existing suites relative to the merge base', () => {
    const report = evaluateWorkingTreeImportGrowth({ repoRoot: REPO_ROOT });
    expect(report.ok, formatImportGrowthReport(report)).toBe(true);
  }, 60_000);

  // #6836: before the identity leaf split, 181 of these files' closures reached
  // services/instances.js. Most of them only needed an id read. The targeted
  // row above pins the direct callers; this counts the whole suite so a new
  // widely reached edge back onto instances.js is visible.
  it('keeps fewer than 60 server test files statically reaching services/instances.js', () => {
    const measured = measureWorkingTree(REPO_ROOT);
    const target = 'server/services/instances.js';
    const reachingCount = [...measured.tests.values()].filter((closure) => closure.has(target)).length;
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
