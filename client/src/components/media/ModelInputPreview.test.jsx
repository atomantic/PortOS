import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ModelInputPreview from './ModelInputPreview.jsx';

describe('reference-input preview', () => {
  it('distinguishes CLI driver inputs from direct-provider inputs', () => {
    const sent = { sentPrompt: 'Draw a fox', referenceImages: [{ filename: 'ref.png', status: 'included', role: 'edit-base' }] };
    const { rerender } = render(<ModelInputPreview prompt="Draw a fox" preview={{ preview: { ...sent, referenceInputProvenance: 'cli-attachments' } }} />);
    expect(screen.getByText('Will be attached to Codex; image-tool use unconfirmed')).toBeTruthy();
    expect(screen.getByText('Edit base — requested as the image to edit')).toBeTruthy();
    expect(screen.queryByText('Will be sent to the model')).toBeNull();

    rerender(<ModelInputPreview prompt="Draw a fox" preview={{ preview: { ...sent, referenceInputProvenance: 'cli-requested' } }} />);
    expect(screen.getByText('Will be requested from the CLI driver; image-tool use unconfirmed')).toBeTruthy();

    rerender(<ModelInputPreview prompt="Draw a fox" preview={{ preview: { ...sent, remote: true } }} />);
    expect(screen.getByText('Will be sent to the peer; image-tool use unconfirmed')).toBeTruthy();

    rerender(<ModelInputPreview prompt="Draw a fox" preview={{ preview: sent }} />);
    expect(screen.getByText('Will be sent to the model')).toBeTruthy();
    expect(screen.getByText('Edit base — the render starts from this image')).toBeTruthy();
  });

  it('explains blocked canonical references without calling the render text-only', () => {
    const preview = (referenceImages) => ({ preview: { sentPrompt: 'Draw a fox', referenceImages } });
    const { rerender } = render(<ModelInputPreview prompt="Draw a fox" preview={preview([
      { filename: 'missing.png', status: 'missing' },
    ])} />);
    expect(screen.getByText(/Restore unavailable canonical references/)).toBeTruthy();
    expect(screen.queryByText(/generated from text only/)).toBeNull();

    rerender(<ModelInputPreview prompt="Draw a fox" preview={preview([
      { filename: 'available.png', status: 'included' }, { filename: 'unsupported.png', status: 'unsupported' },
    ])} />);
    expect(screen.getByText(/Restore unavailable canonical references/)).toBeTruthy();
    expect(screen.queryByText(/generated from text only/)).toBeNull();

    rerender(<ModelInputPreview prompt="Draw a fox" preview={preview([
      { filename: 'excluded.png', status: 'left-out' }, { filename: 'relative.png', status: 'missing', relative: 'parent' },
    ])} />);
    expect(screen.queryByText(/Restore unavailable canonical references/)).toBeNull();
    expect(screen.getByText(/generated from text only/)).toBeTruthy();
  });
});
