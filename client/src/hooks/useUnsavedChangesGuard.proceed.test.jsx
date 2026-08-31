import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const { blocker } = vi.hoisted(() => ({
  blocker: { proceed: vi.fn(), reset: vi.fn(), state: 'blocked' },
}));

vi.mock('react-router', () => ({ useBlocker: () => blocker }));

import useUnsavedChangesGuard from './useUnsavedChangesGuard.js';

function Editor() {
  const [dirty, setDirty] = useState(true);
  const { proceed } = useUnsavedChangesGuard(dirty, { beforeUnload: false });
  return <button type="button" onClick={() => { setDirty(false); proceed(); }}>Discard</button>;
}

describe('useUnsavedChangesGuard proceed', () => {
  it('proceeds a parked navigation once when Discard also clears the draft', () => {
    blocker.proceed.mockClear();
    render(<Editor />);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(blocker.proceed).toHaveBeenCalledTimes(1);
  });
});
