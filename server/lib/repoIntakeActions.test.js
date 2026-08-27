import { describe, it, expect } from 'vitest';
import { REPO_INTAKE_KEYS, normalizeRepoIntake } from './repoIntakeActions.js';

describe('normalizeRepoIntake', () => {
  it('returns null when nothing was ticked, so no-intake is never persisted', () => {
    expect(normalizeRepoIntake(undefined)).toBeNull();
    expect(normalizeRepoIntake(null)).toBeNull();
    expect(normalizeRepoIntake({})).toBeNull();
    expect(normalizeRepoIntake({ malwareScan: false, learn: false })).toBeNull();
  });

  it('fills every key so a partial payload cannot leave an action undefined', () => {
    expect(normalizeRepoIntake({ learn: true })).toEqual({ malwareScan: false, learn: true });
  });

  it('only accepts a literal true — a truthy string does not opt an agent in', () => {
    expect(normalizeRepoIntake({ malwareScan: 'yes' })).toBeNull();
    expect(normalizeRepoIntake({ malwareScan: 1 })).toBeNull();
  });

  it('ignores unknown keys rather than passing them through', () => {
    expect(normalizeRepoIntake({ learn: true, rmRf: true })).toEqual({ malwareScan: false, learn: true });
  });

  it('keeps a selected target app only for repo study', () => {
    expect(normalizeRepoIntake({ learn: true, targetAppId: ' app-2 ' })).toEqual({
      malwareScan: false,
      learn: true,
      targetAppId: 'app-2',
    });
    expect(normalizeRepoIntake({ malwareScan: true, targetAppId: 'app-2' })).toEqual({
      malwareScan: true,
      learn: false,
    });
  });

  it('rejects non-objects, including arrays', () => {
    expect(normalizeRepoIntake([true])).toBeNull();
    expect(normalizeRepoIntake('malwareScan')).toBeNull();
    expect(normalizeRepoIntake(true)).toBeNull();
  });

  it('keeps trimmed study context only for repo study', () => {
    expect(normalizeRepoIntake({ learn: true, studyContext: '  Find the best seam.  ' })).toEqual({
      malwareScan: false,
      learn: true,
      studyContext: 'Find the best seam.',
    });
    expect(normalizeRepoIntake({ malwareScan: true, studyContext: 'ignored' })).toEqual({
      malwareScan: true,
      learn: false,
    });
  });

  it('keeps provider, model, and effort pins only for repo study', () => {
    expect(normalizeRepoIntake({
      learn: true,
      providerId: ' codex ',
      model: ' gpt-5 ',
      effort: ' HIGH ',
    })).toEqual({
      malwareScan: false,
      learn: true,
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });
    expect(normalizeRepoIntake({
      malwareScan: true,
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
    })).toEqual({ malwareScan: true, learn: false });
  });

  it('drops an unknown effort rather than persisting an unsafe task override', () => {
    expect(normalizeRepoIntake({ learn: true, effort: 'unlimited' })).toEqual({
      malwareScan: false,
      learn: true,
    });
  });

  it('covers exactly the two documented actions', () => {
    expect(REPO_INTAKE_KEYS).toEqual(['malwareScan', 'learn']);
  });
});
