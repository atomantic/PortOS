import { describe, it, expect } from 'vitest';
import { resolveCreativeDirectorProjectCommand as resolve } from './projectCommands.js';

const REASON = 'Stopped by user';
const p = (status, over = {}) => ({ id: 'cd-1', status, ...over });
const withTreatment = { treatment: { scenes: [] } };

const reject409 = (message) => ({ outcome: 'reject', httpStatus: 409, code: 'INVALID_STATE', message: expect.stringMatching(message) });
const notFound = { outcome: 'reject', httpStatus: 404, code: 'NOT_FOUND', message: 'Project not found' };
const apply = (patch, advance = false, resetFailedScenes = false) => ({ outcome: 'apply', patch, advance, resetFailedScenes });
const skip = (skipped) => ({ outcome: 'skip', skipped });
const delegate = { outcome: 'delegate' };
const restartPlanning = apply({ status: 'planning', failureReason: null }, true);
const restartRendering = apply({ status: 'rendering', failureReason: null }, true);

// The issue's command table, one row per [label, project, event, expected].
const CELLS = [
  ['missing', null, 'start', notFound],
  ['missing', null, 'pause', notFound],
  ['missing', null, 'resume', notFound],
  ['missing', null, 'stop', skip('missing')],
  ['missing', null, 'agent-failed', skip('missing')],

  ['video draft', p('draft', { workspace: 'video' }), 'start', delegate],
  ['video rendering', p('rendering', { workspace: 'video' }), 'pause', delegate],
  ['video paused', p('paused', { workspace: 'video' }), 'resume', delegate],
  ['video failed', p('failed', { workspace: 'video' }), 'stop', delegate],
  ['video complete', p('complete', { workspace: 'video' }), 'stop', skip('terminal')],
  ['video rendering', p('rendering', { workspace: 'video' }), 'agent-failed', apply({ status: 'failed', failureReason: REASON })],
  ['video paused', p('paused', { workspace: 'video' }), 'agent-failed', skip('paused')],

  ['draft', p('draft'), 'start', apply({ status: 'planning' }, true)],
  ['draft', p('draft'), 'pause', reject409(/pause a draft/)],
  ['draft', p('draft'), 'resume', reject409(/not paused/)],
  ['draft', p('draft'), 'stop', apply(null)],
  ['draft', p('draft'), 'agent-failed', skip('draft')],

  ...['planning', 'rendering', 'stitching'].flatMap((status) => [
    [status, p(status), 'start', apply(null, true)],
    [status, p(status), 'pause', apply({ status: 'paused' })],
    [status, p(status), 'resume', reject409(/not paused/)],
    [status, p(status), 'stop', apply({ status: 'paused', failureReason: REASON })],
    [status, p(status), 'agent-failed', apply({ status: 'failed', failureReason: REASON })],
    // Starting a peer's in-flight project takes it over with a same-status echo.
    [`${status} peer replica`, p(status, { peerReplica: true }), 'start', apply({ status }, true)],
  ]),

  ['paused', p('paused'), 'start', restartPlanning],
  ['paused with treatment', p('paused', withTreatment), 'start', restartRendering],
  ['paused', p('paused'), 'pause', reject409(/pause a paused/)],
  ['paused', p('paused'), 'resume', restartPlanning],
  ['paused with treatment', p('paused', withTreatment), 'resume', restartRendering],
  ['paused', p('paused'), 'stop', apply(null)],
  ['paused', p('paused'), 'agent-failed', skip('paused')],

  ['failed', p('failed'), 'start', apply({ status: 'planning', failureReason: null }, true, true)],
  ['failed with treatment', p('failed', withTreatment), 'start', apply({ status: 'rendering', failureReason: null }, true, true)],
  ['failed', p('failed'), 'pause', reject409(/pause a failed/)],
  ['failed', p('failed'), 'resume', reject409(/not paused/)],
  ['failed', p('failed'), 'stop', skip('terminal')],
  ['failed', p('failed'), 'agent-failed', skip('terminal')],

  ...[['complete with final', p('complete', { finalVideoId: 'video-1' }), skip('complete')],
    ['complete without final', p('complete'), apply(null, true)]].flatMap(([label, project, start]) => [
    [label, project, 'start', start],
    [label, project, 'pause', reject409(/pause a complete/)],
    [label, project, 'resume', reject409(/not paused/)],
    [label, project, 'stop', skip('terminal')],
    [label, project, 'agent-failed', skip('terminal')],
  ]),
];

describe('resolveCreativeDirectorProjectCommand', () => {
  it.each(CELLS)('%s · %s', (_label, project, event, expected) => {
    expect(resolve(project, event, { reason: REASON })).toEqual(expected);
  });

  it('refuses an unknown event', () => {
    expect(() => resolve(p('draft'), 'restart')).toThrow(/Unknown/);
  });
});
