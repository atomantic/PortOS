import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import useTokenPopover from '../../hooks/useTokenPopover.js';
import ProseReader from './ProseReader.jsx';
import ProseTokenPopover from './ProseTokenPopover.jsx';

const characters = [{ id: 'example-character', name: 'Example Hero' }];
function Reader() {
  const { pop, hotRef, closePopover, ...handlers } = useTokenPopover();
  return (
    <>
      <ProseReader
        body="Example Hero walks onward."
        characters={characters}
        hotRef={hotRef}
        pinnedToken={pop?.pinned ? pop : null}
        {...handlers}
      />
      <ProseTokenPopover
        open={Boolean(pop)}
        pinned={Boolean(pop?.pinned)}
        anchorEl={pop?.anchorEl}
        kind={pop?.kind}
        refId={pop?.refId}
        characters={characters}
        onClose={closePopover}
      />
      <button type="button">Outside</button>
    </>
  );
}
afterEach(cleanup);

describe('pinned prose profile keyboard interaction', () => {
  // Exercises the real reader, token state machine, and dialog together:
  // keyboard pinning must expose the dialog without traversing the manuscript.
  it.each(['{Enter}', ' '])('pins with %s, traps focus, and restores the token on dismissal', async (key) => {
    const user = userEvent.setup();
    render(<Reader />);
    const token = screen.getByRole('button', { name: 'Character: Example Hero' });
    expect(token).toHaveAttribute('aria-haspopup', 'dialog');
    expect(token).toHaveAttribute('aria-expanded', 'false');
    await user.tab();
    await user.keyboard(key);
    const close = screen.getByRole('button', { name: 'Close' });
    const profile = screen.getByRole('button', { name: 'Open profile' });
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(token).toHaveAttribute('aria-expanded', 'true');
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(profile).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(token).toHaveFocus();
    expect(token).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard(key);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(token).toHaveFocus();
  });
});
