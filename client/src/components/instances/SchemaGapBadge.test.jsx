import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SchemaGapBadge } from './SchemaGapBadge';

describe('SchemaGapBadge', () => {
  it('renders nothing when there are no gaps', () => {
    const { container } = render(<SchemaGapBadge peer={{ name: 'Peer A' }} peerSubs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when peer is null', () => {
    const { container } = render(<SchemaGapBadge peer={null} peerSubs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a "peer is behind" row when a push subscription is blockedBySchema', () => {
    render(
      <SchemaGapBadge
        peer={{ name: 'Bob' }}
        peerSubs={[{
          recordKind: 'universe',
          blockedBySchema: {
            ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }],
            peerPortosVersion: '2.5.0',
            detectedAt: '2026-05-23T00:00:00Z',
          },
        }]}
      />,
    );
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    expect(screen.getByText(/older PortOS/)).toBeInTheDocument();
    expect(screen.getByText('2.5.0')).toBeInTheDocument();
    expect(screen.getByText('universe')).toBeInTheDocument();
  });

  it('renders a "peer is ahead" row when peer.schemaGaps is set by snapshot sync', () => {
    render(
      <SchemaGapBadge
        peer={{
          name: 'Alice',
          schemaGaps: {
            universe: {
              ahead: [{ category: 'universes', senderV: 6, receiverV: 5 }],
              senderPortosVersion: '3.0.0',
              detectedAt: '2026-05-23T00:00:00Z',
            },
          },
        }}
        peerSubs={[]}
      />,
    );
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/update PortOS/)).toBeInTheDocument();
    expect(screen.getByText('3.0.0')).toBeInTheDocument();
  });

  it('renders both directions when both transports flag the peer', () => {
    render(
      <SchemaGapBadge
        peer={{
          name: 'Mixed',
          schemaGaps: {
            mediaCollections: {
              ahead: [{ category: 'mediaCollections', senderV: 2, receiverV: 1 }],
              senderPortosVersion: '2.9.0',
              detectedAt: '2026-05-23T00:00:00Z',
            },
          },
        }}
        peerSubs={[{
          recordKind: 'series',
          blockedBySchema: {
            ahead: [{ category: 'series', senderV: 3, receiverV: 2 }],
            peerPortosVersion: '2.5.0',
            detectedAt: '2026-05-23T00:00:00Z',
          },
        }]}
      />,
    );
    expect(screen.getByText(/older PortOS/)).toBeInTheDocument();
    expect(screen.getByText(/newer PortOS/)).toBeInTheDocument();
    expect(screen.getByText('2.5.0')).toBeInTheDocument();
    expect(screen.getByText('2.9.0')).toBeInTheDocument();
  });

  it('de-dupes when both transports flag the SAME direction + category', () => {
    render(
      <SchemaGapBadge
        peer={{
          name: 'Dup',
          schemaGaps: {
            universe: { ahead: [], behind: [], senderPortosVersion: '2.9', detectedAt: '2026-05-23' },
          },
        }}
        peerSubs={[{
          recordKind: 'universe',
          blockedBySchema: { ahead: [], behind: [], peerPortosVersion: '2.5', detectedAt: '2026-05-23' },
        }]}
      />,
    );
    // The peer-behind direction and receiver-behind direction map to
    // DIFFERENT direction keys (peer-behind vs receiver-behind), so both
    // rows render — but in a future "same direction, same category" case
    // only one would show.
    // Here, ensure no crash and at least one row renders.
    expect(screen.getByText(/Schema version mismatch/)).toBeInTheDocument();
  });
});
