import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EditorialCustomCheckForm from './EditorialCustomCheckForm';

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
});
