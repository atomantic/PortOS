import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import OpenWorldFastTravel from './OpenWorldFastTravel';
import { OPEN_WORLD_REGIONS } from '../../utils/openWorldRegions';

const renderPanel = (props = {}) => render(
  <OpenWorldFastTravel
    open
    onClose={vi.fn()}
    onTravel={vi.fn()}
    onOpenPage={vi.fn()}
    activeRegionId={null}
    onLeaveRegion={vi.fn()}
    {...props}
  />
);

describe('OpenWorldFastTravel', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<OpenWorldFastTravel open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every region when open', () => {
    renderPanel();
    const list = screen.getByRole('list');
    for (const region of OPEN_WORLD_REGIONS) {
      expect(within(list).getByText(region.label)).toBeInTheDocument();
    }
  });

  it('warps and closes when a region is picked', () => {
    const onTravel = vi.fn();
    const onClose = vi.fn();
    renderPanel({ onTravel, onClose });

    fireEvent.click(screen.getByRole('list').querySelector('button'));

    expect(onTravel).toHaveBeenCalledTimes(1);
    expect(onTravel.mock.calls[0][0].id).toBe(OPEN_WORLD_REGIONS[0].id);
    // Warping dismisses the panel so the camera flight isn't hidden behind it.
    expect(onClose).toHaveBeenCalled();
  });

  it('filters the list by the search box', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Search regions'), { target: { value: 'memory' } });

    const list = screen.getByRole('list');
    expect(within(list).getByText('Memory Quarter')).toBeInTheDocument();
    expect(within(list).queryByText('Data Harbor')).not.toBeInTheDocument();
  });

  it('reports an empty result rather than an empty panel', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Search regions'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/NO REGION MATCHES/)).toBeInTheDocument();
  });

  it('opens the PortOS page a region stands for without warping', () => {
    const onOpenPage = vi.fn();
    const onTravel = vi.fn();
    renderPanel({ onOpenPage, onTravel });

    fireEvent.change(screen.getByLabelText('Search regions'), { target: { value: 'memory' } });
    fireEvent.click(screen.getByTitle('Open /brain/inbox'));

    expect(onOpenPage).toHaveBeenCalledWith('/brain/inbox');
    expect(onTravel).not.toHaveBeenCalled();
  });

  it('omits the OPEN affordance for a region with no page behind it', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Search regions'), { target: { value: 'quiet corner' } });
    const list = screen.getByRole('list');
    expect(within(list).getByText('Quiet Corner')).toBeInTheDocument();
    expect(within(list).queryByText('OPEN')).not.toBeInTheDocument();
  });

  it('offers a way back to the overview only while a region is active', () => {
    const onLeaveRegion = vi.fn();
    const onClose = vi.fn();
    const { rerender } = renderPanel({ onLeaveRegion, onClose });
    // No region warped to → nothing to leave.
    expect(screen.queryByText('OVERVIEW')).not.toBeInTheDocument();

    rerender(
      <OpenWorldFastTravel
        open
        onClose={onClose}
        onTravel={vi.fn()}
        onOpenPage={vi.fn()}
        onLeaveRegion={onLeaveRegion}
        activeRegionId="memory"
      />
    );
    fireEvent.click(screen.getByText('OVERVIEW'));
    expect(onLeaveRegion).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('is an accessible dialog that closes from the backdrop and from Escape', () => {
    // Chrome comes from the shared <Modal>, so these assert the wiring, not a re-roll.
    const onClose = vi.fn();
    renderPanel({ onClose });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Fast travel');

    fireEvent.click(dialog.parentElement);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('offers a map marker for every region, aimed at the same warp', () => {
    const onTravel = vi.fn();
    renderPanel({ onTravel });
    for (const region of OPEN_WORLD_REGIONS) {
      expect(screen.getByLabelText(`Travel to ${region.label}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByLabelText('Travel to Data Harbor'));
    expect(onTravel.mock.calls[0][0].id).toBe('data-harbor');
  });
});
