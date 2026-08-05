import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Regression guard for #3567: the three Writers Room live panels explained
// their actions and reported their daily budgets ONLY through `title="…"`,
// which a touch screen never reveals. Every action now carries an explicit
// accessible name, and each budget names itself in visible text.

const suggestWritersRoomContinuation = vi.fn();
const suggestWritersRoomCdBridge = vi.fn();
const sendWritersRoomCdBridge = vi.fn();
vi.mock('../../services/apiWritersRoom', () => ({
  suggestWritersRoomContinuation: (...a) => suggestWritersRoomContinuation(...a),
  suggestWritersRoomCdBridge: (...a) => suggestWritersRoomCdBridge(...a),
  sendWritersRoomCdBridge: (...a) => sendWritersRoomCdBridge(...a),
  reserveWritersRoomRenderPreview: vi.fn(),
  attachWritersRoomSceneImage: vi.fn(),
}));
vi.mock('../../services/apiSystem', () => ({ generateImage: vi.fn() }));
// Socket.IO auto-connects on import (LiveRenderPanel).
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false },
}));

import CdBridgePanel from './CdBridgePanel';
import LiveBudgetBadge from './LiveBudgetBadge';
import LiveContinuationPanel from './LiveContinuationPanel';
import LiveRenderPanel from './LiveRenderPanel';

beforeEach(() => {
  suggestWritersRoomContinuation.mockReset();
  suggestWritersRoomCdBridge.mockReset();
  sendWritersRoomCdBridge.mockReset();
});

const getCursorContext = () => ({ before: 'Some prose before. ', after: '', selection: '' });

// WCAG 2.5.3 "Label in Name": an aria-label that describes the action must still
// CONTAIN the words on the button, or voice control ("click Suggest") can no
// longer reach it. Every action here is labelled `<visible text>: <what it does>`.
function expectLabelInName(btn) {
  expect(btn.getAttribute('aria-label')).toContain(btn.textContent.trim());
}

function renderCdBridge(liveMode, usage) {
  render(
    <MemoryRouter>
      <CdBridgePanel
        workId="wr-work-1"
        liveMode={liveMode}
        usage={usage}
        onUsageChange={() => {}}
        getCursorContext={getCursorContext}
        onLinked={() => {}}
      />
    </MemoryRouter>,
  );
}

function renderContinuation(liveMode, usage) {
  render(
    <LiveContinuationPanel
      workId="wr-work-1"
      liveMode={liveMode}
      usage={usage}
      onUsageChange={() => {}}
      getCursorContext={getCursorContext}
      onInsert={() => {}}
      registerTrigger={() => {}}
    />,
  );
}

function renderLiveRender(liveMode) {
  render(
    <LiveRenderPanel
      workId="wr-work-1"
      liveMode={liveMode}
      getCursorOffset={() => 0}
      body=""
      renderContext={{ analysisId: null, scenes: [] }}
      registerQueue={() => {}}
      onSceneImageAttached={() => {}}
      workTitle="Example Work"
    />,
  );
}

