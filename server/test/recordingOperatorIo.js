import { expect, vi } from 'vitest';
import { PEER_SOCKET_ROOM } from '../services/socketIo.js';

/** Record operator broadcasts and assert the excluded audience. */
export function recordingOperatorIo(emit = vi.fn()) {
  return {
    emit,
    except(room) {
      expect(room).toBe(PEER_SOCKET_ROOM);
      return { emit };
    },
  };
}
