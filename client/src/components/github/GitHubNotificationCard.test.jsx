import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  actOnGitHubNotificationPullRequest: vi.fn(),
  applyGitHubNotificationAction: vi.fn(),
  resolveGitHubNotificationWithAgent: vi.fn(),
}));
vi.mock('../../hooks/useCosTaskUpdates', () => ({ useCosTaskUpdates: () => {} }));

const GitHubNotificationCard = (await import('./GitHubNotificationCard')).default;

// Your PR into someone else's repo, as the inbox lists it.
const upstreamPr = (subjectStatus) => ({
  accountId: 'acct-a', threadId: '1701', repoFullName: 'example-org/project', reason: 'comment',
  subjectType: 'PullRequest', title: 'Example change', htmlUrl: 'https://github.com/example-org/project/pull/1701',
  unread: true, state: 'open', decision: 'surface', trust: 'yours', updatedAt: '2026-11-06T10:00:00Z',
  subjectStatus: { state: 'open', draft: false, canMerge: false, awaitingReply: false, ...subjectStatus },
  agent: { lane: 'notification-resolve', refused: null, pin: null },
  pullRequest: { number: 1701, mergeEligible: false, doReviewEligible: true, reviewEligible: false },
});

const renderCard = (notification) => render(<MemoryRouter><GitHubNotificationCard notification={notification} /></MemoryRouter>);

describe('GitHubNotificationCard on your PR into another repo', () => {
  it('never reads as ready to merge while it conflicts or waits on your reply, and offers Resolve with agent', () => {
    renderCard(upstreamPr({ mergeState: 'dirty', awaitingReply: true }));
    expect(screen.getByText('Merge conflicts')).toBeTruthy();
    expect(screen.getByText('Reply needed')).toBeTruthy();
    expect(screen.queryByText('Ready to merge')).toBeNull();
    expect(screen.getByRole('button', { name: /Resolve with agent/ }).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /^Merge$/ })).toBeNull();
  });

  it('shows a clean PR it cannot merge as awaiting the maintainer, and a reply first when one is owed', () => {
    const { unmount } = renderCard(upstreamPr({ mergeState: 'clean' }));
    expect(screen.getByText('Awaiting maintainer')).toBeTruthy();
    expect(screen.queryByText('Ready to merge')).toBeNull();
    unmount();
    renderCard(upstreamPr({ mergeState: 'clean', awaitingReply: true }));
    expect(screen.getAllByText('Reply needed')).toHaveLength(1);
    expect(screen.queryByText('Awaiting maintainer')).toBeNull();
  });
});
