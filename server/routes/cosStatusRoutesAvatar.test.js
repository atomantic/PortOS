import { describe, it, expect, vi } from 'vitest';

// The schema is the save-path gate for avatar styles: pin that a rigged
// record spelling persists while traversal-shaped values still 400. The
// service graph behind the route is stubbed — only the exported schema is
// under test here.
vi.mock('../services/cos.js', () => ({}));
vi.mock('../services/domainUsage.js', () => ({ getAllDomainUsageToday: vi.fn() }));
vi.mock('../services/taskWatcher.js', () => ({}));
vi.mock('../services/memoryEmbeddings.js', () => ({ reinitialize: vi.fn() }));

import { cosConfigSchema } from './cosStatusRoutes.js';

describe('cosConfigSchema avatarStyle', () => {
  it('accepts built-in styles and rigged record spellings', () => {
    expect(cosConfigSchema.safeParse({ avatarStyle: 'muse' }).success).toBe(true);
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-image3d-abc-123' }).success).toBe(true);
  });

  it('rejects unknown and traversal-shaped styles', () => {
    expect(cosConfigSchema.safeParse({ avatarStyle: 'not-a-style' }).success).toBe(false);
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-../secret' }).success).toBe(false);
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-' }).success).toBe(false);
  });
});
