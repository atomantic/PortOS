import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BrokerCaseDrawer from './BrokerCaseDrawer.jsx';

// Pins the blocked-case contract: an explainer with a manual-check link built
// from the revealed identity evidence's search_url (#8333), an "I'm listed" (→ found) action, and NO
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
    evidence: { match_basis: 'antibot_wall' },
    identityEvidence: { sealed: true, listingCount: 0 },
  };
  const identity = { search_url: 'https://rad/p/Jane/Doe/' };

  it('shows the manual-check explainer with the filled search URL', () => {
    renderDrawer(blockedCase, { identity });
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

  it('omits the manual-check link while no identity evidence is revealed', () => {
    renderDrawer(blockedCase);
    expect(screen.getByText(/blocks automated checks/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /check manually in your browser/i })).toBeNull();
  });
});

describe('BrokerCaseDrawer — sealed identity evidence (#8333)', () => {
  const foundCase = {
    id: 'f1', brokerId: 'rad', brokerName: 'Radaris', state: 'found',
    evidence: { match_basis: 'name+location' },
    identityEvidence: { sealed: true, listingCount: 1 },
  };

  it('renders revealed listing links and erases only after the inline confirm', () => {
    const onEraseEvidence = vi.fn();
    renderDrawer(foundCase, {
      identity: { matched_name: 'Example Person', listing_urls: ['https://rad/p/example'] },
      onEraseEvidence,
    });
    expect(screen.getByRole('link', { name: /rad\/p\/example/ }).getAttribute('href')).toBe('https://rad/p/example');
    fireEvent.click(screen.getByRole('button', { name: /erase identity evidence/i }));
    expect(onEraseEvidence).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^erase$/i }));
    expect(onEraseEvidence).toHaveBeenCalledWith(foundCase);
  });

  it('offers no erase control once the evidence is gone', () => {
    renderDrawer({ ...foundCase, identityEvidence: null }, { onEraseEvidence: vi.fn() });
    expect(screen.queryByRole('button', { name: /erase identity evidence/i })).toBeNull();
    expect(screen.getByText(/no listing urls recorded/i)).toBeTruthy();
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

describe('BrokerCaseDrawer — server allowedTransitions gating (issue #2417)', () => {
  it('renders only actions whose target is in the server-supplied allowedTransitions', () => {
    // A blocked case whose server list omits `found` must NOT render "I'm listed"
    // even though the curated presentation table lists it — the UI can only offer
    // what the server says is legal.
    renderDrawer({
      id: 'b1', brokerId: 'rad', brokerName: 'Radaris', state: 'blocked',
      allowedTransitions: ['not_found', 'human_task_queued'],
      evidence: { match_basis: 'antibot_wall' },
    });
    expect(screen.queryByRole('button', { name: /i'm listed/i })).toBeNull();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy();
  });

  it('renders both curated actions when the server list allows them', () => {
    renderDrawer({
      id: 'b1', brokerId: 'rad', brokerName: 'Radaris', state: 'blocked',
      allowedTransitions: ['found', 'not_found', 'human_task_queued'],
      evidence: { match_basis: 'antibot_wall' },
    });
    expect(screen.getByRole('button', { name: /i'm listed/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy();
  });
});
