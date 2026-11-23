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
 * Individual narrowings are not pinned edge by edge: re-adding a heavy edge
 * fails the base-relative growth describe below, which compares this same
 * closure walk to the merge base. What stays here are the architectural
 * boundaries, the CI-selection cuts (the growth guard does not measure
 * selection) and the hoisted-import guard.
 *
 * BEFORE narrowing a production import, read the
 * "Import scoping" section of `server/AGENTS.md`. Bypassing a barrel that a
 * suite `vi.mock()`s reaches the real implementation instead of the double, and
 * the failure surfaces in an unrelated test file.
 */

import { beforeAll, describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, posix, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { staticImportClosure as walkImportClosure, staticImportSpecifiers } from './staticImportGraph.js';
import {
  evaluateWorkingTreeImportGrowth,
  formatImportGrowthReport,
  measureClosures,
  measureWorkingTree,
} from '../../scripts/lib/importGrowth.js';
import { moduleSpecifiers } from '../../scripts/lib/moduleGraph.js';

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// The tree is read-only here, so every closure below shares one read and one
// existence probe per file instead of repeating them for each entry.
const memoize = (fn) => {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key));
    return cache.get(key);
  };
};
const closureIo = { specifiers: memoize(staticImportSpecifiers), exists: memoize(existsSync) };
const staticImportClosure = (entry) => walkImportClosure(entry, closureIo);

// Server-relative POSIX paths, so a failure names `lib/db.js` rather than the
// absolute path of whoever's checkout is running the suite.
const abs = (relative) => join(SERVER_DIR, ...relative.split('/'));
const reaches = (entry, target) => staticImportClosure(abs(entry)).files.has(abs(target));

// The reusable engine cannot acquire Music Video persistence or finishing through an indirect import.
it('keeps every shared film module outside the Music Video service graph', () => {
  for (const name of readdirSync(abs('services/film')).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))) {
    const closure = staticImportClosure(abs(`services/film/${name}`)).files;
    expect([...closure].filter((file) => file.startsWith(`${abs('services/musicVideo')}${sep}`)), name).toEqual([]);
  }
  expect(reaches('services/film/sync.js', 'lib/musicVideo/musicVideoBlender.js')).toBe(true);
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

