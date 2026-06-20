import { describe, it, expect } from 'vitest';
import { reassignCollidingPorts } from './pm2Standardizer.js';

describe('reassignCollidingPorts', () => {
  it('moves a process off a taken port and rewrites both env.PORT and --port args', () => {
    // The reported bug: standardizer copied Vite's 5173/5174 even though 5173
    // was already listening.
    const processes = [
      { name: 'app-server', env: { NODE_ENV: 'development', PORT: 5173 } },
      { name: 'app-client', args: 'vite --host --port 5174', env: { VITE_PORT: 5174 } }
    ];
    const reassigned = reassignCollidingPorts(processes, [5173, 5174]);

    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[1].env.VITE_PORT).toBe(6001);
    expect(processes[1].args).toBe('vite --host --port 6001');
    expect(reassigned).toEqual([[5173, 6000], [5174, 6001]]);
  });

  it('keeps the same new value when an old port appears in multiple places of one process', () => {
    const processes = [
      { name: 'client', args: 'vite --host --port 5173', env: { PORT: 5173, VITE_PORT: 5173 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[0].env.VITE_PORT).toBe(6000);
    expect(processes[0].args).toBe('vite --host --port 6000');
  });

  it('leaves non-colliding ports untouched', () => {
    const processes = [{ name: 'srv', env: { PORT: 4321 } }];
    const reassigned = reassignCollidingPorts(processes, [5173, 5174]);
    expect(processes[0].env.PORT).toBe(4321);
    expect(reassigned).toEqual([]);
  });

  it('leaves an intra-config duplicate of a non-taken port untouched (value-keyed remap cannot split a shared value)', () => {
    const processes = [
      { name: 'a', env: { PORT: 3000 } },
      { name: 'b', env: { PORT: 3000 } }
    ];
    const reassigned = reassignCollidingPorts(processes, []);
    expect(processes[0].env.PORT).toBe(3000);
    expect(processes[1].env.PORT).toBe(3000);
    expect(reassigned).toEqual([]);
  });

  it('never reassigns a colliding port onto a port another process legitimately kept', () => {
    // server keeps 6000 (free); client's 5173 is taken and must NOT be bumped to 6000.
    const processes = [
      { name: 'server', env: { PORT: 6000 } },
      { name: 'client', env: { VITE_PORT: 5173 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[1].env.VITE_PORT).toBe(6001);
  });

  it('skips already-assigned ports when picking a free replacement', () => {
    // 6000 is taken, so the first reassignment lands on 6001, the next on 6002.
    const processes = [
      { name: 'a', env: { PORT: 5173 } },
      { name: 'b', env: { PORT: 5174 } }
    ];
    reassignCollidingPorts(processes, [5173, 5174, 6000]);
    expect(processes[0].env.PORT).toBe(6001);
    expect(processes[1].env.PORT).toBe(6002);
  });

  it('only treats *_PORT / PORT env keys as ports', () => {
    const processes = [{ name: 'a', env: { PORT: 5173, RETRIES: 5173 } }];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[0].env.RETRIES).toBe(5173); // not a port key
  });
});
