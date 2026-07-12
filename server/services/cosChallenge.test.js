import { describe, it, expect } from 'vitest';
import {
  MAX_CHALLENGES_PER_TASK,
  CHALLENGE_OUTCOMES,
  CHALLENGE_METADATA_KEYS,
  getChallengeCount,
  canChallenge,
  buildChallengePatch,
  buildChallengeResolutionPatch,
} from './cosChallenge.js';
import { resolveChallengeSchema } from '../lib/cosValidation.js';

const NOW = Date.parse('2026-07-12T12:00:00.000Z');

describe('cosChallenge', () => {
  describe('getChallengeCount', () => {
    it('returns 0 for absent / non-positive / unparseable values', () => {
      expect(getChallengeCount(undefined)).toBe(0);
      expect(getChallengeCount({})).toBe(0);
      expect(getChallengeCount({ challengeCount: 0 })).toBe(0);
      expect(getChallengeCount({ challengeCount: -1 })).toBe(0);
      expect(getChallengeCount({ challengeCount: 'nope' })).toBe(0);
    });

    it('coerces the markdown-round-tripped string form ("1") to a number', () => {
      expect(getChallengeCount({ challengeCount: '1' })).toBe(1);
      expect(getChallengeCount({ challengeCount: 2 })).toBe(2);
    });
  });

  describe('canChallenge', () => {
    it('allows a first dispute and refuses once the cap is reached', () => {
      expect(canChallenge({})).toBe(true);
      expect(canChallenge({ challengeCount: MAX_CHALLENGES_PER_TASK })).toBe(false);
      // string form (post-round-trip) is refused too
      expect(canChallenge({ challengeCount: String(MAX_CHALLENGES_PER_TASK) })).toBe(false);
    });
  });

  describe('buildChallengePatch', () => {
    it('records the case, increments the count, and clears any prior resolution', () => {
      const patch = buildChallengePatch(
        { challengeResolution: { outcome: 'escalated' } },
        { reason: '  the reviewer misread the diff  ', evidence: '  see line 42  ', reviewer: 'ollama', now: NOW }
      );
      expect(patch.challengeCount).toBe(1);
      expect(patch.challenge.reason).toBe('the reviewer misread the diff');
      expect(patch.challenge.evidence).toBe('see line 42');
      expect(patch.challenge.reviewer).toBe('ollama');
      expect(patch.challenge.challengedAt).toBe(new Date(NOW).toISOString());
      // undefined so updateTask's undefined-strip drops the stale resolution
      expect(patch.challengeResolution).toBeUndefined();
      expect('challengeResolution' in patch).toBe(true);
    });

    it('increments from an existing count (string form)', () => {
      const patch = buildChallengePatch({ challengeCount: '1' }, { reason: 'x', now: NOW });
      expect(patch.challengeCount).toBe(2);
    });

    it('omits optional evidence/reviewer when blank', () => {
      const patch = buildChallengePatch({}, { reason: 'x', evidence: '   ', reviewer: '', now: NOW });
      expect('evidence' in patch.challenge).toBe(false);
      expect('reviewer' in patch.challenge).toBe(false);
    });
  });

  describe('buildChallengeResolutionPatch', () => {
    it('returns null for an unknown outcome', () => {
      expect(buildChallengeResolutionPatch({ outcome: 'bogus', now: NOW })).toBeNull();
      expect(buildChallengeResolutionPatch({ now: NOW })).toBeNull();
    });

    it('records outcome + timestamp and trims optional note/resolvedBy', () => {
      const patch = buildChallengeResolutionPatch({ outcome: 'upheld', note: '  agreed  ', resolvedBy: '  user  ', now: NOW });
      expect(patch.challengeResolution.outcome).toBe('upheld');
      expect(patch.challengeResolution.resolvedAt).toBe(new Date(NOW).toISOString());
      expect(patch.challengeResolution.note).toBe('agreed');
      expect(patch.challengeResolution.resolvedBy).toBe('user');
    });

    it('accepts every CHALLENGE_OUTCOMES value', () => {
      for (const outcome of CHALLENGE_OUTCOMES) {
        expect(buildChallengeResolutionPatch({ outcome, now: NOW })).not.toBeNull();
      }
    });
  });

  describe('constants / parity', () => {
    it('caps disputes at exactly one per task', () => {
      expect(MAX_CHALLENGES_PER_TASK).toBe(1);
    });

    it('owns exactly the three challenge metadata keys', () => {
      expect([...CHALLENGE_METADATA_KEYS].sort()).toEqual(['challenge', 'challengeCount', 'challengeResolution']);
    });

    it('the route resolution enum stays in lockstep with CHALLENGE_OUTCOMES', () => {
      // Drift guard: the Zod enum in cosValidation.js is a mirror; both must match.
      for (const outcome of CHALLENGE_OUTCOMES) {
        expect(resolveChallengeSchema.safeParse({ outcome }).success).toBe(true);
      }
      // An outcome NOT in the list must be rejected by the schema.
      expect(resolveChallengeSchema.safeParse({ outcome: 'overruled' }).success).toBe(false);
    });
  });
});
