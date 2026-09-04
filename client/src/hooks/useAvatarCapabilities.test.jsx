import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getRiggedAvatars: vi.fn() }));
vi.mock('../services/api', () => api);

import {
  coverageSummary,
  isRiggedAvatarStyle,
  resolvePlaybackClip,
  resolveStateClip,
  riggedRecordForStyle,
  useAvatarCapabilities,
} from './useAvatarCapabilities';

// A single-clip retargeted character: the server maps its one clip against
// the CoS vocabulary, so exactly the matching states read as covered.
const danceCoverage = {
  availableClips: ['Dance'],
  coverageByState: {
    thinking: { covered: false, clip: null },
    coding: { covered: false, clip: null },
    ideating: { covered: true, clip: 'Dance' },
  },
  coveredStates: ['ideating'],
  missingStates: ['thinking', 'coding'],
  complete: false,
};

describe('resolveStateClip', () => {
  it('returns the covered clip for a covered state', () => {
    expect(resolveStateClip(danceCoverage, 'ideating')).toBe('Dance');
  });

  it('falls back to the available clip for a missing state', () => {
    expect(resolveStateClip(danceCoverage, 'coding')).toBe('Dance');
  });

  it('returns null when the character carries no clip', () => {
    expect(resolveStateClip({ availableClips: [], coverageByState: {} }, 'coding')).toBe(null);
    expect(resolveStateClip(null, 'coding')).toBe(null);
  });
});

describe('resolvePlaybackClip', () => {
  it('plays the covered clip when the GLB carries it', () => {
    expect(resolvePlaybackClip(['Dance', 'Idle'], {
      state: 'ideating', coverage: danceCoverage, fallbacks: ['idle'],
    })).toBe('Dance');
  });

  it('falls back to a present clip when the covered one is absent from the GLB', () => {
    // The record was re-retargeted after the selector read it: coverage names
    // a clip the file no longer has, so playback degrades to real motion
    // rather than a frozen frame.
    expect(resolvePlaybackClip(['Idle'], {
      state: 'ideating', coverage: danceCoverage, fallbacks: ['idle'],
    })).toBe('Idle');
  });

  it('keeps the legacy fallback chain when there is no coverage', () => {
    expect(resolvePlaybackClip(['walk', 'idle'], { fallbacks: ['walk', 'idle'] })).toBe('walk');
    expect(resolvePlaybackClip(['idle'], { fallbacks: ['walk', 'idle'] })).toBe('idle');
    expect(resolvePlaybackClip(['sprint'], { fallbacks: ['walk', 'idle'] })).toBe('sprint');
    expect(resolvePlaybackClip([], { fallbacks: ['walk', 'idle'] })).toBe(null);
  });
});

describe('coverageSummary', () => {
  it('names the covered fraction honestly', () => {
    expect(coverageSummary(danceCoverage)).toBe('Covers 1 of 3 CoS states');
  });

  it('celebrates full coverage and admits none', () => {
    expect(coverageSummary({ coverageByState: { a: {}, b: {} }, coveredStates: ['a', 'b'] }))
      .toBe('Covers all 2 CoS states');
    expect(coverageSummary({
      coverageByState: { a: { covered: false, clip: null } },
      coveredStates: [],
      availableClips: ['Dance'],
    })).toBe('No covered CoS state — plays Dance throughout');
    expect(coverageSummary(null)).toBe('No animation clips');
  });
});

describe('style helpers', () => {
  it('recognizes rigged styles and finds their record', () => {
    const records = [{ variant: 'rigged-image3d-1', name: 'Example Dancer' }];
    expect(isRiggedAvatarStyle('rigged-image3d-1')).toBe(true);
    expect(isRiggedAvatarStyle('muse')).toBe(false);
    expect(riggedRecordForStyle(records, 'rigged-image3d-1')).toEqual(records[0]);
    expect(riggedRecordForStyle(records, 'rigged-image3d-gone')).toBe(null);
    expect(riggedRecordForStyle(records, 'muse')).toBe(null);
  });
});

describe('useAvatarCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves with the served records', async () => {
    api.getRiggedAvatars.mockResolvedValue({ records: [{ variant: 'rigged-image3d-1' }] });
    const { result } = renderHook(() => useAvatarCapabilities());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.records).toHaveLength(1);
    expect(result.current.error).toBe(null);
    expect(api.getRiggedAvatars).toHaveBeenCalledWith({ silent: true });
  });

  it('fails open to an empty list so the built-in styles keep working', async () => {
    api.getRiggedAvatars.mockRejectedValue(new Error('rigging lane down'));
    const { result } = renderHook(() => useAvatarCapabilities());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.records).toEqual([]);
    expect(result.current.error).not.toBe(null);
  });
});
