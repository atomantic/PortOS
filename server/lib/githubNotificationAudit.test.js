import { describe, it, expect } from 'vitest';
import { buildAuditSuggestions } from './githubNotificationAudit.js';

const group = (repo, reason, total, { acted = 0, handled = 0, handledOpen = [] } = {}) => ({ repo, reason, total, acted, handled, handledOpen });

describe('buildAuditSuggestions', () => {
  it('suggests unwatching a watched repo you never act on, and links what the API cannot change', () => {
    const { summary, suggestions } = buildAuditSuggestions({
      host: 'ghe.example.com',
      watchedRepos: ['acme/noisy', 'acme/busy', 'acme/core'],
      groups: [
        group('acme/noisy', 'subscribed', 8),
        group('acme/busy', 'subscribed', 12, { acted: 1 }),
        group('acme/core', 'mention', 6, { acted: 4 }),
        group('acme/core', 'ci_activity', 14, { handled: 12, handledOpen: ['7', '8'] }),
      ],
    });
    expect(summary).toEqual({ total: 40, acted: 5, handled: 12, repos: 3 });
    expect(suggestions.map((entry) => [entry.id, entry.apply ? 'apply' : entry.link])).toEqual([
      ['mute-handled:acme/core', 'apply'],
      ['actions-failed-only', 'https://ghe.example.com/settings/notifications'],
      ['custom-watch:acme/busy', 'https://ghe.example.com/acme/busy'],
      ['unwatch:acme/noisy', 'apply'],
    ]);
    expect(suggestions[0].threadIds).toEqual(['7', '8']);
  });

  it('offers no unwatch when the repo is not watched, the list is unknown, or you act on it', () => {
    const groups = [group('acme/noisy', 'subscribed', 8)];
    expect(buildAuditSuggestions({ groups, watchedRepos: null }).suggestions).toEqual([]);
    expect(buildAuditSuggestions({ groups, watchedRepos: ['acme/other'] }).suggestions).toEqual([]);
    expect(buildAuditSuggestions({ groups: [group('acme/noisy', 'subscribed', 8, { acted: 1 })], watchedRepos: ['acme/noisy'] }).suggestions).toEqual([]);
  });
});