describe('LiveBudgetBadge', () => {
  it('names the budget it reports in visible text', () => {
    render(<LiveBudgetBadge label="Renders" budget={10} spent={3} />);
    expect(screen.getByText('Renders: 7 / 10 left today')).toBeInTheDocument();
  });

  it('warns visibly (not just by tone) once the budget is spent', () => {
    render(<LiveBudgetBadge label="Renders" budget={10} spent={10} />);
    const badge = screen.getByText('Renders: 0 / 10 left today — resets at UTC midnight');
    expect(badge.className).toContain('text-port-error');
  });

  it('tones the readout as a warning while the budget runs low', () => {
    const { container } = render(<LiveBudgetBadge label="Renders" budget={10} spent={8} />);
    expect(screen.getByText('Renders: 2 / 10 left today').className).toContain('text-port-warning');
    // The warning is not colour-only — an icon rides along with it.
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('reads "unlimited" (with no warning tone) when no budget is configured', () => {
    render(<LiveBudgetBadge label="Suggestions" budget={0} spent={99} />);
    const badge = screen.getByText('Suggestions: unlimited');
    expect(badge.className).toContain('text-gray-500');
    expect(badge.className).not.toContain('text-port-error');
  });

  it('never reports a negative balance when spend has overrun the budget', () => {
    render(<LiveBudgetBadge label="Suggestions" budget={5} spent={9} />);
    expect(screen.getByText(/Suggestions: 0 \/ 5 left today/)).toBeInTheDocument();
  });
});

describe('CdBridgePanel a11y (#3567)', () => {
  const liveMode = { enabled: true, dailyCallBudget: 100 };

  it('exposes the Propose action by name and meets the 44px touch floor', () => {
    renderCdBridge(liveMode, { count: 0 });
    const btn = screen.getByRole('button', { name: 'Propose treatment: Turns the prose at your cursor into a Creative Director treatment' });
    expectLabelInName(btn);
    expect(btn.className).toContain('min-h-[44px]');
  });

  it('shows the shared suggestion budget without hover', () => {
    renderCdBridge(liveMode, { count: 40 });
    expect(screen.getByText('Suggestions (shared): 60 / 100 left today')).toBeInTheDocument();
  });

  it('explains the Send action in visible text as well as its accessible name', async () => {
    suggestWritersRoomCdBridge.mockResolvedValue({
      proposal: { logline: 'A logline.', scenes: [] },
      usage: { count: 1 },
    });
    renderCdBridge(liveMode, { count: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Propose treatment: Turns the prose at your cursor into a Creative Director treatment' }));

    const send = await screen.findByRole('button', {
      name: 'Send to Creative Director: Creates a new Creative Director project seeded with this treatment',
    });
    expectLabelInName(send);
    expect(send.className).toContain('min-h-[44px]');
    expect(
      screen.getByText('Creates a new Creative Director project seeded with this treatment.'),
    ).toBeInTheDocument();
  });
});

describe('LiveContinuationPanel a11y (#3567)', () => {
  const liveMode = { enabled: true, dailyCallBudget: 20 };

  it('exposes the Suggest action by name and meets the 44px touch floor', () => {
    renderContinuation(liveMode, { count: 0 });
    const btn = screen.getByRole('button', { name: 'Suggest a continuation from the cursor' });
    expectLabelInName(btn);
    expect(btn.className).toContain('min-h-[44px]');
  });

  it('shows the suggestion budget without hover', () => {
    renderContinuation(liveMode, { count: 18 });
    expect(screen.getByText('Suggestions: 2 / 20 left today')).toBeInTheDocument();
  });

  it('gives each Insert button an accessible name naming the suggestion it inserts', async () => {
    suggestWritersRoomContinuation.mockResolvedValue({
      options: [
        { kind: 'prose', text: 'Prose one.' },
        { kind: 'dialogue', text: 'Dialogue two.' },
      ],
      usage: { count: 1 },
    });
    renderContinuation(liveMode, { count: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a continuation from the cursor' }));

    const first = await screen.findByRole('button', { name: 'Insert Prose suggestion 1 at cursor' });
    expectLabelInName(first);
    expect(first.className).toContain('min-h-[44px]');
    expect(screen.getByRole('button', { name: 'Insert Dialogue suggestion 2 at cursor' })).toBeInTheDocument();
  });
});

describe('LiveRenderPanel a11y (#3567)', () => {
  const liveMode = { enabled: true, dailyRenderBudget: 5, renderUsage: { count: 1 } };

  it('exposes the Render action by name and meets the 44px touch floor', () => {
    renderLiveRender(liveMode);
    const btn = screen.getByRole('button', { name: 'Render scene: Renders a quick reference image for the scene at your cursor' });
    expectLabelInName(btn);
    expect(btn.className).toContain('min-h-[44px]');
  });

  it('shows the render budget and what the action does without hover', () => {
    renderLiveRender(liveMode);
    expect(screen.getByText('Renders: 4 / 5 left today')).toBeInTheDocument();
    expect(
      screen.getByText('Renders a quick reference image for the scene at your cursor.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Place your cursor in a scene to render it.')).toBeInTheDocument();
  });
});
