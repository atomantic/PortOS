import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ImageGenSettingsForm from './ImageGenSettingsForm';

// Stub the heavy child pickers so the test pins ONLY this form's own
// responsibility: preserving every control + arranging them flat vs. grouped.
vi.mock('../media/BackendChipStrip', () => ({
  default: () => <div data-testid="backend-chip-strip" />,
}));
vi.mock('./ImageGenControls', () => ({
  default: () => <div data-testid="image-gen-controls" />,
}));
vi.mock('./LoraPicker', () => ({
  default: () => <div data-testid="lora-picker" />,
}));
vi.mock('../media/StylePresetPicker', () => ({
  default: () => <div data-testid="style-preset-picker" />,
}));

const BACKENDS = [{ id: 'local', label: 'Local' }];
const SECTION_TITLES = ['Backend', 'Model & LoRA', 'Prompts & Style'];

const renderForm = (props) =>
  render(<ImageGenSettingsForm value={{ mode: 'local' }} onChange={vi.fn()} {...props} />);

describe('ImageGenSettingsForm layout', () => {
  it('flat mode (default) renders no section headings but keeps all controls', () => {
    renderForm({ availableBackends: BACKENDS });
    SECTION_TITLES.forEach((title) => expect(screen.queryByRole('heading', { name: title })).toBeNull());
    expect(screen.getByTestId('backend-chip-strip')).toBeTruthy();
    expect(screen.getByTestId('image-gen-controls')).toBeTruthy();
    expect(screen.getByLabelText('Extra style (optional)')).toBeTruthy();
    expect(screen.getByLabelText('Negative prompt (optional)')).toBeTruthy();
  });

  it('grouped mode renders the three organized sections', () => {
    renderForm({ availableBackends: BACKENDS, grouped: true });
    SECTION_TITLES.forEach((title) =>
      expect(screen.getByRole('heading', { name: title })).toBeTruthy());
    // Every control from the flat layout is still present.
    expect(screen.getByTestId('backend-chip-strip')).toBeTruthy();
    expect(screen.getByTestId('image-gen-controls')).toBeTruthy();
    expect(screen.getByLabelText('Extra style (optional)')).toBeTruthy();
    expect(screen.getByLabelText('Negative prompt (optional)')).toBeTruthy();
  });

  it('grouped mode drops the Backend section (but not the warning) when no backend is configured', () => {
    renderForm({ availableBackends: [], grouped: true });
    expect(screen.queryByRole('heading', { name: 'Backend' })).toBeNull();
    expect(screen.getByText(/No image gen backend configured/)).toBeTruthy();
    // Model + Prompts sections still render.
    expect(screen.getByRole('heading', { name: 'Model & LoRA' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Prompts & Style' })).toBeTruthy();
  });

  it('grouped mode drops the Prompts & Style section when both style fields and preset are hidden', () => {
    renderForm({ availableBackends: BACKENDS, grouped: true, showStyleFields: false, showStylePreset: false });
    expect(screen.getByRole('heading', { name: 'Model & LoRA' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Prompts & Style' })).toBeNull();
    expect(screen.queryByLabelText('Extra style (optional)')).toBeNull();
  });
});
