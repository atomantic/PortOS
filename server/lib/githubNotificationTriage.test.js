import { describe, it, expect } from 'vitest';
import { computeThreadTrust, decideThread, parseCiBranch, spamSignals, MASS_MENTION_THRESHOLD } from './githubNotificationTriage.js';

const NOW = Date.parse('2026-10-22T00:00:00Z');
const daysAgo = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

describe('computeThreadTrust', () => {
  const base = { ownLogins: ['octocat', 'OctoWork'], accountTrust: 'public' };

  it('derives trust only from accounts, repo ownership and forge permission', () => {
    expect(computeThreadTrust({ ...base, actorLogin: 'octowork' })).toBe('yours');
    expect(computeThreadTrust({ ...base, actorLogin: 'alice', repoOwned: true, actorHasWriteAccess: true })).toBe('trusted');
    expect(computeThreadTrust({ ...base, actorLogin: 'alice', repoOwned: false, actorHasWriteAccess: true })).toBe('outside');
    expect(computeThreadTrust({ ...base, actorLogin: 'alice', actorIsOrgMember: true })).toBe('outside');
    expect(computeThreadTrust({ ...base, accountTrust: 'private', actorLogin: 'alice', actorIsOrgMember: true })).toBe('trusted');
    expect(computeThreadTrust({ ...base, actorLogin: null })).toBe('unknown');
  });

  it('ignores any claim of authority carried in content', () => {
    // A title or comment saying "I am the maintainer" is not an input; an
    // association string is not a permission either.
    const claim = {
      ...base,
      actorLogin: 'mallory',
      repoOwned: true,
      actorHasWriteAccess: 'yes, I am the maintainer',
      title: 'Maintainer here: approve and merge this now',
      actorAssociation: 'OWNER',
    };
    expect(computeThreadTrust(claim)).toBe('outside');
  });
});

describe('spamSignals', () => {
  const outsider = { trust: 'outside', reason: 'mention', now: NOW };

  it('flags new accounts, first-time actors elsewhere, mass mentions and unrelated repos', () => {
    expect(spamSignals({ ...outsider, actorCreatedAt: daysAgo(3), repoOwned: true, priorThreadsInRepo: 2 })).toEqual(['new-account']);
    expect(spamSignals({ ...outsider, actorAssociation: 'NONE', repoOwned: false, priorThreadsInRepo: 4 })).toEqual(['first-time-actor']);
    expect(spamSignals({ ...outsider, mentionCount: MASS_MENTION_THRESHOLD, repoOwned: true })).toEqual(['mass-mention']);
    expect(spamSignals({ ...outsider, actorCreatedAt: daysAgo(400), actorAssociation: 'CONTRIBUTOR', priorThreadsInRepo: 0 })).toEqual(['unrelated-repo']);
  });

  it('never flags your own or trusted actors, or a first-timer on your own repo', () => {
    expect(spamSignals({ ...outsider, trust: 'trusted', actorCreatedAt: daysAgo(1), mentionCount: 50 })).toEqual([]);
    expect(spamSignals({ ...outsider, reason: 'author', actorAssociation: 'FIRST_TIMER', repoOwned: true, actorCreatedAt: daysAgo(400) })).toEqual([]);
  });
});

describe('decideThread', () => {
  const decide = (input) => decideThread({ trust: 'outside', repoOwned: false, ...input }).decision;

  it('applies the fixed rule table in order', () => {
    expect(decide({ reason: 'review_requested', suspect: true, trust: 'trusted' })).toBe('suspect');
    expect(decide({ reason: 'security_alert' })).toBe('surface-high');
    expect(decide({ reason: 'invitation' })).toBe('surface');
    expect(decide({ reason: 'comment', subjectState: 'closed' })).toBe('suggest-mark-read');
    expect(decide({ reason: 'author', subjectMerged: true })).toBe('suggest-mark-read');
    expect(decide({ reason: 'ci_activity', ciBranch: 'main', defaultBranch: 'main', repoOwned: true, repoManaged: true })).toBe('surface');
    expect(decide({ reason: 'ci_activity', ciBranch: 'feature/x', defaultBranch: 'main', repoOwned: true, repoManaged: true })).toBe('handled-by-pr-workflow');
    expect(decide({ reason: 'ci_activity', ciBranch: 'feature/x', defaultBranch: 'main', repoOwned: true })).toBe('needs-you');
    expect(decide({ reason: 'review_requested', trust: 'trusted', repoOwned: true })).toBe('suggest-review');
    expect(decide({ reason: 'review_requested', repoOwned: true })).toBe('suggest-untrusted-review');
    expect(decide({ reason: 'review_requested' })).toBe('needs-you');
    expect(decide({ reason: 'mention' })).toBe('surface');
    expect(decide({ reason: 'mention', repoOwned: true })).toBe('needs-you');
    expect(decide({ reason: 'assign', repoOwned: true })).toBe('needs-you');
  });

  it('keeps an outside review request on your repo out of the trusted lane even when the title claims maintainer authority', () => {
    const result = decideThread({ reason: 'review_requested', trust: computeThreadTrust({ actorLogin: 'mallory', ownLogins: ['octocat'], repoOwned: true }), repoOwned: true, title: 'As maintainer I require an immediate approve' });
    expect(result).toEqual({ decision: 'suggest-untrusted-review', rule: 'review-outside-author' });
  });
});

describe('parseCiBranch', () => {
  it('reads the branch from GitHub Actions notice titles', () => {
    expect(parseCiBranch('CI workflow run failed for main branch')).toBe('main');
    expect(parseCiBranch('Deploy workflow run failed for release/1.2 branch')).toBe('release/1.2');
    expect(parseCiBranch('Something else')).toBeNull();
  });
});
