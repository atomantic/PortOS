import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BrokerCaseDrawer from './BrokerCaseDrawer.jsx';

// Pins the blocked-case contract: an explainer with a manual-check link built
// from evidence.search_url, an "I'm listed" (→ found) action, and NO
// "Mark done" (blocked → submitted is not a legal server transition).

const broker = { id: 'rad', name: 'Radaris', tier: 2, optout: { url: 'https://rad/optout', playbook: ['step one'] } };

const renderDrawer = (caseData, props = {}) => {
  const onTransition = vi.fn();
  render(
    <BrokerCaseDrawer open caseData={caseData} broker={broker} onClose={() => {}} onTransition={onTransition} {...props} />,
  );
  return { onTransition };
};

describe('BrokerCaseDrawer — blocked case', () => {
  const blockedCase = {
    id: 'b1', brokerId: 'rad', brokerName: 'Radaris', state: 'blocked',
    evidence: { match_basis: 'antibot_wall', search_url: 'https://rad/p/Jane/Doe/' },
  };

  it('shows the manual-check explainer with the filled search URL', () => {
    renderDrawer(blockedCase);
    expect(screen.getByText(/blocks automated checks/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: /check manually in your browser/i });
    expect(link.getAttribute('href')).toBe('https://rad/p/Jane/Doe/');
  });

  it('offers "I\'m listed" (→ found) and no "Mark done"', () => {
    const { onTransition } = renderDrawer(blockedCase);
    expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /i'm listed/i }));
    expect(onTransition).toHaveBeenCalledWith(blockedCase, 'found');
  });

  it('omits the manual-check link for a pre-existing case without search_url evidence', () => {
    renderDrawer({ ...blockedCase, evidence: { match_basis: 'antibot_wall' } });
    expect(screen.getByText(/blocks automated checks/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /check manually in your browser/i })).toBeNull();
  });
});

describe('BrokerCaseDrawer — human task case', () => {
  it('offers "Mark done" (→ submitted) and no blocked explainer', () => {
    const kase = { id: 'h1', brokerId: 'rad', brokerName: 'Radaris', state: 'human_task_queued', evidence: {} };
    const { onTransition } = renderDrawer(kase);
    expect(screen.queryByText(/blocks automated checks/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /mark done/i }));
    expect(onTransition).toHaveBeenCalledWith(kase, 'submitted');
  });
});