// `vitest related` follows dynamic imports, so a lazy import() narrows the
// static closure above but not CI selection. Each row is an edge cut from the
// dynamically connected CoS cluster (#12285): the entry must import its target
// neither way. Re-measure with `node scripts/lib/importReach.js <source>`.
// The project store and the modules above it that it must never load (#17577).
const MUSIC_VIDEO_STORE = /^services\/musicVideo\/(?:projects|requireProject)\.js$/;
const MUSIC_VIDEO_STORE_UPWARD = /^services\/(?:musicVideo\/(?:projectPresentation|editResult|plateReview|shotSegments|pacingRecut|handoff|projectBoardEdits|projectFilmActions|blender\/[^/]+)\.js|storyboards\/followShots\.js|trackSunoImport\.js|imageGen\/local\.js|film\/[^/]+\.js)$/;
const SELECTION_CUTS = [
  ['services/llamaServerManager.js', 'services/specDecodeModels.js',
    'resolves launcher paths from the leaf preset module so the download stack stays out of its closure'],
  ['services/branchReconcile/classify.js', /^services\/(?:git\.js$|worktreeManager\.js$|branchReconcile\.js$|cos\/)/,
    'classifies observed facts without importing reconciliation or CoS orchestration'],
  ['services/cos/cosClaimOwnershipState.js', 'services/cos/cosClaimOwnership.js',
    'owns the shared state fence without importing its reconciliation consumers'],
  ['services/systemActivityNotify.js', 'services/systemActivityWatchers.js',
    'never re-exports boot observers into notification producers'],
  ['services/memoryConfig.js', 'services/cos/cos.js',
    'updates memory approval counts through the declaring agent lifecycle module'],
  ['services/worktreeManager.js', 'services/cos/cosClaimOwnership.js',
    'shares the ownership fence and trusted reader without reconciliation dependencies'],
  ['services/promptRunner.js', 'services/compositeProviders.js',
    'uses the toolkit resolver already registered before runners start'],
  ['services/systemActivityNotify.js', 'services/mediaJobQueue/index.js',
    'keeps boot subscriptions in systemActivityWatchers.js'],
  ['services/pm2.js', 'services/readinessNotify.js',
    'notifies readiness subscribers through the readinessSignal.js leaf'],
  ['services/fleetLlmHost.js', 'services/fleetHostNotify.js',
    'signals host changes through the fleetHostSignal.js leaf'],
  ['services/promptRunner.js', 'services/autoFixer.js',
    'reports fallback lifecycle through handlers initAutoFixer() registers in providerRecoveryHooks.js'],
  // #17499: lazy imports whose target statically imported the importer.
  ['services/cos/cos.js', 'services/agent/agentManagement.js',
    'recovers orphans through handlers registerBootHooks() registers in bootHookRegistry.js'],
  ['services/git.js', 'services/prProbe.js',
    'reads the merged PR through the prView.js leaf'],
  ['services/git.js', 'services/branchReconcile.js',
    'retires merged branches through the cleanup registerBootHooks() registers in bootHookRegistry.js'],
  // #17692: boot recovery must not pull the render pipeline into the static closure or into this file's import list.
  ['services/bootstrap.js', /^services\/musicVideo\/(?:render|excerptRender)\.js$/,
    'recovers stuck renders through loaders registerBootHooks() registers in bootHookRegistry.js'],
  ['services/worktreeManager.js', /^services\/(?:git|prProbe|repoBranchSnapshot|branchReconcile)\.js$/,
    'only re-exports services/worktree/*, which keeps these reads as non-inverting lazy imports'],
  ['services/cos/cosClaimOwnership.js', 'services/branchReconcile.js',
    'reads owner decisions from branchRetirementDecision.js and forge shipment from branchReconcile/forgeShipment.js'],
  ['services/apps.js', 'services/taskSchedule.js',
    'resets watcher cooldowns through taskScheduleStore.js'],
  // #17578: music video modules that resolve the master or plan a cut, not render it.
  ...[
    'services/musicVideo/performanceShot.js', 'services/musicVideo/vocalStem.js', 'services/federatedMedia/sourceAudio.js',
    'services/musicVideo/audioTiming.js', 'services/musicVideo/lyricAlign.js', 'services/musicVideo/lyricAlignCore.js',
    'services/musicVideo/lyricVerify.js', 'services/musicVideo/performanceRepair.js', 'services/musicVideo/revisionService.js',
    'services/musicVideo/vocalSeparation.js', 'services/musicVideo/renderPlan.js', 'services/musicVideo/renderCleanup.js',
    'services/musicVideo/masterAudioPath.js', 'services/musicVideo/renderActivityState.js', 'services/musicVideo/blender/song.js',
  ].map(entry => [entry, 'services/musicVideo/render.js', 'resolves the master through masterAudioPath.js and render activity through renderActivityState.js']),
  ['services/musicVideo/shotSegments.js', 'services/musicVideo/render.js',
    'plans through renderPlan.js, builds args with renderFfmpegArgs.js and reads render activity from renderActivityState.js'],
  // #17896: the edges that tied nearly every service into one test-selection cluster.
  ...[
    ['services/authGate.js', 'services/managedVisitors.js'],
    ['services/autonomousJobs/scriptHandlers.js', 'services/eidoverseWorld.js'],
    ['services/cos/cos.js', 'services/persistent/persistentMindAdapter.js'],
    ['services/creativeDirector/agentBridge.js', 'services/creative/toolRegistry.js'],
    ['services/creativeDirector/planAdvance.js', 'services/creative/toolRegistry.js'],
    ['services/creativeDirector/local.js', 'services/creativeDirector/firstPassGen.js'],
    ['services/creativeDirector/stopProject.js', 'services/agent/agentManagement.js'],
    ['services/instanceFeatures.js', /^services\/eidoverse(?:Runtime)?\.js$/],
    ['services/mindToolRecipes.js', 'services/cos/cosToolRegistry.js'],
    ['services/prWatcher.js', 'services/agent/agentWorktreeCleanup.js'],
  ].map(([entry, target]) => [entry, target, 'loads it by name through lib/lateBoundServices.js']),
  ['services/apps.js', 'services/layeredIntelligence.js',
    'reads the effective config from layeredIntelligence/config.js'],
  ['services/backupRestoreRecovery.js', 'services/syncOrchestrator.js',
    'rewinds peer cursors through the syncCursors.js leaf'],
  ['services/dataSync.js', 'services/sharing/peerSync.js',
    'reads outbound coverage from sharing/peerOutboundCoverage.js'],
  ['services/privacyVault.js', 'services/privacyScan.js',
    'parses addresses with lib/cityState.js'],
  ['services/runner.js', 'services/agent/agentCliSpawning.js',
    'reads Claude settings from lib/claudeSettingsEnv.js'],
  // #17577: the Music Video project store and the siblings it imports never import back up.
  ['services/musicVideo/projects.js', MUSIC_VIDEO_STORE_UPWARD,
    'is the low-level store; board edits and film workflows import it from projectBoardEdits.js and projectFilmActions.js'],
  ['services/musicVideo/mediaPool.js', MUSIC_VIDEO_STORE,
    'keeps cross-project deletion in mediaPoolDelete.js'],
  ['services/musicVideo/catalogLinks.js', MUSIC_VIDEO_STORE,
    'reads the project through the getProject the store hands in'],
  ['services/musicVideo/referenceLabels.js', MUSIC_VIDEO_STORE,
    'reads and writes the project through the accessors the store hands in'],
  ['services/musicVideo/shotSegmentPaths.js', /^services\/musicVideo\/(?:shotSegments|projects)\.js$/,
    'is the leaf the store removes a deleted project\'s segments through'],
  // #17619: getIo / command broadcast / film emit lived on the socket composition root.
  ['services/backup.js', 'services/socket.js',
    'reads the live io through the socketIo.js leaf'],
  ['services/moodBoard/analyzeJob.js', 'services/socket.js',
    'publishes analyze progress through the socketIo.js leaf'],
  ['services/moodBoard/generateMore.js', 'services/socket.js',
    'publishes generate progress through the socketIo.js leaf'],
  ['services/moodBoard/renderItem.js', 'services/socket.js',
    'publishes item-render progress through the socketIo.js leaf'],
  ['services/storyboards/make.js', 'services/socket.js',
    'publishes make progress through the socketIo.js leaf'],
  ['services/stackerNewsScheduler.js', 'services/socket.js',
    'publishes sync invalidation through the socketIo.js leaf'],
  ['routes/commands.js', 'services/socket.js',
    'broadcasts command output through the socketIo.js leaf'],
  ['services/codeAnimation/films.js', 'services/socket.js',
    'emits film frames through codeAnimation/events.js'],
  // #17576: a project read presents process pins without the stage orchestrators.
  ['services/musicVideo/projectPresentation.js', 'services/musicVideo/castAndSetsService.js',
    'presents Cast & Sets through the processPins.js leaf'],
  ['services/musicVideo/projectPresentation.js', /^services\/musicVideo\/(?:autonomousService\.js|autonomous\/autonomousRunStore\.js)$/,
    'presents an autonomous run through the processPins.js leaf'],
  ['services/musicVideo/processPins.js', /^services\/musicVideo\/(?:projects\.js|castAndSetsService\.js|autonomousService\.js|autonomous\/autonomousRunStore\.js)$/,
    'owns the process pins without the stage orchestrators or the project store'],
  // #17579: sibling pairs inside musicVideo/ are one-way, not hidden behind lazy import().
  ['services/musicVideo/compositionDocument.js', 'services/musicVideo/documentRender.js',
    'leaves the native-playback verdict to documentRender.js, which sits above it'],
  ['services/musicVideo/compositionRender.js', /^services\/musicVideo\/(?:compositionDocument|lyricPlaythrough)\.js$/,
    'receives the lyric overlay stager from lyricOverlayStage.js through its caller'],
  ['services/musicVideo/youtubeThumbnail.js', 'services/musicVideo/coverArt.js',
    'shares the cover helpers through the coverArtShared.js leaf'],
  ['services/musicVideo/blender/song.js', 'services/musicVideo/blender/owner.js',
    'builds the song context while blender/owner.js owns the workspace write'],
  ['services/musicVideo/lyricAlignJob.js', 'services/musicVideo/songRevision.js',
    'runs the re-time handler songRevision.js and the route hand in'],
];

