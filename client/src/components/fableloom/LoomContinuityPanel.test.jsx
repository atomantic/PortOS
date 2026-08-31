import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../../services/api';
import LoomContinuityPanel from './LoomContinuityPanel';

vi.mock('../../services/api');

describe('LoomContinuityPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.reviewLoomEpisodeContinuity.mockResolvedValue({
      passed: false,
      nodesEvaluated: 3,
      summary: { errors: 1, warnings: 0, info: 0 },
      findings: [{
        id: 'finding-1', category: 'visual', severity: 'error',
        message: 'Character binding is missing', remediation: 'Bind the canonical character.', nodeId: 'scene-1',
      }],
    });
  });

  it('runs separately from rendering and returns review state to the workflow owner', async () => {
    const user = userEvent.setup();
    const onReviewChange = vi.fn();
    const onSelectNode = vi.fn();
    const { rerender } = render(
      <LoomContinuityPanel
        loom={{ id: 'loom-1' }}
        episode={{ id: 'episode-1' }}
        review={null}
        onReviewChange={onReviewChange}
        onSelectNode={onSelectNode}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Run continuity review' }));
    await waitFor(() => expect(onReviewChange).toHaveBeenCalledWith(
      'episode-1',
      expect.objectContaining({ passed: false }),
    ));
    const review = onReviewChange.mock.calls[0][1];
    rerender(
      <LoomContinuityPanel
        loom={{ id: 'loom-1' }}
        episode={{ id: 'episode-1' }}
        review={review}
        onReviewChange={onReviewChange}
        onSelectNode={onSelectNode}
      />,
    );

    expect(screen.getByText('Character binding is missing')).toBeInTheDocument();
    expect(screen.getByText('Fix: Bind the canonical character.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Character binding is missing/i }));
    expect(onSelectNode).toHaveBeenCalledWith('scene-1');
  });
});
