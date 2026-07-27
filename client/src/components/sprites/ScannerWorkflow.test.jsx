import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiSprites.js', () => ({
  approveSpriteScanner: vi.fn(() => Promise.resolve({})),
}));

import ScannerWorkflow from './ScannerWorkflow.jsx';
import { approveSpriteScanner } from '../../services/apiSprites.js';

const record = { id: 'example-walker' };
const reference = { manifest: { mainReference: { locked: true } } };

describe('ScannerWorkflow', () => {
  it('exposes the user-triggered scanner generation path and reviews a candidate strip', () => {
    const onGenerate = vi.fn();
    render(
      <ScannerWorkflow
        record={record}
        reference={reference}
        scanner={{
          runs: [{
            id: 'scanner-east-12345678', direction: 'east', status: 'candidate',
            stripPreview: { stripPath: 'runs/scanner-east-12345678/generated/example-scanner-east-strip.png', stripSha256: 'abc' },
          }],
          selection: { directions: {} },
        }}
        onGenerate={onGenerate}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/Scanner Action/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);
    expect(onGenerate).toHaveBeenCalled();
    expect(screen.getByRole('img', { name: /east scanner action preview/i })).toBeInTheDocument();
  });

  it('approves the reviewed scanner candidate through the named endpoint', async () => {
    render(
      <ScannerWorkflow
        record={record}
        reference={reference}
        scanner={{ runs: [{ id: 'scanner-east-12345678', direction: 'east', status: 'candidate' }], selection: { directions: {} } }}
        onGenerate={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve scanner east' }));
    await waitFor(() => expect(approveSpriteScanner).toHaveBeenCalledWith(
      'example-walker', { direction: 'east', runId: 'scanner-east-12345678' }, { silent: true },
    ));
  });
});

// Correction note on the scanner card (#3134) — the same shared page-owned map
// every other regeneration surface writes, under a scanner-namespaced key.
describe('scanner correction note (#3134)', () => {
  const scanner = { runs: [], selection: { directions: {} } };

  it('writes through to the shared map under the scanner-namespaced key', () => {
    const onCorrectionChange = vi.fn();
    render(
      <ScannerWorkflow
        record={record}
        reference={reference}
        scanner={scanner}
        onGenerate={vi.fn()}
        onChanged={vi.fn()}
        corrections={{}}
        onCorrectionChange={onCorrectionChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Show correction note for east scanner action/i }));
    fireEvent.change(screen.getByLabelText(/Correction guidance for the east scanner action/i), {
      target: { value: 'the sweep never returns to the start pose' },
    });
    const merged = onCorrectionChange.mock.calls[0][0]({ east: 'anchor note' });
    // The anchor's still-image note is untouched; the scanner note gets its own key.
    expect(merged.east).toBe('anchor note');
    expect(merged).toHaveProperty('scanner:east');
  });

  it('omits the affordance when the page supplies no writer', () => {
    render(
      <ScannerWorkflow
        record={record}
        reference={reference}
        scanner={scanner}
        onGenerate={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /correction note/i })).toBeNull();
  });
});
