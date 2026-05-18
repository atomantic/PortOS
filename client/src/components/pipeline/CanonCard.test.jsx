import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// CanonCard subscribes to live job progress via the socket-backed hook; the
// chip-label code path doesn't touch it, but the hook would otherwise wire
// up listeners during render. Stub it to a neutral resting state.
vi.mock('../../hooks/useMediaJobProgress', () => ({
  __esModule: true,
  default: () => ({ status: 'unknown', filename: null, error: null }),
}));

// MediaJobThumb is rendered only when `inFlightJobId` is truthy — none of
// these tests exercise that, so a stub keeps the test runtime self-contained.
vi.mock('./MediaJobThumb', () => ({
  __esModule: true,
  default: () => null,
}));

import CanonCard from './CanonCard';

const kind = {
  key: 'characters',
  label: 'Characters',
  descFor: (e) => e.description || '',
};

const baseEntry = {
  id: 'ent-1',
  name: 'Lyra',
  description: 'Cartographer-spy.',
};

const render_ = (props) => render(
  <CanonCard
    kind={kind}
    entry={baseEntry}
    onRender={() => {}}
    {...props}
  />
);

describe('CanonCard — "from series" provenance chip', () => {
  it('omits the chip entirely when sourceSeriesId is absent', () => {
    render_();
    expect(screen.queryByText(/^from /)).not.toBeInTheDocument();
    expect(screen.queryByText('from series')).not.toBeInTheDocument();
  });

  it('falls back to generic "from series" label + id tooltip when seriesNameMap is missing', () => {
    render_({ entry: { ...baseEntry, sourceSeriesId: 'ser-abc' } });
    const chip = screen.getByText('from series');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('title', 'Introduced by series ser-abc');
  });

  it('renders the series name from seriesNameMap and includes id in tooltip', () => {
    render_({
      entry: { ...baseEntry, sourceSeriesId: 'ser-abc' },
      seriesNameMap: { 'ser-abc': 'Phantom Pact' },
    });
    const chip = screen.getByText('from Phantom Pact');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('title', 'Introduced by series "Phantom Pact" (ser-abc)');
  });

  it('falls back to generic label when sourceSeriesId is not present in seriesNameMap', () => {
    render_({
      entry: { ...baseEntry, sourceSeriesId: 'ser-missing' },
      seriesNameMap: { 'ser-other': 'Other Series' },
    });
    expect(screen.getByText('from series')).toBeInTheDocument();
    expect(screen.queryByText(/from ser-missing/)).not.toBeInTheDocument();
  });
});
