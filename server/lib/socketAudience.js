/** Operator audience filter for Socket.IO broadcasts. */

// Room joined by every peer-authenticated socket (paired peer token, legacy
// Basic relay, or a peer-identified socket on a password-free install). Peers
// are excluded from operator broadcasts.
export const PEER_SOCKET_ROOM = 'peer-sockets';

/** Emit to operators on the supplied Socket.IO server. */
export function emitToOperatorsOn(io, event, ...args) {
  io?.except(PEER_SOCKET_ROOM).emit(event, ...args);
}
