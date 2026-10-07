/**
 * Contract: a share this install refuses because it is behind the sender raises
 * one persistent bell card per manifest, and the card goes away once that
 * manifest imports or the sender withdraws it.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  removeByMetadata: vi.fn().mockResolvedValue({ success: true, removed: 0 }),
  NOTIFICATION_TYPES: { SHARE_BLOCKED: 'share_blocked' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));

import { installShareRefusalNotifier } from './shareRefusalNotifier.js';
import { addNotification, exists, removeByMetadata } from '../notifications.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

let events;
beforeEach(() => {
  vi.clearAllMocks();
  exists.mockResolvedValue(false);
  events = new EventEmitter();
  installShareRefusalNotifier(events);
});

describe('installShareRefusalNotifier', () => {
  it('raises a card for a share whose storage layout is ahead of this install', async () => {
    events.emit('portos-schema-ahead', {
      bucketId: 'bkt-1', manifestId: 'mfst-1', manifestFilename: 'a.json',
      ahead: [{ category: 'pipelineSeries', senderV: 9, receiverV: 8 }],
      producedByVersion: '9.1.0', source: 'Example Studio',
    });
    await flush();
    const card = addNotification.mock.calls[0][0];
    expect(card).toMatchObject({ type: 'share_blocked', link: '/sharing/buckets/bkt-1?tab=activity' });
    expect(card.description).toContain('Example Studio (PortOS 9.1.0)');
    expect(card.description).toContain('pipelineSeries');
    expect(card.description).toContain('imports it automatically');
  });

  it('raises a card for a share on a newer share protocol', async () => {
    events.emit('incompatible-manifest', {
      bucketId: 'bkt-1', manifestId: 'mfst-2', manifestFilename: 'b.json',
      remoteVersion: 3, localVersion: 2, producedByVersion: 'unknown', source: 'Example Studio',
    });
    await flush();
    const card = addNotification.mock.calls[0][0];
    expect(card.description).toContain('share protocol v3');
    expect(card.description).not.toContain('PortOS unknown');
  });

  it('stays silent when the same manifest is already announced', async () => {
    exists.mockResolvedValue(true);
    events.emit('portos-schema-ahead', { bucketId: 'bkt-1', manifestFilename: 'a.json', ahead: [] });
    await flush();
    expect(exists).toHaveBeenCalledWith('share_blocked', 'shareRefusalKey', 'bkt-1/a.json');
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('retracts the card when the manifest imports or the sender withdraws it', async () => {
    events.emit('manifest-processed', { bucketId: 'bkt-1', manifestFilename: 'a.json' });
    events.emit('unshared', { bucketId: 'bkt-1', manifestFilename: 'b.json' });
    await flush();
    expect(removeByMetadata).toHaveBeenCalledWith('shareRefusalKey', 'bkt-1/a.json');
    expect(removeByMetadata).toHaveBeenCalledWith('shareRefusalKey', 'bkt-1/b.json');
  });
});
