import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CreativeRefinement from './CreativeRefinement';
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [], selectedProviderId: 'chosen', selectedModel: 'model', availableModels: [], setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }) }));
vi.mock('../ProviderModelSelector', () => ({ default: ({ onEffortChange }) => <button onClick={() => onEffortChange('high')}>High effort</button> }));
describe('creative draft conversation', () => {
  it('retains turns and proposals across follow-ups, preserves exact feedback, and applies only on request', async () => {
    const converse = vi.fn().mockResolvedValueOnce({ reply: 'Silver?', draft: { description: 'Silver design' }, sentPrompt: 'Exact prompt' })
      .mockResolvedValueOnce({ reply: 'Gold.', draft: { description: 'Gold design' }, sentPrompt: 'Next prompt' });
    const apply = vi.fn();
    render(<CreativeRefinement initialDraft={{ description: 'Original' }} converse={converse} onApply={apply} />);
    fireEvent.click(screen.getByText('High effort'));
    fireEvent.change(screen.getByLabelText('Direction or follow-up question'), { target: { value: '  Try silver  ' } });
    fireEvent.click(screen.getByText('Send direction'));
    await screen.findByDisplayValue('Silver design');
    expect(apply).not.toHaveBeenCalled();
    expect(converse.mock.calls[0][0]).toMatchObject({ effort: 'high', messages: [{ role: 'user', content: '  Try silver  ' }] });
    fireEvent.change(screen.getByLabelText('Direction or follow-up question'), { target: { value: 'Make it gold' } });
    fireEvent.click(screen.getByText('Send direction'));
    await screen.findByDisplayValue('Gold design');
    expect(converse.mock.calls[1][0]).toMatchObject({ draft: { description: 'Silver design' }, messages: [
      { role: 'user', content: '  Try silver  ' }, { role: 'assistant', content: 'Silver?' }, { role: 'user', content: 'Make it gold' },
    ] });
    fireEvent.click(screen.getByText('Apply proposal to editor'));
    expect(apply).toHaveBeenCalledWith({ description: 'Gold design' });
  });
  it('preserves the turn on failure and blocks apply when its host becomes read-only', async () => {
    const converse = vi.fn().mockRejectedValueOnce(new Error('Provider unavailable')).mockResolvedValueOnce({ reply: 'Draft', draft: { description: 'New' } });
    const apply = vi.fn();
    render(<CreativeRefinement initialDraft={{ description: 'Old' }} converse={converse} onApply={apply} disabled />);
    fireEvent.change(screen.getByLabelText('Direction or follow-up question'), { target: { value: 'Direction' } });
    fireEvent.click(screen.getByText('Send direction'));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Direction or follow-up question')).toHaveValue('Direction');
    fireEvent.click(screen.getByText('Send direction'));
    await waitFor(() => expect(screen.getByText('Apply proposal to editor')).toBeDisabled());
    expect(apply).not.toHaveBeenCalled();
  });
});
