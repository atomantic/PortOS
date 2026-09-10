import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DeriveFromManuscriptPreview from './DeriveFromManuscriptPreview.jsx';

const preview = {
  arc: { protagonistArc: '' },
  bible: {},
  volume: {},
  issues: [{ id: 'issue-1', number: 1, title: '', currentSynopsis: '' }],
};

describe('DeriveFromManuscriptPreview field caps', () => {
  it('uses server caps and trims the volume title before confirming', () => {
    const onConfirm = vi.fn();
    render(<DeriveFromManuscriptPreview preview={preview} committing={false} onCancel={vi.fn()} onConfirm={onConfirm} />);

    const volumeTitle = screen.getByPlaceholderText('Volume title');
    const protagonistArc = screen.getByText('Protagonist arc').parentElement.querySelector('textarea');
    const issueTitle = screen.getByPlaceholderText('Issue title');
    expect(volumeTitle.maxLength).toBe(200);
    expect(protagonistArc.maxLength).toBe(4000);
    expect(issueTitle.maxLength).toBe(300);

    const longTitle = 'x'.repeat(250);
    fireEvent.change(volumeTitle, { target: { value: longTitle } });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      volume: { title: longTitle.slice(0, 200), logline: '', synopsis: '' },
    }));
  });
});
