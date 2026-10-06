#!/usr/bin/env node
/** Opt-in, real production acceptance. No mocks, provider calls or live data. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, appendFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { acceptanceScene, syntheticSong } from './fixtures/eidoverseAcceptanceScene.js';
import { UPSTREAM_SHA, newReport, preflight, run, assertVideo, inspectGeometry, toneRatio, assertContainment } from './lib/eidoverseAcceptance.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists = path => access(path).then(() => true, () => false);

async function save(report, path) {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

export async function summarize(report, summaryPath) {
  const lines = ['## Eidoverse real acceptance', '', `Result: **${report.status}**`,
    `Upstream: \`${report.upstreamSha}\``, report.backend, '', '| Criterion | Result |', '| --- | --- |',
    ...Object.entries(report.criteria).map(([name, criterion]) => `| ${name} | ${criterion.status} |`),
    '', ...(report.criteria.host.reasons || []), report.reason || '',
    '', '```json', JSON.stringify(report, null, 2), '```',
    '', 'A prerequisite failure or synthetic validator test is never real acceptance. #9798 remains open until every criterion passes.', ''];
  if (summaryPath) await appendFile(summaryPath, lines.join('\n'));
  console.log(lines.join('\n'));
}

/** Discover only this invocation's container by its exact private input marker. */
async function watchContainer(plan, abort, state) {
  while (!state.done) {
    const ids = (await run(plan.docker, ['ps', '-q', '--filter', 'name=portos-mv-eido-'])).trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      let c;
      try { [c] = JSON.parse(await run(plan.docker, ['inspect', id])); } catch { continue; } // --rm race
      const input = c.Mounts.find(m => m.Type === 'bind' && m.Destination === '/input');
      if (!input) continue;
      const scene = await readFile(join(input.Source, 'scene.json'), 'utf8').then(JSON.parse, () => null);
      if (scene?.inlineScript !== plan.scene.inlineScript) continue;
      assertContainment(c, plan.imageId);
      state.container = { id: c.Id, root: dirname(input.Source) };
      if (state.mode === 'failure') {
        state.failureReached ||= await exists(join(state.container.root, 'output', 'intentional-failure.txt'));
      }
      if (state.mode === 'cancel' && !state.abortedOwned) {
        assert.equal(c.State.Running, true, 'owned container is running');
        state.abortedOwned = true;
        abort.abort(new Error('synthetic owned-container cancellation'));
      }
    }
    await delay(200);
  }
}

async function renderCase({ project, plan, audioPath, outputPath, mode = 'geometry', ...window }) {
  const { encodeEidoverseComposition } = await import('../server/services/musicVideo/eidoverseRender.js');
  const abort = new AbortController();
  const state = { mode, done: false };
  const timer = setTimeout(() => abort.abort(new Error('acceptance render exceeded 12 minutes')), 12 * 60 * 1000);
  let watchError;
  const watcher = watchContainer(plan, abort, state).catch(error => { watchError = error; abort.abort(error); });
  let renderError;
  try {
    await encodeEidoverseComposition({ project, plan, audioPath, outputPath, signal: abort.signal, ...window });
  } catch (error) { renderError = error; }
  finally { clearTimeout(timer); state.done = true; await watcher; }
  if (watchError) throw watchError;
  assert.ok(state.container, 'must observe this invocation\'s real owned container');
  const remaining = (await run(plan.docker, ['ps', '-aq', '--no-trunc'])).trim().split(/\s+/);
  assert.ok(!remaining.includes(state.container.id), 'owned container removed');
  assert.equal(await exists(state.container.root), false, 'private production scratch removed');
  if (mode === 'cancel') {
    assert.equal(state.abortedOwned, true, 'abort was triggered only after observing the running owned container');
    assert.ok(renderError, 'cancelled encoding rejected');
    assert.equal(await exists(outputPath), false, 'cancel never files a film');
  } else if (mode === 'failure') {
    assert.equal(state.failureReached, true, 'scene actually reached the deliberate failing setup');
    assert.equal(renderError?.code, 'EIDOVERSE_RENDER_FAILED', 'deliberate scene failure surfaces as EIDOVERSE_RENDER_FAILED');
    assert.equal(await exists(outputPath), false, 'failing scene never files a film');
  } else if (renderError) throw renderError;
  return { observedOwnedContainer: true, containerRemoved: true, scratchRemoved: true, noFilm: mode !== 'geometry' };
}

async function probe(path, plan, frames) {
  const parsed = JSON.parse(await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path]));
  return assertVideo(parsed, { ...plan, frames });
}

