import { describe, expect, it } from 'vitest';
import { buildSocketEventCatalog } from './socketEventCatalog.js';

describe('socket event catalog', () => {
  it('projects domains, directions, source pointers, and runtime-backed coverage', () => {
    const catalog = buildSocketEventCatalog();
    expect(catalog.stats.events).toBeGreaterThan(100);
    expect(catalog.stats.modeled).toBeGreaterThan(10);
    expect(catalog.domains.find((domain) => domain.id === 'cos').events).toBeGreaterThan(5);
    expect(catalog.events.find((event) => event.event === 'shell:input')).toMatchObject({
      contractStatus: 'modeled',
      modeledDirections: ['client-to-server'],
      payloadSchemas: { 'client-to-server': expect.objectContaining({ type: 'object' }) },
    });
    expect(catalog.events.find((event) => event.event === 'cos:mind:event')).toMatchObject({
      contractStatus: 'generated',
      directions: ['server-to-client'],
    });
  });
});
