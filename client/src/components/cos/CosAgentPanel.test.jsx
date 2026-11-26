import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import CosAgentPanel from './CosAgentPanel';

describe('CosAgentPanel mobile disclosure', () => {
  it.each([false, true])('references mounted content with desktopCollapsed=%s', async (desktopCollapsed) => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CosAgentPanel
          cos={{ status: { running: false }, agentState: 'idle', avatarStyle: 'svg' }}
          activeTab="tasks"
          riggedAvatars={[]}
          desktopCollapsed={desktopCollapsed}
          onToggleDesktop={vi.fn()}
        />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('button', { name: /^CoS\b/i });
    const expectCollapsed = () => {
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      if (desktopCollapsed) {
        expect(toggle).not.toHaveAttribute('aria-controls');
        expect(document.getElementById('cos-agent-panel')).toBeNull();
      } else {
        expect(toggle).toHaveAttribute('aria-controls', 'cos-agent-panel');
        expect(document.getElementById('cos-agent-panel')).toBeInTheDocument();
      }
    };

    expectCollapsed();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'cos-agent-panel');
    expect(document.getElementById('cos-agent-panel')).toBeInTheDocument();

    await user.click(toggle);
    expectCollapsed();
  });
});
