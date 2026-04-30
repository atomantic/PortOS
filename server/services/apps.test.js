import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn(),
  PATHS: { data: '/mock/data', root: '/mock/root' },
}));

vi.mock('../../lib/tailscale-https.js', () => ({
  hasTailscaleCert: () => false,
}));

vi.mock('../lib/ports.js', () => ({
  PORTS: { API: 5555, API_LOCAL: 5553, UI: 5554 },
}));

vi.mock('./taskSchedule.js', () => ({
  SELF_IMPROVEMENT_TASK_TYPES: [],
}));

import { readJSONFile } from '../lib/fileUtils.js';
import { getReservedPorts, invalidateCache, PORTOS_APP_ID } from './apps.js';

describe('getReservedPorts', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
  });

  it('reserves every per-process port (ports map values), not just uiPort/apiPort', async () => {
    // Mirror critical-mass: top-level apiPort/uiPort + engine processes that
    // expose IPC ports via the per-process `ports` map.
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS', uiPort: 5555, apiPort: 5555, devUiPort: 5554 },
        'critical-mass': {
          name: 'critical-mass',
          apiPort: 5563,
          uiPort: 5563,
          devUiPort: 5564,
          processes: [
            { name: 'critical-mass', ports: { api: 5563, coinbaseIpc: 5565, geminiIpc: 5566, cryptocomIpc: 5567 } },
            { name: 'critical-mass-coinbase', ports: { exchangeIpc: 5565 } },
            { name: 'critical-mass-gemini', ports: { geminiIpc: 5566 } },
            { name: 'critical-mass-cryptocom', ports: { cryptocomIpc: 5567 } },
            { name: 'critical-mass-ui', ports: { devUi: 5564 } },
          ],
        },
      },
    });

    const reserved = await getReservedPorts();

    // Includes engine IPC ports surfaced only through processes[].ports
    expect(reserved).toContain(5565);
    expect(reserved).toContain(5566);
    expect(reserved).toContain(5567);
    // Top-level port fields still reserved
    expect(reserved).toContain(5563);
    expect(reserved).toContain(5564);
    // PortOS baseline ports always reserved
    expect(reserved).toContain(5555);
    expect(reserved).toContain(5554);
    // De-duplicated and sorted ascending
    expect([...reserved]).toEqual([...new Set(reserved)].sort((a, b) => a - b));
  });

  it('ignores invalid port values in processes[].ports', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS' },
        'weird-app': {
          name: 'weird',
          processes: [
            { name: 'a', ports: { api: 5570, broken: null, alsoBroken: 'not-a-port', zero: 0 } },
          ],
        },
      },
    });

    const reserved = await getReservedPorts();
    expect(reserved).toContain(5570);
    expect(reserved).not.toContain(0);
    expect(reserved.every(p => Number.isInteger(p) && p > 0)).toBe(true);
  });
});