async function decodeFrame(path, plan, frame) {
  return await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${frame})`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' });
}

async function checkTone(path, start, wanted, unwanted) {
  const pcm = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', path,
    '-t', '0.5', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' });
  return toneRatio(pcm, wanted, unwanted);
}

async function live(report, reportPath, upstream) {
  assert.equal(process.env.PORTOS_EIDOVERSE_LIVE, '1', 'explicit PORTOS_EIDOVERSE_LIVE=1 required');
  assert.equal(process.env.PORTOS_EIDOVERSE_SOURCE_REVIEWED, '1', 'review source and license terms before builds/runs');
  let active = 'source';
  let root;
  try {
    assert.equal((await run('git', ['-C', upstream, 'rev-parse', 'HEAD'])).trim(), UPSTREAM_SHA, 'upstream checkout is at the pinned SHA');
    assert.equal((await run('git', ['-C', upstream, 'status', '--porcelain'])).trim(), '', 'independent upstream source must be clean');
    report.criteria.source = { status: 'pass', revision: UPSTREAM_SHA };
    active = 'build';
    report.portosSha = (await run('git', ['-C', REPO, 'rev-parse', 'HEAD'])).trim();
    for (const tag of ['eidoverse:render', 'portos-eidoverse-video:1']) {
      const [image] = JSON.parse(await run('docker', ['image', 'inspect', tag]));
      assert.equal(image.Os, 'linux', 'image OS is linux'); assert.equal(image.Architecture, 'amd64', 'image architecture is amd64');
      assert.equal(image.Config.Labels?.['org.portos.eidoverse.upstream'], UPSTREAM_SHA, 'build provenance label required');
      if (tag === 'portos-eidoverse-video:1') assert.equal(image.Config.Labels?.['org.portos.eidoverse.portos'], report.portosSha, 'portos provenance label matches this checkout');
      report.criteria.build[tag] = image.Id;
    }
    report.criteria.build.status = 'pass';
    root = await mkdtemp(join(tmpdir(), 'portos-eido-acceptance-'));
    const audioPath = join(root, 'synthetic.wav');
    await writeFile(audioPath, syntheticSong());
    const { prepareEidoverseRender } = await import('../server/services/musicVideo/eidoverseRender.js');
    const makeProject = (aspect, mode = 'geometry') => ({ id: 'synthetic-acceptance',
      treatment: { brief: { aspectRatio: aspect } }, audioAnalysis: { durationSec: 2 }, scenes: [],
      composition: { mode: 'eidoverse', eidoverseScene: acceptanceScene({ marker: randomUUID(), mode }) } });
    const outputs = {};
    const plans = {};
    for (const [criterion, aspect] of [['landscape', '16:9'], ['portrait', '9:16']]) {
      active = criterion;
      const project = makeProject(aspect), plan = await prepareEidoverseRender(project);
      const outputPath = join(root, `${criterion}.mp4`);
      const cleanup = await renderCase({ project, plan, audioPath, outputPath });
      report.criteria.containment = { status: 'pass', ...cleanup };
      report.criteria[criterion] = { status: 'pass', ...await probe(outputPath, plan, 48) };
      outputs[criterion] = outputPath; plans[criterion] = plan;
      await save(report, reportPath);
    }
    active = 'decodedGeometry';
    const previews = `${reportPath}.frames`;
    await mkdir(previews, { recursive: true });
    report.criteria.decodedGeometry.samples = {};
    for (const key of ['landscape', 'portrait']) {
      const plan = plans[key];
      report.criteria.decodedGeometry.samples[key] = [];
      for (const frame of [0, 24, 47]) {
        const rgb = await decodeFrame(outputs[key], plan, frame);
        const landmarks = inspectGeometry(rgb, plan.width, plan.height, frame);
        report.criteria.decodedGeometry.samples[key].push({ frame, landmarks });
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', outputs[key], '-vf',
          `select=eq(n\\,${frame}),scale=320:320:force_original_aspect_ratio=decrease`, '-frames:v', '1', '-y', join(previews, `${key}-${frame}.png`)]);
      }
    }
    report.criteria.decodedGeometry.status = 'pass';
    active = 'audioOffset';
    const project = makeProject('16:9'), plan = await prepareEidoverseRender(project);
    const excerpt = join(root, 'excerpt.mp4');
    await renderCase({ project, plan, audioPath, outputPath: excerpt, windowStart: 1, windowEnd: 2 });
    const excerptVideo = await probe(excerpt, plan, 24);
    report.criteria.audioOffset = { status: 'pass', excerptVideo,
      fullFirstToneRatio: await checkTone(outputs.landscape, 0.1, 330, 880),
      fullSecondToneRatio: await checkTone(outputs.landscape, 1.1, 880, 330),
      excerptToneRatio: await checkTone(excerpt, 0.1, 880, 330) };
    active = 'preroll';
    const continuity = [];
    for (const frame of [0, 12, 23]) {
      const full = inspectGeometry(await decodeFrame(outputs.landscape, plan, frame + 24), plan.width, plan.height, frame + 24);
      const cut = inspectGeometry(await decodeFrame(excerpt, plan, frame), plan.width, plan.height, frame + 24);
      assert.ok(Math.abs(full.red.x - cut.red.x) < 0.005, 'excerpt preserves accumulated simulation state');
      continuity.push({ fullFrame: frame + 24, excerptFrame: frame, fullX: full.red.x, excerptX: cut.red.x });
    }
    report.criteria.preroll = { status: 'pass', samples: continuity };
    for (const [criterion, mode] of [['cancellation', 'cancel'], ['failureCleanup', 'failure']]) {
      active = criterion;
      const project = makeProject('16:9', mode), plan = await prepareEidoverseRender(project);
      report.criteria[criterion] = { status: 'pass', ...await renderCase({ project, plan, audioPath, outputPath: join(root, `${mode}.mp4`), mode }) };
    }
    assert.ok(Object.values(report.criteria).every(c => c.status === 'pass'), 'every real criterion must pass');
    report.status = 'pass';
  } catch (error) {
    report.status = 'fail';
    // Do not publish arbitrary child-process logs, absolute paths or host environment.
    report.reason = `Real acceptance failed at ${active}; inspect the private execution log before retrying.`;
    report.criteria[active].status = 'fail';
    // Harness-authored assert messages are constant strings, so they name the failing check without leaking
    // anything; every other error (execFile embeds cmd/stderr) is reduced to its code/name.
    const harnessCheck = error instanceof assert.AssertionError && !error.generatedMessage ? error.message : null;
    if (harnessCheck) report.criteria[active].check = harnessCheck;
    console.error(`❌ ${report.reason}`);
    console.error(harnessCheck ? `${error.code}: ${harnessCheck}` : (error.code || error.name));
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
    await save(report, reportPath);
  }
}

export async function main(args = process.argv.slice(2)) {
  const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : join(tmpdir(), 'eidoverse-acceptance-report.json');
  if (args.includes('--preflight') && args.includes('--live')) {
    const report = newReport();
    report.status = 'fail';
    report.reason = '--preflight and --live are mutually exclusive; no acceptance attempted.';
    await save(report, reportPath);
    await summarize(report, process.env.GITHUB_STEP_SUMMARY);
    return 2;
  }
  if (args.includes('--summary') || args.includes('--build-failed') || args.includes('--source-unavailable')) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (args.includes('--build-failed') && report.criteria.host.status === 'pass' && report.criteria.build.status !== 'pass') {
      report.status = 'fail'; report.criteria.build.status = 'fail';
      report.reason = 'Image build or setup failed; real runtime criteria have not passed.';
      await save(report, reportPath);
    }
    if (args.includes('--source-unavailable')) {
      report.status = 'unavailable'; report.criteria.source.status = 'unavailable';
      report.reason = 'Source/license review was not accepted; no image build authorized or attempted.';
      await save(report, reportPath);
    }
    await summarize(report, process.env.GITHUB_STEP_SUMMARY);
    return acceptanceExitCode(report);
  }
  const report = newReport();
  report.criteria.host = await preflight();
  await save(report, reportPath);
  if (report.criteria.host.status !== 'pass') {
    report.reason = 'Suitable host unavailable; no build or acceptance attempted.';
  } else if (args.includes('--live')) {
    await live(report, reportPath, args[args.indexOf('--upstream') + 1]);
  } else {
    report.reason = 'Host preflight passed; real acceptance has not run.';
  }
  await save(report, reportPath);
  await summarize(report, process.env.GITHUB_STEP_SUMMARY);
  return acceptanceExitCode(report, { preflightOnly: args.includes('--preflight'), live: args.includes('--live') });
}

/** A successful prerequisite must never override a failed live verdict. */
export function acceptanceExitCode(report, { preflightOnly = false, live = false } = {}) {
  if (live) return report.status === 'pass' ? 0 : 2;
  if (preflightOnly) return report.criteria.host.status === 'pass' ? 0 : 2;
  return report.status === 'pass' ? 0 : 2;
}

if (isDirectlyInvoked(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => {
  console.error('❌ Acceptance invocation failed; no pass recorded.'); process.exitCode = 2;
});
