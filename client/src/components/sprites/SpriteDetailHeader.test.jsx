/**
 * SpriteDetailHeader — inline rename/delete for the sprite you're viewing.
 * Shares useSpriteRecordCrud with the catalog card, so this pins the header's
 * own wiring: the name + meta render, rename round-trips the API and reports
 * up, and delete is gated behind the confirm step.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SpriteDetailHeader from './SpriteDetailHeader.jsx';

const updateSpriteRecord = vi.fn();
const deleteSpriteRecord = vi.fn();
vi.mock('../../services/apiSprites.js', () => ({
  updateSpriteRecord: (...a) => updateSpriteRecord(...a),
  deleteSpriteRecord: (...a) => deleteSpriteRecord(...a),
}));

const RECORD = { id: 'bad-name-9x', name: 'sdxl_0007_final', kind: 'character', status: 'draft' };

beforeEach(() => { updateSpriteRecord.mockReset(); deleteSpriteRecord.mockReset(); });

describe('SpriteDetailHeader', () => {
  it('renders the name and kind/status meta', () => {
    render(<SpriteDetailHeader record={RECORD} onRenamed={() => {}} onDeleted={() => {}} />);
    expect(screen.getByRole('heading', { name: 'sdxl_0007_final' })).toBeInTheDocument();
    expect(screen.getByText(/character · draft/)).toBeInTheDocument();
  });

  it('renames the open record and reports the update up', async () => {
    const onRenamed = vi.fn();
    const updated = { ...RECORD, name: 'Rattlesnake Kate' };
    updateSpriteRecord.mockResolvedValue(updated);
    render(<SpriteDetailHeader record={RECORD} onRenamed={onRenamed} onDeleted={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rename sdxl_0007_final' }));
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'Rattlesnake Kate');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));

    expect(updateSpriteRecord).toHaveBeenCalledWith('bad-name-9x', { name: 'Rattlesnake Kate' }, { silent: true });
    expect(onRenamed).toHaveBeenCalledWith(updated);
  });

  it('deletes only after the confirm step and reports the id up', async () => {
    const onDeleted = vi.fn();
    deleteSpriteRecord.mockResolvedValue({ deleted: true });
    render(<SpriteDetailHeader record={RECORD} onRenamed={() => {}} onDeleted={onDeleted} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete sdxl_0007_final' }));
    expect(deleteSpriteRecord).not.toHaveBeenCalled();
    expect(screen.getByText(/This can’t be undone/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(deleteSpriteRecord).toHaveBeenCalledWith('bad-name-9x', { silent: true });
    expect(onDeleted).toHaveBeenCalledWith('bad-name-9x');
  });
});
