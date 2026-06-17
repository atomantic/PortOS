import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ObjectAttachmentsEditor from './ObjectAttachmentsEditor';

const WATCH = { id: 'obj-watch', name: 'Pocket Watch' };
const MARA = { id: 'chr-mara', name: 'Mara' };
const BRAM = { id: 'chr-bram', name: 'Bram' };

// The section starts collapsed — open it by clicking its header button.
const openAttachments = () => {
  fireEvent.click(screen.getByRole('button', { name: /Attachments/i }));
};

describe('ObjectAttachmentsEditor (#1288)', () => {
  it('prompts to add a character when the universe has none', () => {
    render(<ObjectAttachmentsEditor entry={WATCH} characters={[]} onPatch={() => {}} />);
    openAttachments();
    expect(screen.getByText(/Add a character to this universe/i)).toBeInTheDocument();
  });

  it('adds an attachment defaulting to the first character + custom role', () => {
    const onPatch = vi.fn();
    render(<ObjectAttachmentsEditor entry={WATCH} characters={[MARA, BRAM]} onPatch={onPatch} />);
    openAttachments();
    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
    expect(onPatch).toHaveBeenCalledWith({
      attachments: [{ characterId: 'chr-mara', emotion: '', significance: '', origin: '', role: 'custom' }],
    });
  });

  it('renders an existing attachment with character + role selects', () => {
    const entry = {
      ...WATCH,
      attachments: [{ id: 'att-1', characterId: 'chr-mara', role: 'memento' }],
    };
    render(<ObjectAttachmentsEditor entry={entry} characters={[MARA, BRAM]} onPatch={() => {}} />);
    openAttachments();
    expect(screen.getByRole('combobox', { name: /attachment 1 character/i })).toHaveValue('chr-mara');
    expect(screen.getByRole('combobox', { name: /attachment 1 role/i })).toHaveValue('memento');
  });

  it('patches the role when the role select changes', () => {
    const onPatch = vi.fn();
    const entry = {
      ...WATCH,
      attachments: [{ id: 'att-1', characterId: 'chr-mara', role: 'memento' }],
    };
    render(<ObjectAttachmentsEditor entry={entry} characters={[MARA]} onPatch={onPatch} />);
    openAttachments();
    fireEvent.change(screen.getByRole('combobox', { name: /attachment 1 role/i }), {
      target: { value: 'talisman' },
    });
    expect(onPatch).toHaveBeenCalledWith({
      attachments: [{ id: 'att-1', characterId: 'chr-mara', role: 'talisman' }],
    });
  });

  it('keeps an attachment removable + surfaces a deleted character as "(missing)"', () => {
    const onPatch = vi.fn();
    const entry = {
      ...WATCH,
      attachments: [{ id: 'att-1', characterId: 'chr-deleted', role: 'memento' }],
    };
    render(<ObjectAttachmentsEditor entry={entry} characters={[MARA]} onPatch={onPatch} />);
    openAttachments();
    expect(screen.getByText(/missing: chr-deleted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove attachment 1/i }));
    expect(onPatch).toHaveBeenCalledWith({ attachments: [] });
  });

  it('shows the attachment count in the header', () => {
    const entry = {
      ...WATCH,
      attachments: [{ id: 'att-1', characterId: 'chr-mara' }, { id: 'att-2', characterId: 'chr-bram' }],
    };
    render(<ObjectAttachmentsEditor entry={entry} characters={[MARA, BRAM]} onPatch={() => {}} />);
    expect(screen.getByText(/Attachments \(2\)/i)).toBeInTheDocument();
  });

  it('renders nothing when read-only with no attachments', () => {
    const { container } = render(
      <ObjectAttachmentsEditor entry={WATCH} characters={[MARA]} onPatch={() => {}} disabled />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
