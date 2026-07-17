import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
