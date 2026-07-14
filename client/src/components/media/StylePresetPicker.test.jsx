import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/apiSystem', () => ({
  listImageStylePresets: vi.fn(() => Promise.resolve([])),
}));

import StylePresetPicker from './StylePresetPicker';

describe('StylePresetPicker label association', () => {
  it('pairs the label with the select (htmlFor/id)', async () => {
    render(<StylePresetPicker value={null} onChange={() => {}} />);
    // findByLabelText both settles the async preset fetch and asserts the
    // label→control association is wired.
    const select = await screen.findByLabelText('Style preset');
    expect(select.tagName).toBe('SELECT');
  });

  it('honors a custom label prop', async () => {
    render(<StylePresetPicker value={null} onChange={() => {}} label="Cover style" />);
    expect((await screen.findByLabelText('Cover style')).tagName).toBe('SELECT');
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
