import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ScopeAdherenceCheck from './ScopeAdherenceCheck';

const isFeatureEnabled = vi.fn();
vi.mock('../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled }),
}));

const scoreAppScopeAdherence = vi.fn();
vi.mock('../../services/api', () => ({
  scoreAppScopeAdherence: (...args) => scoreAppScopeAdherence(...args),
}));

const props = { appId: 'app-001', kind: 'pr', title: 'Expose the dashboard publicly', body: 'Opens the port.' };

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabled.mockReturnValue(true);
});

describe('ScopeAdherenceCheck', () => {
  it('renders nothing at all when the jev feature is off', () => {
    isFeatureEnabled.mockReturnValue(false);
    const { container } = render(<ScopeAdherenceCheck {...props} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('scores nothing until the operator asks', () => {
    render(<ScopeAdherenceCheck {...props} />);
    // The scorer is a 9 GB local model. Scoring every visible row on mount is
    // exactly the cold-bootstrap work the AI Provider Usage Policy forbids.
    expect(scoreAppScopeAdherence).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /check scope/i })).toBeInTheDocument();
  });

  it('names the clause a contradiction was scored against, and says it is advisory', async () => {
    scoreAppScopeAdherence.mockResolvedValue({
      ok: true,
      verdict: 'contradicts',
      clauseId: 'PRD.md#out-of-scope:abc12345',
      clause: { sourceFile: 'PRD.md', headingPath: 'Out of Scope', citation: 'PRD.md § Out of Scope' },
      margin: 0.41,
    });

    await userEvent.click(render(<ScopeAdherenceCheck {...props} />)
      .getByRole('button', { name: /check scope/i }));

    await waitFor(() => expect(screen.getByText('Works against')).toBeInTheDocument());
    // A bare verdict is noise; the citation is what a human can go argue with.
    expect(screen.getByText('PRD.md § Out of Scope')).toBeInTheDocument();
    expect(screen.getByText('advisory only')).toBeInTheDocument();
    expect(scoreAppScopeAdherence).toHaveBeenCalledWith('app-001', {
      kind: 'pr',
      title: 'Expose the dashboard publicly',
      body: 'Opens the port.',
      diffSummary: '',
    });
  });

  it('reads an abstention as no advisory rather than as a verdict', async () => {
    scoreAppScopeAdherence.mockResolvedValue({ ok: true, verdict: 'abstained', clauseId: null, clause: null, margin: 0.04 });

    await userEvent.click(render(<ScopeAdherenceCheck {...props} />)
      .getByRole('button', { name: /check scope/i }));

    await waitFor(() => expect(screen.getByText(/could not separate the options/i)).toBeInTheDocument());
    expect(screen.queryByText(/Works against|Advances|Unrelated/)).not.toBeInTheDocument();
  });

  it('explains an uninstalled scorer instead of leaving the row silent', async () => {
    scoreAppScopeAdherence.mockResolvedValue({ ok: false, code: 'jev-not-installed' });

    await userEvent.click(render(<ScopeAdherenceCheck {...props} />)
      .getByRole('button', { name: /check scope/i }));

    await waitFor(() => expect(screen.getByText(/not installed yet/i)).toBeInTheDocument());
  });

  it('swallows a failed request into "no advisory" rather than a toast', async () => {
    scoreAppScopeAdherence.mockRejectedValue(new Error('network'));

    await userEvent.click(render(<ScopeAdherenceCheck {...props} />)
      .getByRole('button', { name: /check scope/i }));

    await waitFor(() => expect(screen.getByText(/could not answer for this change/i)).toBeInTheDocument());
  });
});
