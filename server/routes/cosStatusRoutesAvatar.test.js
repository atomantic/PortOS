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
import { AVATAR_STYLE_IDS } from '../../client/src/lib/avatarStyles.js';

describe('cosConfigSchema avatarStyle', () => {
  it('accepts every style in the shared registry, so a style added there is never a settings 400', () => {
    for (const id of AVATAR_STYLE_IDS) {
      expect(cosConfigSchema.safeParse({ avatarStyle: id }).success, `avatarStyle "${id}"`).toBe(true);
    }
  });

  it('accepts rigged record spellings', () => {
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-image3d-abc-123' }).success).toBe(true);
  });

  it('rejects unknown and traversal-shaped styles', () => {
    expect(cosConfigSchema.safeParse({ avatarStyle: 'not-a-style' }).success).toBe(false);
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-../secret' }).success).toBe(false);
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-' }).success).toBe(false);
  });
});
