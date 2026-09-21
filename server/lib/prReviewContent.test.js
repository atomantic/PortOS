import { describe, it, expect } from 'vitest';
import { modelAbuseContentFingerprint } from './modelAbuseGuard.js';
import {
  SCREENED_PR_FINGERPRINT_VERSION,
  isScreenedPullRequestFingerprint,
  screenedPullRequestContent,
  screenedPullRequestFingerprint,
  screenedPullRequestFingerprintMatches,
} from './prReviewContent.js';

const PR = {
  number: 7,
  headRefOid: 'a'.repeat(40),
  title: 'Fix the thing',
  body: 'Closes #101.',
};
const DIFF = 'diff --git a/src/example.js b/src/example.js\n+const x = 1;\n';
const COMMITS = [{ messageHeadline: 'fix the thing', messageBody: 'It was broken.' }];

// A stamp an install persisted before the commit log joined the screened
// content (#7323): the same hash, over the commit-less content, stored bare.
// Built through the current builder so it cannot drift from the v1 recipe the
// matcher keeps.
const legacyStamp = (pr, diff) => screenedPullRequestFingerprint(pr, diff, []).split(':')[1];

describe('screenedPullRequestFingerprint', () => {
  it('stamps the recipe version into the fingerprint itself', () => {
    // Beside it in a second field, the version is a projection that gets
    // dropped at a hop — which is how the recipe and its consumers drifted in
    // the first place. Inside the value, it travels wherever the value does.
    const stamp = screenedPullRequestFingerprint(PR, DIFF, COMMITS);
    expect(stamp).toMatch(new RegExp(`^${SCREENED_PR_FINGERPRINT_VERSION}:[0-9a-f]{64}$`));
  });

  it('fails closed when the commit log is missing', () => {
    // Never a fingerprint standing for a smaller surface than the stamped one.
    expect(screenedPullRequestFingerprint(PR, DIFF, undefined)).toBeNull();
    expect(screenedPullRequestFingerprint(PR, DIFF, null)).toBeNull();
  });
});

describe('screenedPullRequestFingerprintMatches', () => {
  it('matches its own stamp, and rejects content that changed at the same head', () => {
    const stamp = screenedPullRequestFingerprint(PR, DIFF, COMMITS);
    expect(screenedPullRequestFingerprintMatches(stamp, PR, DIFF, COMMITS)).toBe(true);
    // The parts a maintainer or contributor can change WITHOUT moving the head
    // SHA — which is the whole reason a fingerprint exists on top of the SHA.
    expect(screenedPullRequestFingerprintMatches(stamp, { ...PR, title: 'Something else' }, DIFF, COMMITS)).toBe(false);
    expect(screenedPullRequestFingerprintMatches(stamp, { ...PR, body: 'Now says something else' }, DIFF, COMMITS)).toBe(false);
    expect(screenedPullRequestFingerprintMatches(stamp, PR, `${DIFF}+const y = 2;\n`, COMMITS)).toBe(false);
    expect(screenedPullRequestFingerprintMatches(stamp, PR, DIFF, [{ messageHeadline: 'rewritten' }])).toBe(false);
  });

  it('re-derives a stamp from an older recipe instead of mismatching it', () => {
    // The reported defect: adding the commit log to the screened content made
    // every persisted fingerprint unreachable, so an approved PR sitting in the
    // merge queue when the install updated was dropped with a console warning
    // and no hand-back. Verified against the recipe the stamp NAMES, the
    // approval survives the upgrade.
    const legacy = legacyStamp(PR, DIFF);
    expect(isScreenedPullRequestFingerprint(legacy)).toBe(true);
    expect(screenedPullRequestFingerprintMatches(legacy, PR, DIFF, COMMITS)).toBe(true);
    // Still the guarantee that recipe actually made: content unchanged since
    // the scan. A title edit at the same head still fails it.
    expect(screenedPullRequestFingerprintMatches(legacy, { ...PR, title: 'Edited' }, DIFF, COMMITS)).toBe(false);
  });

  it('fails closed on a missing, malformed, or unknown-recipe stamp', () => {
    expect(screenedPullRequestFingerprintMatches(null, PR, DIFF, COMMITS)).toBe(false);
    expect(screenedPullRequestFingerprintMatches('', PR, DIFF, COMMITS)).toBe(false);
    expect(screenedPullRequestFingerprintMatches('not-a-fingerprint', PR, DIFF, COMMITS)).toBe(false);
    // A state file written by a NEWER install: this one has no recipe for it and
    // must not fall back to one it does have.
    expect(screenedPullRequestFingerprintMatches(`9999:${'b'.repeat(64)}`, PR, DIFF, COMMITS)).toBe(false);
  });

  it('will not match the current recipe by omitting the commit log', () => {
    const stamp = screenedPullRequestFingerprint(PR, DIFF, COMMITS);
    expect(screenedPullRequestFingerprintMatches(stamp, PR, DIFF, undefined)).toBe(false);
  });
});

describe('isScreenedPullRequestFingerprint', () => {
  it('accepts both stamp shapes and nothing else', () => {
    expect(isScreenedPullRequestFingerprint(`2:${'a'.repeat(64)}`)).toBe(true);
    expect(isScreenedPullRequestFingerprint('a'.repeat(64))).toBe(true);
    expect(isScreenedPullRequestFingerprint('a'.repeat(63))).toBe(false);
    expect(isScreenedPullRequestFingerprint(`2:${'A'.repeat(64)}`)).toBe(false);
    expect(isScreenedPullRequestFingerprint(undefined)).toBe(false);
  });
});

describe('screenedPullRequestContent', () => {
  it('omits the commit block entirely when there are no commit messages', () => {
    // What makes the v1 recipe expressible as "the same content with an empty
    // commit list" rather than a second hand-written projection.
    expect(screenedPullRequestContent(PR, DIFF, [])).not.toContain('Commit messages:');
    expect(screenedPullRequestContent(PR, DIFF, COMMITS)).toContain('Commit messages:');
  });
});

it('covers a commit tail past the old limit while retaining the v2 recipe', () => {
  const commits = [{ messageHeadline: 'x'.repeat(100_001) + 'TAIL' }];
  const content = screenedPullRequestContent(PR, DIFF, commits);
  expect(content).toContain('TAIL');
  const stamp = screenedPullRequestFingerprint(PR, DIFF, commits);
  const edited = [{ messageHeadline: 'x'.repeat(100_001) + 'EDIT' }];
  expect(screenedPullRequestFingerprintMatches(stamp, PR, DIFF, edited)).toBe(false);
  const legacyContent = content.replace(commits[0].messageHeadline, 'x'.repeat(100_000));
  const v2 = '2:' + modelAbuseContentFingerprint('pull-request',
    { number: PR.number, headSha: PR.headRefOid }, legacyContent);
  expect(screenedPullRequestFingerprintMatches(v2, PR, DIFF, commits)).toBe(true);
  expect(screenedPullRequestFingerprintMatches(v2, { ...PR, body: 'edited' }, DIFF, commits)).toBe(false);
});
