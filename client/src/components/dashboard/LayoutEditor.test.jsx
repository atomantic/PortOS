import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import LayoutEditor from './LayoutEditor.jsx';

// Registered widget ids so the editor renders real labels rather than the
// "(unknown — skipped)" fallback.
const WIDGET_IDS = ['quick-task', 'apps', 'backup'];

const LAYOUT = {
  id: 'demo',
  name: 'Demo',
  widgets: WIDGET_IDS,
  grid: [
    { id: 'quick-task', x: 0, y: 0, w: 6, h: 5 },
    { id: 'apps', x: 6, y: 0, w: 6, h: 5 },
    { id: 'backup', x: 0, y: 5, w: 12, h: 5 },
  ],
};

async function renderEditor() {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onDuplicate = vi.fn().mockResolvedValue(undefined);
  render(
    <LayoutEditor
      layouts={[LAYOUT]}
      activeLayoutId={LAYOUT.id}
      limits={null}
      onClose={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn()}
      onDuplicate={onDuplicate}
    />
  );
  await act(async () => {});
  return { onSave, onDuplicate };
}

// The widget rows are the only <li>s once a layout has widgets.
const widgetRows = () => screen.getAllByRole('listitem');
const clickButton = (name) => fireEvent.click(screen.getByRole('button', { name }));
const moveUp = (idx) => fireEvent.click(within(widgetRows()[idx]).getByLabelText('Move up'));
const moveDown = (idx) => fireEvent.click(within(widgetRows()[idx]).getByLabelText('Move down'));
// Two settles: one to run the click's own async handler, one to let the
// post-save state updates it schedules land inside act as well.
const settle = async (fire) => {
  await act(async () => { fire(); });
  await act(async () => {});
};
const save = () => settle(() => clickButton(/^Save$/));

describe('LayoutEditor reorder signal', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('moves a widget up in the list and flags the save as a reorder', async () => {
    const { onSave } = await renderEditor();
    moveUp(1);

    expect(widgetRows().map((li) => li.textContent)).toEqual([
      'Apps Grid', 'Quick Task', 'Backup',
    ]);

    await save();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      id: 'demo',
      widgets: ['apps', 'quick-task', 'backup'],
      reordered: true,
    }));
  });

  it('flags a Move down the same way', async () => {
    const { onSave } = await renderEditor();
    moveDown(0);
    await save();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      widgets: ['apps', 'quick-task', 'backup'],
      reordered: true,
    }));
  });

  // The whole point of the explicit signal: an unrelated save must leave the
  // stored grid coordinates alone (#4132).
  it('does not flag a rename as a reorder', async () => {
    const { onSave } = await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    await save();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Renamed',
      widgets: WIDGET_IDS,
      reordered: false,
    }));
  });

  it('does not flag a widget toggle as a reorder', async () => {
    const { onSave } = await renderEditor();
    fireEvent.click(within(widgetRows()[1]).getByLabelText('Remove widget'));
    clickButton(/Death Clock/);
    await save();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      widgets: ['quick-task', 'backup', 'death-clock'],
      reordered: false,
    }));
  });

  // `add` appends, so a widget added and then moved up IS a reorder — the grid
  // would otherwise auto-place it at the bottom, ignoring where it was put.
  it('flags a widget that was added and then moved up', async () => {
    const { onSave } = await renderEditor();
    clickButton(/Death Clock/);
    moveUp(3);
    await save();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      widgets: ['quick-task', 'apps', 'death-clock', 'backup'],
      reordered: true,
    }));
  });

  it('nets out a move up followed by a move back down', async () => {
    const { onSave } = await renderEditor();
    moveUp(1);
    moveDown(0);
    await save();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      widgets: WIDGET_IDS,
      reordered: false,
    }));
  });

  it('carries the reorder signal through "Save as new…"', async () => {
    const { onDuplicate } = await renderEditor();
    moveUp(2);
    clickButton(/Save as new/);
    await settle(() => clickButton(/^Create$/));
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({
      widgets: ['quick-task', 'backup', 'apps'],
      reordered: true,
    }));
  });
});
