import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the API so a suggest/proposal call returns a deterministic usage count.
const suggestWritersRoomContinuation = vi.fn();
const suggestWritersRoomCdBridge = vi.fn();
const sendWritersRoomCdBridge = vi.fn();
vi.mock('../../services/apiWritersRoom', () => ({
  suggestWritersRoomContinuation: (...args) => suggestWritersRoomContinuation(...args),
  suggestWritersRoomCdBridge: (...args) => suggestWritersRoomCdBridge(...args),
  sendWritersRoomCdBridge: (...args) => sendWritersRoomCdBridge(...args),
}));

import LiveContinuationPanel from './LiveContinuationPanel';
import CdBridgePanel from './CdBridgePanel';

beforeEach(() => {
  suggestWritersRoomContinuation.mockReset();
  suggestWritersRoomCdBridge.mockReset();
  sendWritersRoomCdBridge.mockReset();
});

const liveMode = { enabled: true, dailyCallBudget: 100, usage: { count: 0 } };
const getCursorContext = () => ({ before: 'Some prose before. ', after: '', selection: '' });

// Harness mirrors WorkEditor's lifted shared-usage state: a single `liveUsage`
// owned by the parent, passed to both panels with one setter.
function Harness() {
  const [liveUsage, setLiveUsage] = useState(liveMode.usage);
  return (
    <MemoryRouter>
      <LiveContinuationPanel
        workId="wr-work-1"
        liveMode={liveMode}
        usage={liveUsage}
        onUsageChange={setLiveUsage}
        getCursorContext={getCursorContext}
        onInsert={() => {}}
        registerTrigger={() => {}}
      />
      <CdBridgePanel
        workId="wr-work-1"
        liveMode={liveMode}
        usage={liveUsage}
        onUsageChange={setLiveUsage}
        getCursorContext={getCursorContext}
        onLinked={() => {}}
      />
    </MemoryRouter>
  );
}

describe('live text-suggest budget shares across panels', () => {
  it('a continuation suggest updates the CD bridge readout too', async () => {
    suggestWritersRoomContinuation.mockResolvedValue({ options: [], usage: { count: 7 } });
    render(<Harness />);

    // Both panels start at the full budget.
    expect(screen.getAllByText('100 / 100 left today')).toHaveLength(2);

    // Spend budget from the continuation panel.
    fireEvent.click(screen.getByTitle('Suggest a continuation from the cursor'));

    // BOTH readouts reflect the new count — the CD bridge panel did NOT make
    // the call but still updates because the counter is lifted into the parent.
    await waitFor(() => {
      expect(screen.getAllByText('93 / 100 left today')).toHaveLength(2);
    });
  });

  it('a CD bridge proposal updates the continuation readout too', async () => {
    suggestWritersRoomCdBridge.mockResolvedValue({ proposal: null, usage: { count: 12 } });
    render(<Harness />);

    fireEvent.click(screen.getByTitle('Propose a Creative Director treatment from the cursor'));

    await waitFor(() => {
      expect(screen.getAllByText('88 / 100 left today')).toHaveLength(2);
    });
  });
});
