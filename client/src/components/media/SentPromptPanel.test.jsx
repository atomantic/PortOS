import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SentPromptPanel from './SentPromptPanel';

const copyToClipboard = vi.fn();
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: (...args) => copyToClipboard(...args) }));

describe('SentPromptPanel', () => {
  it('lists each addition as a chip and shows the exact sent text with Copy', () => {
    render(
      <SentPromptPanel
        prompt="a red kite"
        sentPrompt="muted earth tones. a red kite"
        sentNegativePrompt="blur"
        additions={[{ id: 'style-1', label: 'Universe style', text: 'muted earth tones' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Universe style' }));
    expect(screen.getByText('muted earth tones')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show full prompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy full prompt' }));
    expect(copyToClipboard).toHaveBeenCalledWith('muted earth tones. a red kite\n\nNegative prompt: blur', 'Full prompt copied');
  });

  it('says a prompt went out as written, and stays out of the way for older records', () => {
    const { rerender, container } = render(<SentPromptPanel prompt="a red kite" sentPrompt="a red kite" />);
    expect(screen.getByText('Sent to the model exactly as written.')).toBeTruthy();
    rerender(<SentPromptPanel prompt="a red kite" />);
    expect(container.textContent).toBe('');
  });
});
