import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import VideoGenGallery from './VideoGenGallery';
import { finishTargetForRecord } from '../../lib/videoFinish';

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

const DRAFT_MODEL = { id: 'draft_model', name: 'Draft (4-step)', finishModelId: 'delivery_model' };
const DELIVERY_MODEL = { id: 'delivery_model', name: 'Delivery (20-step)' };

const videoRecord = (over = {}) => ({
  id: 'rec-1',
  filename: 'rec-1.mp4',
  thumbnail: 'rec-1.jpg',
  prompt: 'a quiet street at dusk',
  modelId: 'draft_model',
  seed: 424242,
  mode: 'text',
  renderInputsVersion: 1,
  conditioning: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const renderGallery = ({ records, models, onFinish = vi.fn() }) => {
  render(
    <MemoryRouter>
      <VideoGenGallery
        galleryVisible={records}
        galleryHidden={[]}
        favoritesOnly={false}
        showHidden={false}
        onToggleFavorites={vi.fn()}
        onToggleShowHidden={vi.fn()}
        onPreview={vi.fn()}
        onContinue={vi.fn()}
        onUpscale={vi.fn()}
        onDelete={vi.fn()}
        onToggleHidden={vi.fn()}
        getCardProps={() => ({ showCollectionMenu: false, showMoodBoardMenu: false })}
        finishTargetFor={(raw) => finishTargetForRecord(raw, models)}
        onFinish={onFinish}
      />
    </MemoryRouter>,
  );
  return { onFinish };
};

describe('VideoGenGallery — Finish action (#3696)', () => {
  it('offers Finish for a reproducible text-to-video draft with an available delivery model', () => {
    renderGallery({ records: [videoRecord()], models: [DRAFT_MODEL, DELIVERY_MODEL] });
    expect(screen.getByRole('button', { name: /Finish/i })).toBeInTheDocument();
  });

  it('names the delivery model in the affordance so the user knows what they are switching to', () => {
    renderGallery({ records: [videoRecord()], models: [DRAFT_MODEL, DELIVERY_MODEL] });
    expect(screen.getByRole('button', { name: /Finish/i })).toHaveAttribute(
      'title',
      expect.stringContaining('Delivery (20-step)'),
    );
  });

  it('hands the raw record plus the resolved target to the handler — and starts nothing itself', () => {
    const { onFinish } = renderGallery({ records: [videoRecord()], models: [DRAFT_MODEL, DELIVERY_MODEL] });
    fireEvent.click(screen.getByRole('button', { name: /Finish/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    const [raw, target] = onFinish.mock.calls[0];
    expect(raw.id).toBe('rec-1');
    expect(target.id).toBe('delivery_model');
  });

  it('omits Finish for an image-conditioned draft', () => {
    renderGallery({
      records: [videoRecord({ mode: 'image', conditioning: ['image'] })],
      models: [DRAFT_MODEL, DELIVERY_MODEL],
    });
    expect(screen.queryByRole('button', { name: /Finish/i })).toBeNull();
  });

  it('omits Finish for a legacy record with no durable re-render inputs', () => {
    const { renderInputsVersion, conditioning, ...legacy } = videoRecord();
    renderGallery({ records: [legacy], models: [DRAFT_MODEL, DELIVERY_MODEL] });
    expect(screen.queryByRole('button', { name: /Finish/i })).toBeNull();
  });

  it('omits Finish when the delivery model is not installed here', () => {
    renderGallery({ records: [videoRecord()], models: [DRAFT_MODEL] });
    expect(screen.queryByRole('button', { name: /Finish/i })).toBeNull();
  });

  it('renders the gallery unchanged when no finish wiring is supplied at all', () => {
    render(
      <MemoryRouter>
        <VideoGenGallery
          galleryVisible={[videoRecord()]}
          galleryHidden={[]}
          favoritesOnly={false}
          showHidden={false}
          onToggleFavorites={vi.fn()}
          onToggleShowHidden={vi.fn()}
          onPreview={vi.fn()}
          onContinue={vi.fn()}
          onUpscale={vi.fn()}
          onDelete={vi.fn()}
          onToggleHidden={vi.fn()}
          getCardProps={() => ({ showCollectionMenu: false, showMoodBoardMenu: false })}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /Finish/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Continue/i })).toBeInTheDocument();
  });
});
