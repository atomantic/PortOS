import { describe, it, expect } from 'vitest';
import { parseGhIncludeOutput, toNotificationRecord } from './githubNotificationParse.js';

const notificationHtmlUrl = ({ repoFullName, subjectApiUrl }, host) => toNotificationRecord({
  id: '1', unread: true, reason: 'mention', updated_at: '2026-10-01T10:00:00Z',
  subject: { title: 'Example', type: 'PullRequest', url: subjectApiUrl },
  repository: { full_name: repoFullName, owner: { login: 'octocat' } },
}, host).htmlUrl;

describe('thread links', () => {
  const repoFullName = 'octocat/hello';

  it('maps recognized API urls to the subject page on the account host', () => {
    expect(notificationHtmlUrl({ repoFullName, subjectApiUrl: 'https://api.github.com/repos/octocat/hello/pulls/7' }, 'github.com'))
      .toBe('https://github.com/octocat/hello/pull/7');
    expect(notificationHtmlUrl({ repoFullName, subjectApiUrl: 'https://ghe.example.com/api/v3/repos/octocat/hello/issues/3' }, 'ghe.example.com'))
      .toBe('https://ghe.example.com/octocat/hello/issues/3');
    expect(notificationHtmlUrl({ repoFullName, subjectApiUrl: 'https://api.github.com/repos/octocat/hello/releases/99' }, 'github.com'))
      .toBe('https://github.com/octocat/hello/releases');
  });

  it('never links off the account host and falls back to the repo page', () => {
    for (const subjectApiUrl of [
      'https://evil.example.com/repos/octocat/hello/pulls/7',
      'https://api.github.com/repos/other/repo/pulls/7',
      'https://api.github.com/repos/octocat/hello/pulls/7/../../x',
      null,
    ]) {
      expect(notificationHtmlUrl({ repoFullName, subjectApiUrl }, 'github.com')).toBe('https://github.com/octocat/hello');
    }
    expect(notificationHtmlUrl({ repoFullName: 'bad owner/x', subjectApiUrl: null }, 'github.com')).toBe('');
  });
});

describe('parseGhIncludeOutput', () => {
  it('splits status, lower-cased headers and body', () => {
    expect(parseGhIncludeOutput('HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n[]'))
      .toEqual({ status: 200, headers: { 'x-poll-interval': '60' }, body: '[]' });
    expect(parseGhIncludeOutput('[]')).toBeNull();
  });
});

describe('toNotificationRecord', () => {
  it('rejects malformed threads and caps long titles', () => {
    expect(toNotificationRecord({ id: 'x' }, 'github.com')).toBeNull();
    const record = toNotificationRecord({
      id: '1', unread: true, reason: 'mention', updated_at: '2026-10-01T10:00:00Z',
      subject: { title: '🙂'.repeat(600), type: 'Issue', url: null },
      repository: { full_name: 'octocat/hello', owner: { login: 'octocat' } },
    }, 'github.com');
    expect(Array.from(record.subjectTitle)).toHaveLength(500);
    expect(record.repoPrivate).toBe(false);
  });
});
