import { describe, it, expect } from 'vitest';
import { buildHealthAlertInvestigation } from './healthAlertAgentTask.js';

describe('buildHealthAlertInvestigation', () => {
  // The resolve curl must target the spawn-time token so an HTTPS install's agent
  // lands on the loopback mirror instead of a TLS-only :5555 (#12405).
  it('points the resolve call at the {portosApiUrl} token with no hardcoded origin', () => {
    const { prompt } = buildHealthAlertInvestigation({ id: 'alert-1', title: 'Example alert', type: 'example' });
    expect(prompt).toContain('curl -sS -X POST "{portosApiUrl}/api/review/queue/resolve"');
    expect(prompt).toContain('"id":"health:alert-1"');
    expect(prompt).not.toMatch(/localhost:5555|:5553/);
  });
});
