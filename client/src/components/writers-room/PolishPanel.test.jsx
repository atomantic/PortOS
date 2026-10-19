import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';

vi.mock('../../services/apiWritersRoom', () => ({
  startWritersRoomPolish: vi.fn(),
  cancelWritersRoomPolish: vi.fn(),
  getWritersRoomPolishStatus: vi.fn(),
  listWritersRoomPolishSnapshots: vi.fn(),
  revertWritersRoomPolishSnapshot: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import PolishPanel from './PolishPanel';
import {
  getWritersRoomPolishStatus,
  listWritersRoomPolishSnapshots,
  startWritersRoomPolish,
  revertWritersRoomPolishSnapshot,
} from '../../services/apiWritersRoom';

describe('PolishPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWritersRoomPolishStatus.mockResolvedValue({ active: false });
    listWritersRoomPolishSnapshots.mockResolvedValue([
      { id: 'snap-1', cycle: 1, label: 'Cycle 1', wordCount: 1200, qualityScore: 7.5, createdAt: new Date().toISOString() },
    ]);
  });
  afterEach(() => {
    cleanup();
  });

  // The snapshot Revert button used to be an 11px icon + 11px label with no
  // vertical padding — a ~16px tall tap target on a phone (#3565). Assert the
  // utility tokens rather than computed geometry; jsdom applies no Tailwind.
  it('a11y: the snapshot Revert button meets the 44px touch-target floor', async () => {
    render(<PolishPanel work={{ id: 'work-1' }} dirty={false} />);

    const revertBtn = await screen.findByRole('button', { name: /revert/i });
    expect(revertBtn.className).toContain('min-h-[44px]');
    expect(revertBtn.className).toContain('min-w-[44px]');
  });
});


it('blocks server body mutations during a draft transition and reports pending revert ownership', async () => {
  getWritersRoomPolishStatus.mockResolvedValue({ active: false });
  listWritersRoomPolishSnapshots.mockResolvedValue([{ id: 'snap-1', label: 'Earlier draft', createdAt: '2026-01-01T00:00:00Z' }]);
  const busy = vi.fn();
  let resolve;
  revertWritersRoomPolishSnapshot.mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));
  const props = { work: { id: 'work-1' }, dirty: false, onBusyChange: busy };
  const view = render(<PolishPanel {...props} blocked />);
  const revert = await screen.findByRole('button', { name: /revert/i });
  expect(revert).toBeDisabled();
  fireEvent.click(revert);
  expect(revertWritersRoomPolishSnapshot).not.toHaveBeenCalled();
  expect(startWritersRoomPolish).not.toHaveBeenCalled();
  view.rerender(<PolishPanel {...props} />);
  fireEvent.click(revert);
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => { resolve({ ok: true }); });
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(revert).toBeEnabled();
});
