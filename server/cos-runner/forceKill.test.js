import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { killProcessTree } = vi.hoisted(() => ({ killProcessTree: vi.fn() }));
vi.mock('../lib/bufferedSpawn.js', () => ({ killProcessTree }));

import { armForceKill } from './forceKill.js';

const GRACE = 5000;

describe('armForceKill', () => {
  let activeAgents;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    activeAgents = new Map();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  const addAgent = (id, extra = {}) => {
    const agent = { process: { kill: vi.fn() }, ...extra };
    activeAgents.set(id, agent);
    return agent;
  };

  it('force-kills and drops the agent when it outlives the grace window', () => {
    const agent = addAgent('agent-1');
    armForceKill(activeAgents, 'agent-1', agent, { graceMs: GRACE });

    expect(activeAgents.has('agent-1')).toBe(true);
    vi.advanceTimersByTime(GRACE);

    expect(killProcessTree).toHaveBeenCalledWith(agent.process, 'SIGKILL');
    // The drop is the load-bearing half: an entry the runner keeps advertising
    // in GET /agents is re-adopted by the PortOS server on every orphan sweep
    // and counts against the Update page's "N CoS agents running" gate.
    expect(activeAgents.has('agent-1')).toBe(false);
  });

  // The regression: refusing to arm because `killTimer` was truthy let a SPENT
  // timer swallow a later termination. /pause leaves one behind that neither
  // clears the handle nor removes the entry, so a subsequent /terminate on that
  // agent never escalated and never dropped it — stranding the exact phantom
  // this escalation exists to reap.
  it('re-arms over a stale timer left by an earlier pause', () => {
    const agent = addAgent('agent-1', { paused: true });
    // Stand in for /pause's own timer: it only SIGKILLs, never drops the entry.
    agent.killTimer = setTimeout(() => {}, GRACE);

    armForceKill(activeAgents, 'agent-1', agent, { graceMs: GRACE });
    vi.advanceTimersByTime(GRACE);

    expect(killProcessTree).toHaveBeenCalledWith(agent.process, 'SIGKILL');
    expect(activeAgents.has('agent-1')).toBe(false);
  });

  it('clears the handle when it fires, so a settled timer never reads as armed', () => {
    const agent = addAgent('agent-1');
    armForceKill(activeAgents, 'agent-1', agent, { graceMs: GRACE });
    expect(agent.killTimer).not.toBeNull();

    vi.advanceTimersByTime(GRACE);

    expect(agent.killTimer).toBeNull();
  });

  it('does nothing when the agent already exited and was removed', () => {
    const agent = addAgent('agent-1');
    armForceKill(activeAgents, 'agent-1', agent, { graceMs: GRACE });
    activeAgents.delete('agent-1'); // a clean exit, or /kill, got there first

    vi.advanceTimersByTime(GRACE);

    expect(killProcessTree).not.toHaveBeenCalled();
  });

  // `dropState` clears the DURABLE runner record, which a resume reads. It is
  // only ever right for a kill relayed after the server already finalized the
  // agent — never for a pause.
  it('clears the durable record only when dropState is set', () => {
    const onDropState = vi.fn();
    const kept = addAgent('agent-keep');
    armForceKill(activeAgents, 'agent-keep', kept, { graceMs: GRACE, onDropState });
    vi.advanceTimersByTime(GRACE);
    expect(onDropState).not.toHaveBeenCalled();

    const dropped = addAgent('agent-drop');
    armForceKill(activeAgents, 'agent-drop', dropped, { graceMs: GRACE, dropState: true, onDropState });
    vi.advanceTimersByTime(GRACE);
    expect(onDropState).toHaveBeenCalledWith('agent-drop');
  });

  // The callback runs on a timer, outside any request: an uncaught throw would
  // take the whole runner process down.
  it('survives a throwing kill rather than crashing the runner', () => {
    const agent = addAgent('agent-1');
    killProcessTree.mockImplementationOnce(() => { throw new Error('handle already disposed'); });

    armForceKill(activeAgents, 'agent-1', agent, { graceMs: GRACE });
    expect(() => vi.advanceTimersByTime(GRACE)).not.toThrow();
    expect(activeAgents.has('agent-1')).toBe(false);
  });
});