// Runtimes that import the queue back load through bootHookRegistry.js (#17499).
const QUEUE_IMPORTING_RUNTIME = /^services\/(?:videoGen\/(?:topazJob|upscaleJob|stitchJob|verticalJob)|loraTraining\/index)\.js$/;
const productionModulesIn = (dir) => readdirSync(abs(dir))
  .filter(file => file.endsWith('.js') && !file.endsWith('.test.js') && !file.endsWith('.test.fixture.js'))
  .map(file => `${dir}/${file}`);

const importTargets = (entry) => {
  const { statics: eager, deferred: lazy } = moduleSpecifiers(readFileSync(abs(entry), 'utf-8'), entry);
  return [...eager, ...lazy].filter((spec) => spec.startsWith('.'))
    .map((spec) => posix.normalize(posix.join(posix.dirname(entry), spec)));
};

describe('CI-selection cuts stay cut (#12285)', () => {
  it.each(SELECTION_CUTS)('%s imports %s neither statically nor dynamically — it %s', (entry, target) => {
    expect(importTargets(entry)).not.toContainEqual(typeof target === 'string' ? target : expect.stringMatching(target));
  });

  it('keeps worktree modules on the shared ownership fence and off branch reconciliation', () => {
    const entries = productionModulesIn('services/worktree');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(importTargets(entry), entry).not.toContain('services/cos/cosClaimOwnership.js');
      expect(importTargets(entry), entry).not.toContain('services/branchReconcile.js');
    }
  });

  it('keeps every media queue module off the runtimes that import the queue', () => {
    const entries = productionModulesIn('services/mediaJobQueue');
    expect(entries).toContain('services/mediaJobQueue/execution.js');
    for (const entry of entries) {
      expect(importTargets(entry), entry).not.toContainEqual(expect.stringMatching(QUEUE_IMPORTING_RUNTIME));
    }
  });

  // Positive control for the Music Video cuts: the workflows above the store still import what it no longer does.
  it('sees the upward imports the Music Video workflow modules own', () => {
    expect(importTargets('services/musicVideo/projectBoardEdits.js').filter(target => MUSIC_VIDEO_STORE_UPWARD.test(target)))
      .toEqual(expect.arrayContaining(['services/storyboards/followShots.js', 'services/musicVideo/editResult.js', 'services/musicVideo/plateReview.js']));
    expect(importTargets('services/musicVideo/projectFilmActions.js').filter(target => MUSIC_VIDEO_STORE_UPWARD.test(target)))
      .toEqual(expect.arrayContaining(['services/musicVideo/blender/fork.js', 'services/film/fork.js', 'services/trackSunoImport.js']));
    expect(importTargets('services/musicVideo/mediaPoolDelete.js')).toContainEqual(expect.stringMatching(MUSIC_VIDEO_STORE));
  });

  it('the leaves the cut entries import stay import-free', () => {
    for (const leaf of [
      'services/readinessSignal.js',
      'services/fleetHostSignal.js',
      'services/provider/providerRecoveryHooks.js',
      'services/bootHookRegistry.js',
      'services/socketIo.js',
    ]) expect(importTargets(leaf), leaf).toEqual([]);
  });

  // Positive control: the cut callers still name the leaf, so an empty scan cannot pass.
  it('still sees the socketIo.js and film-event edges the cut callers keep (#17619)', () => {
    expect(importTargets('services/backup.js')).toContain('services/socketIo.js');
    expect(importTargets('routes/commands.js')).toContain('services/socketIo.js');
    expect(importTargets('services/codeAnimation/films.js')).toContain('services/codeAnimation/events.js');
    expect(importTargets('services/socket.js')).toContain('services/socketIo.js');
  });

  it('still sees the processPins.js edge a project read keeps (#17576)', () => {
    expect(importTargets('services/musicVideo/projectPresentation.js')).toContain('services/musicVideo/processPins.js');
    expect(importTargets('services/musicVideo/processPins.js')).toContain('services/musicVideo/castAndSets.js');
  });

  // Positive control for the media scan: the boot owner still names every runtime.
  it('still sees the runtime loaders bootHooks.js registers', () => {
    expect(importTargets('services/bootHooks.js').filter(target => QUEUE_IMPORTING_RUNTIME.test(target))).toHaveLength(5);
    expect(importTargets('services/bootHooks.js')).toEqual(expect.arrayContaining([
      'services/musicVideo/render.js',
      'services/musicVideo/excerptRender.js',
    ]));
  });

  // Positive control: the scanner sees the observer's own lazy imports.
  it('still sees the static edges fleetHostNotify.js keeps', () => {
    expect(importTargets('services/fleetHostNotify.js')).toEqual(expect.arrayContaining(['services/fleetLlmHost.js', 'services/fleetHostSignal.js']));
  });

  it('still sees the dynamic edges readinessNotify.js keeps', () => {
    expect(importTargets('services/readinessNotify.js')).toContain('services/systemHealthSnapshot.js');
  });
});

