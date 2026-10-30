import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
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
  it('uses host edits after reopening and preserves fields the proposal did not change', async () => {
    const converse = vi.fn().mockResolvedValue({ reply: 'Revised', draft: { description: 'Silver design', prompt: 'Edited prompt' } });
    function Host() {
      const [draft, setDraft] = useState({ description: 'Original', prompt: 'Original prompt' });
      const [open, setOpen] = useState(true);
      return <>
        <button onClick={() => setOpen(value => !value)}>Toggle conversation</button>
        <input aria-label="Editor prompt" value={draft.prompt} onChange={event => setDraft(previous => ({ ...previous, prompt: event.target.value }))} />
        <div hidden={!open}><CreativeRefinement initialDraft={draft} converse={converse} onApply={patch => setDraft(previous => ({ ...previous, ...patch }))} /></div>
      </>;
    }
    render(<Host />);
    fireEvent.click(screen.getByText('Toggle conversation'));
    fireEvent.change(screen.getByLabelText('Editor prompt'), { target: { value: 'Edited prompt' } });
    fireEvent.click(screen.getByText('Toggle conversation'));
    fireEvent.change(screen.getByLabelText('Direction or follow-up question'), { target: { value: 'Try silver' } });
    fireEvent.click(screen.getByText('Send direction'));
    await screen.findByDisplayValue('Silver design');
    expect(converse.mock.calls[0][0].draft).toEqual({ description: 'Original', prompt: 'Edited prompt' });
    fireEvent.change(screen.getByLabelText('Editor prompt'), { target: { value: 'Keep this newer edit' } });
    fireEvent.click(screen.getByText('Apply proposal to editor'));
    expect(screen.getByLabelText('Editor prompt')).toHaveValue('Keep this newer edit');
    fireEvent.change(screen.getByLabelText('Direction or follow-up question'), { target: { value: 'Follow up' } });
    fireEvent.click(screen.getByText('Send direction'));
    await waitFor(() => expect(converse).toHaveBeenCalledTimes(2));
    expect(converse.mock.calls[1][0].draft).toEqual({ description: 'Silver design', prompt: 'Keep this newer edit' });
  });
  it('preserves the turn on failure and blocks apply when its host becomes read-only', async () => {
    const converse = vi.fn().mockRejectedValueOnce(new Error('Provider unavailable')).mockResolvedValueOnce({ reply: 'Draft', draft: { description: 'New' } });
    const apply = vi.fn();
    const fork = vi.fn();
    render(<CreativeRefinement initialDraft={{ description: 'Old' }} converse={converse} onApply={apply} onFork={fork} disabled />);
    fireEvent.change(screen.getByLabelText('Direction or follow-up question'), { target: { value: 'Direction' } });
    fireEvent.click(screen.getByText('Send direction'));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Direction or follow-up question')).toHaveValue('Direction');
    fireEvent.click(screen.getByText('Send direction'));
    await waitFor(() => expect(screen.getByText('Apply proposal to editor')).toBeDisabled());
    expect(apply).not.toHaveBeenCalled();
    // A locked source can still be redesigned onto a fork.
    fireEvent.click(screen.getByText('Save as fork…'));
    expect(fork).toHaveBeenCalledWith({ description: 'New' });
  });
  it('requires a fresh choice before replacing a newer edit to a proposed field', async () => {
    const converse = vi.fn().mockResolvedValue({ reply: 'Revised', draft: { description: 'Silver design', prompt: 'New prompt' } });
    function Host() {
      const [draft, setDraft] = useState({ description: 'Original', prompt: 'Original prompt' });
      return <>
        <input aria-label="Editor description" value={draft.description} onChange={event => setDraft(previous => ({ ...previous, description: event.target.value }))} />
        <input aria-label="Editor prompt" value={draft.prompt} onChange={event => setDraft(previous => ({ ...previous, prompt: event.target.value }))} />
        <CreativeRefinement initialDraft={draft} converse={converse} onApply={patch => setDraft(previous => ({ ...previous, ...patch }))} />
      </>;
    }
    render(<Host />);
    fireEvent.change(screen.getByLabelText('Direction or follow-up question'), { target: { value: 'Try silver' } });
    fireEvent.click(screen.getByText('Send direction'));
    await screen.findByDisplayValue('Silver design');
    fireEvent.change(screen.getByLabelText('Editor description'), { target: { value: 'Newer edit' } });
    expect(screen.getByText('Apply proposal to editor')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use proposal for description' }));
    expect(screen.getByText('Apply proposal to editor')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Editor description'), { target: { value: 'Newest edit' } });
    expect(screen.getByText('Apply proposal to editor')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editor for description' }));
    fireEvent.click(screen.getByText('Apply proposal to editor'));
    expect(screen.getByLabelText('Editor description')).toHaveValue('Newest edit');
    expect(screen.getByLabelText('Editor prompt')).toHaveValue('New prompt');
  });
});
