import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/apiSystem', () => ({
  listImageStylePresets: vi.fn(() => Promise.resolve([])),
}));

import StylePresetPicker from './StylePresetPicker';

describe('StylePresetPicker label association', () => {
  it('pairs the label with the select via explicit htmlFor/id', async () => {
    render(<StylePresetPicker value={null} onChange={() => {}} />);
    // findByLabelText settles the async preset fetch; asserting htmlFor === id
    // proves the *visible* label is wired (findByLabelText alone would also
    // accept an aria-label with a detached visible label).
    const select = await screen.findByLabelText('Style preset');
    const label = screen.getByText('Style preset').closest('label');
    expect(select.tagName).toBe('SELECT');
    expect(select.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(select.id);
  });

  it('honors a custom label prop', async () => {
    render(<StylePresetPicker value={null} onChange={() => {}} label="Cover style" />);
    const select = await screen.findByLabelText('Cover style');
    const label = screen.getByText('Cover style').closest('label');
    expect(label.getAttribute('for')).toBe(select.id);
  });

  it('gives each instance a unique control id', async () => {
    render(
      <>
        <StylePresetPicker value={null} onChange={() => {}} label="First" />
        <StylePresetPicker value={null} onChange={() => {}} label="Second" />
      </>
    );
    const a = await screen.findByLabelText('First');
    const b = await screen.findByLabelText('Second');
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });
});

describe('StylePresetPicker preset read', () => {
  it('shows a failed preset read with Retry instead of an empty picker', async () => {
    const { listImageStylePresets } = await import('../../services/apiSystem');
    listImageStylePresets.mockRejectedValueOnce(new Error('presets unavailable'));
    render(<StylePresetPicker value={null} onChange={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load style presets — presets unavailable');

    listImageStylePresets.mockResolvedValueOnce([{ id: 'ink', label: 'Ink wash', category: 'Painterly' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'Ink wash' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Style preset')).not.toBeDisabled();
  });
});