/**
 * Hoisted test imports (#7951).
 *
 * The inverse of a deferred import, and it defends a runner budget rather than a module
 * count. A test file that loads a large graph with `await import()` INSIDE an
 * `it()` or a `beforeAll` pays vitest's transform pipeline for that whole graph
 * the first time any worker touches it, and that cost is charged against
 * `testTimeout` / `hookTimeout`. Measured under a full `cd server && npm test`
 * on macOS, against ~445ms for the same import in a quiet node process:
 *
 *   routes/imageGen.js ......... 29,789ms   (beforeAll -> "Hook timed out in 10000ms")
 *   services/cos/cosToolRegistry.js  34,571ms   (it()      -> "Test timed out in 10000ms")
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
 * Asserted BOTH ways: the file must still name the
 * specifier (a row whose import was deleted is a different change), and the
 * call must still sit ahead of the first test/hook registration in the file.
 */
// [test file, specifier it must import at file scope, why]
const HOISTED = [
  ['routes/imageGen.multipart.test.js', './imageGen.js',
    'the route graph costs ~30s to transform cold, which a beforeAll charges to hookTimeout'],
  ['services/beeperOutboxHumanGate.test.js', './cos/cosToolRegistry.js',
    'the CoS tool registry costs ~35s to transform cold, which an it() charges to testTimeout'],
  ['routes/settings.secretsStrip.test.js', './settings.js',
    'warms the graph once so each vi.resetModules() re-import costs under a second'],
  ['routes/peerSyncAuthIntegration.test.js', './peerSync.js',
    'warms the peer-sync route graph once, for the same vi.resetModules() reason'],
  ['routes/peerSyncAuthIntegration.test.js', '../services/auth.js',
    'warms the auth service the first test reaches before it can build an app'],
  ['lib/workTracker.trackerInstructions.test.js', '../services/taskPromptDefaults.js',
    'the shipped prompt catalog cold-transforms past the expansion test budget under full-run contention'],
  ['lib/workTracker.trackerInstructions.test.js', './auditCatalog.js',
    'the audit catalog loads with that same expansion and must stay outside the test budget'],
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
  // One head walk feeds both the growth comparison and the instances.js
  // reach count. evaluateWorkingTreeImportGrowth used to walk again.
  let headMeasurement;
  beforeAll(() => {
    headMeasurement = measureWorkingTree(REPO_ROOT);
  }, 60_000);

  it('memoized closure walk agrees with staticImportClosure', () => {
    const read = (rel) => {
      try {
        return readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8');
      } catch {
        return null;
      }
    };
    for (const sample of ['server/lib/db.js', 'server/lib/pipelineValidation.js', 'server/services/agent/agentManagement.test.js', 'server/lib/editorial/checkInfra/taxonomy.js']) {
      const measured = measureClosures([sample], read);
      expect(measured.total, sample).toBe(staticImportClosure(join(REPO_ROOT, ...sample.split('/'))).files.size);
    }
  });

  // The absolute ceiling this replaced failed ordinary growth: shared modules
  // are counted once per reaching suite, so the repository total climbs even
  // when no heavy edge was added. The comparison below is the backstop for
  // per-edge regressions. It fails closed when the base commit cannot be
  // read — a timeout or a throw here is a guard failure, not a pass.
  it('does not fan a heavy subtree into existing suites relative to the merge base', () => {
    const report = evaluateWorkingTreeImportGrowth({ repoRoot: REPO_ROOT, headMeasurement });
    expect(report.ok, formatImportGrowthReport(report)).toBe(true);
    if (!report.skipped) expect(report.timings.headCollectMs).toBeNull();
  }, 60_000);

  // #6836: before the identity leaf split, 181 of these files' closures reached
  // services/instances.js. Most of them only needed an id read. This counts
  // the whole suite so a new widely reached edge back onto instances.js is
  // visible.
  it('keeps fewer than 60 server test files statically reaching services/instances.js', () => {
    const target = 'server/services/instances.js';
    const reachingCount = [...headMeasurement.tests.values()].filter((closure) => closure.has(target)).length;
    expect(
      reachingCount,
      `${reachingCount} server test files still statically reach services/instances.js (was 181 before #6836's instanceIdentity.js leaf split). If this crept back up, check for a caller that only needs identity (getInstanceId/ensureInstanceId/getSelf/ensureSelf/updateSelf/UNKNOWN_INSTANCE_ID) re-widening its import back onto instances.js instead of instanceIdentity.js.`,
    ).toBeLessThan(60);
  }, 60_000);
});

