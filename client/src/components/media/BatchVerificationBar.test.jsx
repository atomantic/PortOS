import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BatchVerificationBar from './BatchVerificationBar';

describe('BatchVerificationBar', () => {
  it('renders correctly with selection count and triggers actions', () => {
    const onSelectAll = vi.fn();
    const onClearSelection = vi.fn();
    const onRunBatchVerify = vi.fn();
    const onCancel = vi.fn();
    const onProfileChange = vi.fn();

    render(
      <BatchVerificationBar
        selectedCount={3}
        totalImages={5}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
        onRunBatchVerify={onRunBatchVerify}
        onCancel={onCancel}
        selectedProfile="strict_anatomy"
        onProfileChange={onProfileChange}
      />
    );

    expect(screen.getByText('Batch Verify: 3 selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Select All \(5\)/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Clear/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Verify Selected \(3\)/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Select All \(5\)/i }));
    expect(onSelectAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Verify Selected \(3\)/i }));
    expect(onRunBatchVerify).toHaveBeenCalledWith('strict_anatomy', 'auto');

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders model options including Argon and Qwen', () => {
    const onModelChange = vi.fn();
    render(
      <BatchVerificationBar
        selectedCount={1}
        totalImages={3}
        selectedModel="gemini-4-argon"
        onModelChange={onModelChange}
      />
    );

    const modelSelect = screen.getByTitle('Select evaluator model');
    expect(modelSelect).toBeTruthy();
    expect(screen.getByText('Google Gemini 4 Argon')).toBeTruthy();
    expect(screen.getByText('Qwen 27B / 27G (Local)')).toBeTruthy();

    fireEvent.change(modelSelect, { target: { value: 'qwen-27b' } });
    expect(onModelChange).toHaveBeenCalledWith('qwen-27b');
  });

  it('displays progress when isVerifying is true', () => {
    render(
      <BatchVerificationBar
        selectedCount={2}
        totalImages={2}
        isVerifying={true}
        progress={{ current: 1, total: 2 }}
      />
    );

    expect(screen.getByText(/Verifying 1 of 2\.\.\./i)).toBeTruthy();
  });
});
