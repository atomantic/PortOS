import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const copyToClipboardMock = vi.fn(async () => true);
vi.mock('../../lib/clipboard', () => ({
  copyToClipboard: (...a) => copyToClipboardMock(...a),
}));

import ImagePromptCandidates from './ImagePromptCandidates';

const CANDIDATES = [
  { prompt: 'first candidate prompt', changes: [], runId: 'r1' },
  { prompt: 'second candidate prompt', changes: [], runId: 'r2' },
];

beforeEach(() => {
  copyToClipboardMock.mockClear();
});

describe('ImagePromptCandidates', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<ImagePromptCandidates candidates={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders each candidate prompt and a count header', () => {
    render(<ImagePromptCandidates candidates={CANDIDATES} />);
    expect(screen.getByText('first candidate prompt')).toBeInTheDocument();
    expect(screen.getByText('second candidate prompt')).toBeInTheDocument();
    expect(screen.getByText(/2 image-prompt candidates/i)).toBeInTheDocument();
  });

  it('copies a candidate prompt to the clipboard', async () => {
    render(<ImagePromptCandidates candidates={CANDIDATES} />);
    const copyButtons = screen.getAllByRole('button', { name: /copy/i });
    await userEvent.click(copyButtons[1]);
    expect(copyToClipboardMock).toHaveBeenCalledWith('second candidate prompt', expect.any(String));
  });

  it('calls onApply with the prompt and index when "Use" is clicked', async () => {
    const onApply = vi.fn();
    render(<ImagePromptCandidates candidates={CANDIDATES} onApply={onApply} />);
    const useButtons = screen.getAllByRole('button', { name: /use/i });
    await userEvent.click(useButtons[0]);
    expect(onApply).toHaveBeenCalledWith('first candidate prompt', 0);
  });

  it('omits the Use button when onApply is not provided', () => {
    render(<ImagePromptCandidates candidates={CANDIDATES} />);
    expect(screen.queryByRole('button', { name: /use/i })).not.toBeInTheDocument();
  });

  it('calls onDismiss when the dismiss control is clicked', async () => {
    const onDismiss = vi.fn();
    render(<ImagePromptCandidates candidates={CANDIDATES} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss candidates/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