// #16096: request validation is its own leaf. ~113 route/service files import
// only validateRequest; if this grows past errorHandler.js, every one of them
// pays for the new edge again.
it('keeps the validateRequest leaf to itself and errorHandler.js', () => {
  const closure = staticImportClosure(abs('lib/validateRequest.js')).files;
  expect([...closure].map((file) => relative(SERVER_DIR, file)).sort()).toEqual([
    'lib/errorHandler.js',
    'lib/validateRequest.js',
  ]);
});

// The shared compiler must remain usable without loading project mutations.
it('keeps Video compilation independent of project storage and execution', () => {
  const closure = staticImportClosure(abs('lib/creativeDirectorVideoCompiler.js')).files;
  expect(closure.has(abs('lib/grokVideoClip.js'))).toBe(true);
  expect(closure.has(abs('lib/reactorVideoClip.js'))).toBe(true);
  expect(closure.has(abs('services/creativeDirector/projectsLogic.js'))).toBe(false);
  expect(closure.has(abs('services/creativeDirector/videoExecution.js'))).toBe(false);
  // The compiler is a pure render-pin leaf: no route-schema module (or the shared fragments they use) may enter its closure.
  expect([...closure].filter((file) => /(?:Validation|sharedSchemas)\.js$/.test(file))).toEqual([]);
});

