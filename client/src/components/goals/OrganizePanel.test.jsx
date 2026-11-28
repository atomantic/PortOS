import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OrganizePanel from './OrganizePanel';

const SAMPLE_SUGGESTION = {
  analysis: 'Group related goals under an apex goal.',
  apexGoal: { suggestedTitle: 'North Star', suggestedDescription: 'Long-term aim' },
  organization: [{ id: 'g1', goalType: 'standard', reasoning: 'Supports the apex goal' }],
};

function Harness({ onApply = vi.fn() }) {
  const [suggestion, setSuggestion] = useState(null);
  return (
    <div>
      <button type="button" onClick={() => setSuggestion(SAMPLE_SUGGESTION)}>
        Organize
      </button>
      <OrganizePanel
        suggestion={suggestion}
        goals={[{ id: 'g1', title: 'First Goal' }]}
        onApply={onApply}
        onClose={() => setSuggestion(null)}
        applying={false}
      />
    </div>
  );
}

describe('OrganizePanel', () => {
  it('traps Tab focus inside the modal dialog and restores focus on Escape', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Organize' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Goal Organization' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Goal Organization' }));

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    dismissBtn.focus();
    fireEvent.keyDown(dismissBtn, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);

    fireEvent.keyDown(closeBtn, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(dismissBtn);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
