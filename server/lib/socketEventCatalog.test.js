import { describe, expect, it } from 'vitest';
import { buildSocketEventCatalog } from './socketEventCatalog.js';

describe('socket event catalog', () => {
  it('projects domains, directions, and runtime-backed coverage without positional metadata', async () => {
    const catalog = await buildSocketEventCatalog();
    expect(catalog.schemaVersion).toBe(2);
    expect(catalog.stats.events).toBeGreaterThan(100);
    expect(catalog.stats.modeled).toBeGreaterThan(10);
    expect(catalog).not.toHaveProperty('regenerateCommand');
    expect(catalog.events.every((event) => !('sources' in event) && !('line' in event))).toBe(true);
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