describe('shared provider type leaf', () => {
  it('keeps provider models independent of the type leaf and browser-safe', () => {
    expect(reaches('lib/provider/providerModels.js', 'lib/provider/providerTypes.js')).toBe(false);
    const closure = staticImportClosure(abs('lib/provider/providerTypes.js'));
    expect(closure.packages.size).toBe(0);
    expect(reaches('lib/provider/providerTypes.js', 'lib/provider/providerModels.js')).toBe(true);
  });
});

// #16558: each heavy single-feature package is loaded where its feature runs, so
// none of them is paid for by every boot. Control: the walk still sees a package
// that is imported statically, so a resolver gap cannot make this look clean.
describe('heavy single-feature packages stay out of the boot closure', () => {
  const closure = staticImportClosure(abs('index.js'));
  it.each(['playwright-core', '@cantoo/pdf-lib', 'google-auth-library', 'three', 'sharp', '@babel/parser'])(
    'does not reach %s through static imports from index.js',
    (pkg) => {
      expect([...closure.packages].filter((spec) => spec === pkg || spec.startsWith(`${pkg}/`))).toEqual([]);
    },
  );
  it.each(['routes/apps/index.js', 'routes/musicVideo.js', 'routes/localLlm.js'])(
    'keeps native image processing and JavaScript parsing off ordinary requests to %s', (entry) => {
      const { packages } = staticImportClosure(abs(entry));
      expect(packages.has('sharp')).toBe(false);
      expect(packages.has('@babel/parser')).toBe(false);
    },
  );
  it('arms local model subscriptions before either HTTP router loads', () => {
    expect(closure.files.has(abs('services/localModelObservations.js'))).toBe(true);
  });
  it('loads the worktree manager on demand', () => {
    expect(closure.files.has(abs('services/worktreeManager.js'))).toBe(false);
  });
  // Measured at 1,433 after boot recovery of the music-video render pipeline
  // moved behind registerBootHooks() (#17692). The cap keeps 40 modules of
  // headroom so a few independent PRs can each add a boot-reachable leaf and
  // still merge. A boot-reachable addition that would cross this cap has to
  // defer or offset that import in the same change; do not raise the cap to
  // absorb it.
  it('loads at most 1,473 local modules before boot', () => {
    expect(closure.files.size).toBeLessThanOrEqual(1473);
    expect(closure.files.size).toBeLessThanOrEqual(1473 - 25);
  });
  it('still sees a package that index.js reaches statically', () => {
    expect(closure.packages.has('express')).toBe(true);
  });
});
