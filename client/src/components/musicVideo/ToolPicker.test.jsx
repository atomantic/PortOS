import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ToolPicker from './ToolPicker.jsx';
const image = vi.hoisted(() => ({ models: [], installDefault: null, failed: false }));
vi.mock('../../hooks/useLocalImageModels.js', () => ({ default: () => image }));
vi.mock('../../services/apiImageVideo.js', () => ({ getVideoGenModelContext: vi.fn() }));
beforeEach(() => { cleanup(); Object.assign(image, { models: [], installDefault: null, failed: false }); });
const show = (models = {}) => {
  const onChange = vi.fn();
  render(<ToolPicker tools={['image:local', 'image:fal']} models={models} onChange={onChange} />);
  return onChange;
};
describe('local image tool models', () => {
  it('selects listed models and keeps the blank install-default choice without converting cloud inputs', () => {
    Object.assign(image, { models: [{ id: 'example-image', name: 'Example image' }], installDefault: 'example-image' });
    const onChange = show();
    const select = screen.getByRole('combobox');
    expect(screen.getByRole('option', { name: 'Install default (Example image)' })).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'example-image' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ models: { 'image:local': 'example-image' } }));
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ models: { 'image:local': '' } }));
  });
  it.each([false, true])('preserves unknown pins with an empty or failed catalog (%s)', (failed) => {
    image.failed = failed;
    show({ 'image:local': 'missing-image' });
    expect(screen.getByRole('combobox').value).toBe('missing-image');
    expect(screen.getByRole('option', { name: 'missing-image (unavailable on this machine)' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(failed ? /Could not load/ : /No local image models/);
    expect(screen.getByRole('combobox').disabled).toBe(false);
  });
});
describe('codex image tool', () => {
  it('shows no model field and drops a stale pin when toggled', () => {
    const onChange = vi.fn();
    render(<ToolPicker tools={['image:codex']} models={{ 'image:codex': 'old' }} onChange={onChange} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByText('Codex image gen $'));
    expect(onChange).toHaveBeenLastCalledWith({ tools: [], models: {} });
  });
});
