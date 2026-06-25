import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditorialCustomCheckForm from './EditorialCustomCheckForm';

const fillRequired = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Anachronisms' } });
  fireEvent.change(screen.getByLabelText('What to look for'), { target: { value: 'Flag modern tech' } });
};

describe('EditorialCustomCheckForm (#1346)', () => {
  it('disables save until name + prompt are filled, then submits the trimmed values', () => {
    const onSave = vi.fn();
    render(<EditorialCustomCheckForm onSave={onSave} onCancel={() => {}} />);

    const submit = screen.getByRole('button', { name: /create check/i });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Anachronisms  ' } });
    fireEvent.change(screen.getByLabelText('What to look for'), { target: { value: '  Flag modern tech  ' } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Anachronisms',
      prompt: 'Flag modern tech',
      scope: 'issue',
      category: 'custom',
      severityDefault: 'medium',
    }));
  });

  it('prefills from an existing check when editing', () => {
    render(
      <EditorialCustomCheckForm
        check={{ id: 'custom.1', label: 'Existing', prompt: 'do thing', scope: 'series', category: 'voice', severityDefault: 'high', isCustom: true }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/edit custom check/i)).toBeTruthy();
    expect(screen.getByLabelText('Name').value).toBe('Existing');
    expect(screen.getByLabelText('What to look for').value).toBe('do thing');
    expect(screen.getByLabelText('Default severity').value).toBe('high');
  });

  it('invokes onCancel without saving', () => {
    const onCancel = vi.fn();
    render(<EditorialCustomCheckForm onSave={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  // Dry-run preview (#1607).
  it('hides the preview button entirely when onPreview is not provided', () => {
    render(<EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: /preview on this series/i })).toBeNull();
  });

  it('shows a hint and disables preview when no series is selected', () => {
    render(<EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} onPreview={vi.fn()} canPreview={false} />);
    fillRequired();
    expect(screen.getByRole('button', { name: /preview on this series/i }).disabled).toBe(true);
    expect(screen.getByText(/select a series above to preview/i)).toBeTruthy();
  });

  it('runs the draft and renders sample findings when a series is selected', async () => {
    const onPreview = vi.fn().mockResolvedValue({
      findings: [{ severity: 'high', location: 'Chapter 1', problem: 'Anachronistic phone', suggestion: 'Remove it', anchorQuote: 'rang' }],
      skipped: false,
      invalid: false,
    });
    render(<EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} onPreview={onPreview} canPreview />);
    fillRequired();
    const btn = screen.getByRole('button', { name: /preview on this series/i });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ label: 'Anachronisms', prompt: 'Flag modern tech' }));
    await waitFor(() => expect(screen.getByText(/anachronistic phone/i)).toBeTruthy());
    expect(screen.getByText(/sample findings/i)).toBeTruthy();
  });

  it('renders the empty-result message when the draft finds nothing', async () => {
    const onPreview = vi.fn().mockResolvedValue({ findings: [], skipped: false, invalid: false });
    render(<EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} onPreview={onPreview} canPreview />);
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /preview on this series/i }));
    await waitFor(() => expect(screen.getByText(/no sample findings/i)).toBeTruthy());
  });

  it('surfaces a preview error inline', async () => {
    const onPreview = vi.fn().mockRejectedValue(new Error('provider down'));
    render(<EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} onPreview={onPreview} canPreview />);
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /preview on this series/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/provider down/i));
  });

  it('clears a stale preview result when the draft is edited', async () => {
    const onPreview = vi.fn().mockResolvedValue({ findings: [{ severity: 'high', problem: 'Anachronistic phone' }], skipped: false, invalid: false });
    render(<EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} onPreview={onPreview} canPreview />);
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /preview on this series/i }));
    await waitFor(() => expect(screen.getByText(/anachronistic phone/i)).toBeTruthy());
    // Editing the prompt invalidates the now-stale result.
    fireEvent.change(screen.getByLabelText('What to look for'), { target: { value: 'Flag something else' } });
    expect(screen.queryByText(/anachronistic phone/i)).toBeNull();
  });

  it('ignores an in-flight preview that resolves after the draft changed', async () => {
    let resolve;
    const onPreview = vi.fn(() => new Promise((r) => { resolve = r; }));
    render(<EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} onPreview={onPreview} canPreview />);
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /preview on this series/i }));
    // User edits the draft while the preview is still in flight, then it resolves.
    fireEvent.change(screen.getByLabelText('What to look for'), { target: { value: 'Different prompt' } });
    resolve({ findings: [{ severity: 'high', problem: 'Stale finding' }], skipped: false, invalid: false });
    await waitFor(() => expect(onPreview).toHaveBeenCalled());
    expect(screen.queryByText(/stale finding/i)).toBeNull();
  });

  it('clears the preview when the target series changes', async () => {
    const onPreview = vi.fn().mockResolvedValue({ findings: [{ severity: 'low', problem: 'Series A finding' }], skipped: false, invalid: false });
    const { rerender } = render(
      <EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} onPreview={onPreview} canPreview previewTarget="series-a" />,
    );
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /preview on this series/i }));
    await waitFor(() => expect(screen.getByText(/series a finding/i)).toBeTruthy());
    rerender(<EditorialCustomCheckForm onSave={() => {}} onCancel={() => {}} onPreview={onPreview} canPreview previewTarget="series-b" />);
    expect(screen.queryByText(/series a finding/i)).toBeNull();
  });
});
