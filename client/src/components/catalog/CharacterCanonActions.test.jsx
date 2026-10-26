import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import CharacterCanonActions from './CharacterCanonActions';
vi.mock('../universe/VisionDescribeModal', () => ({ default: ({ onApply, onApplyFields, onClose }) => <div role="dialog">
  <button onClick={() => onApply('Reviewed prose')}>Apply prose</button>
  <button onClick={() => onApplyFields({ visualNotes: 'Reviewed attributes' })}>Apply attributes</button>
  <button onClick={onClose}>Close proposals</button>
</div> }));
// The real modal owns staged proposals; this boundary pins that the canonical
// caller retains both applications across the first one's dirty-state change.
it('applies both reviewed proposals into one draft and keeps execution pending until the modal closes', () => {
  let draft = {};
  const pending = vi.fn();
  function Harness() {
    const [payload, setPayload] = useState({}); draft = payload;
    return <CharacterCanonActions universe={{ id: 'example-universe' }} entry={{ id: 'example-entry', name: 'Example' }}
      disabled={Object.keys(payload).length > 0} applyDisabled={false} onPatch={patch => setPayload(previous => ({ ...previous, ...patch }))}
      onChanged={vi.fn()} onPendingChange={pending} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Describe Example from images' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply prose' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Apply attributes' }));
  expect(draft).toEqual({ physicalDescription: 'Reviewed prose', visualNotes: 'Reviewed attributes' });
  expect(pending).not.toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: 'Close proposals' }));
  expect(pending).toHaveBeenLastCalledWith(false);
});
