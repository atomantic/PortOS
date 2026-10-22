import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// These routes are full-width (see layoutRoutes.js), so <main> neither pads nor
// scrolls; the loading skeleton must mirror the loaded PageHeader bar shape.
const FILES = [
  '../pages/Uploads.jsx',
  '../pages/AgentsPage.jsx',
  '../pages/HistoryPage.jsx',
  '../components/integrations/IntegrationInstancesPage.jsx',
];

describe('full-width Dev Tools loading skeletons', () => {
  it.each(FILES)('%s renders PageSkeleton with header="bar" fullHeight padded', (file) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const tag = src.match(/<PageSkeleton[^>]*?(?:\/>|>)/s)?.[0] ?? '';
    expect(tag).toContain('header="bar"');
    expect(tag).toMatch(/\bfullHeight\b/);
    expect(tag).toMatch(/\bpadded\b/);
  });
});
