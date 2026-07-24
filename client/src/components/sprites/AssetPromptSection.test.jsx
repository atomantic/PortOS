/**
 * AssetPromptSection — the "Prompt + copy" block the sprite preview modals
 * share. Covers the three states: resolved prompt (shown + copyable), no
 * provenance (renders nothing), and a re-fetch when the asset path changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AssetPromptSection from './AssetPromptSection.jsx';

const copyToClipboard = vi.fn();
vi.mock('../../lib/clipboard.js', () => ({ copyToClipboard: (...a) => copyToClipboard(...a) }));

const getSpriteAssetPrompt = vi.fn();
vi.mock('../../services/apiSprites.js', () => ({ getSpriteAssetPrompt: (...a) => getSpriteAssetPrompt(...a) }));

beforeEach(() => { copyToClipboard.mockClear(); getSpriteAssetPrompt.mockReset(); });

describe('AssetPromptSection', () => {
  it('fetches silently and shows the prompt with a copy button', async () => {
    getSpriteAssetPrompt.mockResolvedValue({ prompt: 'THE PROMPT', designPrompt: null, source: 'candidate' });
    render(<AssetPromptSection recordId="hero" path="reference/candidates/walk-south-candidate-01.png" />);

    expect(getSpriteAssetPrompt).toHaveBeenCalledWith('hero', 'reference/candidates/walk-south-candidate-01.png', { silent: true });
    expect(await screen.findByText('THE PROMPT')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /copy prompt/i }));
    expect(copyToClipboard).toHaveBeenCalledWith('THE PROMPT', 'Prompt copied');
  });

  it('renders nothing when the asset has no prompt provenance', async () => {
    getSpriteAssetPrompt.mockResolvedValue(null);
    const { container } = render(<AssetPromptSection recordId="hero" path="atlas/x.png" />);
    await waitFor(() => expect(getSpriteAssetPrompt).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing (and does not fetch) without a recordId or path', () => {
    const { container } = render(<AssetPromptSection recordId={null} path={null} />);
    expect(getSpriteAssetPrompt).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('never throws when the lookup fails — the modal still shows the image', async () => {
    getSpriteAssetPrompt.mockRejectedValue(new Error('boom'));
    const { container } = render(<AssetPromptSection recordId="hero" path="reference/main.png" />);
    await waitFor(() => expect(getSpriteAssetPrompt).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('re-fetches when the path changes', async () => {
    getSpriteAssetPrompt.mockResolvedValue({ prompt: 'first', source: 'candidate' });
    const { rerender } = render(<AssetPromptSection recordId="hero" path="a.png" />);
    expect(await screen.findByText('first')).toBeInTheDocument();

    getSpriteAssetPrompt.mockResolvedValue({ prompt: 'second', source: 'candidate' });
    rerender(<AssetPromptSection recordId="hero" path="b.png" />);
    expect(await screen.findByText('second')).toBeInTheDocument();
    expect(getSpriteAssetPrompt).toHaveBeenCalledTimes(2);
  });
});
