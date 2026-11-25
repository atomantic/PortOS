import { describe, expect, it } from 'vitest';
import { MANAGED_RUNTIME_APPS, managedRuntimeAppNames, onDemandRuntimeAppNames } from './managedRuntimeApps.js';
import { ASSESSABLE_RUNTIMES, LOCAL_RUNTIMES } from './localProviderRuntime.js';
import { LLAMA_APP, MTPLX_APP, SLOTSTREAM_APP } from './managedDaemon.js';

describe('managed runtime table', () => {
  it.each(Object.keys(MANAGED_RUNTIME_APPS))('%s has a LOCAL_RUNTIMES row and is assessable', (id) => {
    expect(LOCAL_RUNTIMES[id]?.id).toBe(id);
    expect(ASSESSABLE_RUNTIMES).toContain(id);
  });

  it('keeps the PM2 names stable (a rename would orphan a running process)', () => {
    expect(managedRuntimeAppNames()).toEqual([
      'portos-llama-server', 'portos-mtplx', 'portos-slotstream', 'portos-splash', 'portos-mkserve',
    ]);
    expect([LLAMA_APP, MTPLX_APP, SLOTSTREAM_APP]).toEqual(managedRuntimeAppNames().slice(0, 3));
  });

  it('lists the on-demand runtimes the boot dump excludes', () => {
    expect(onDemandRuntimeAppNames()).toEqual(['portos-mtplx', 'portos-slotstream', 'portos-splash', 'portos-mkserve']);
  });
});
