import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { aiStatusEvents, startAIOp } from './aiStatusEvents.js';

// Capture every emitted status event so we can assert which fields cross the
// `ai:status` channel that the CyberCity AI Core landmark consumes.
function captureEvents(fn) {
  const events = [];
  const handler = (e) => events.push(e);
  aiStatusEvents.on('status', handler);
  fn();
  aiStatusEvents.off('status', handler);
  return events;
}

describe('startAIOp building-association fields', () => {
  it('propagates appId + workspacePath onto every phase event', () => {
    const events = captureEvents(() => {
      const op = startAIOp({
        op: 'task-gen',
        label: 'Generating tasks',
        appId: 'app-42',
        workspacePath: '/repos/widget',
      });
      op.update('model:loading', 'Loading…');
      op.complete('Done');
    });

    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.appId).toBe('app-42');
      expect(e.workspacePath).toBe('/repos/widget');
    }
    expect(events.map(e => e.phase)).toEqual(['start', 'model:loading', 'complete']);
  });

  it('leaves appId/workspacePath undefined for unassociated internal ops', () => {
    const [start] = captureEvents(() => {
      startAIOp({ op: 'taste-summary', label: 'Summarizing taste' });
    });
    expect(start.appId).toBeUndefined();
    expect(start.workspacePath).toBeUndefined();
  });

  it('carries token throughput on the completion event', () => {
    const events = captureEvents(() => {
      const op = startAIOp({ op: 'jira-report', label: 'Report', appId: 'app-1' });
      op.complete('Done', { tokens: 480, tokensPerSec: 120 });
    });
    const complete = events.find(e => e.phase === 'complete');
    expect(complete.tokens).toBe(480);
    expect(complete.tokensPerSec).toBe(120);
    // The start event has no token info yet.
    const start = events.find(e => e.phase === 'start');
    expect(start.tokens).toBeUndefined();
  });
});
