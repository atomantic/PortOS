// Socket events for the Shell page's iTerm2 view (#8114). A namespace of its
// own (`iterm:*`), backed by services/itermBridge.js — never the PortOS shell
// registry — so iTerm2 sessions cannot leak into the PortOS tab strip,
// Workspaces, or agent-run lookups. There is deliberately no resize, start,
// stop or restart event: iTerm2 owns its sessions' size and lifecycle.

import * as itermBridge from '../services/itermBridge.js';
import { itermInputSchema, itermSessionRefSchema, validateSocketData } from '../lib/socketValidation.js';

const logRejection = (event) => (err) => {
  console.error(`❌ Socket handler error [${event}]: ${err?.message ?? err}`);
};

export const detachItermSocket = (socket) => itermBridge.detachItermSocket(socket);

export const registerItermHandlers = (socket) => {
  socket.on('iterm:list', () => {
    itermBridge.subscribeItermList(socket).catch(logRejection('iterm:list'));
  });

  socket.on('iterm:unlist', () => {
    itermBridge.unsubscribeItermList(socket).catch(logRejection('iterm:unlist'));
  });

  socket.on('iterm:attach', (rawData) => {
    const validated = validateSocketData(itermSessionRefSchema, rawData, socket, 'iterm:attach');
    if (!validated) return;
    const attached = itermBridge.attachItermViewer(validated.id, socket);
    if (attached) socket.emit('iterm:attached', attached);
    else socket.emit('iterm:error', { id: validated.id, error: 'iTerm2 session not found' });
  });

  socket.on('iterm:detach', (rawData) => {
    const validated = validateSocketData(itermSessionRefSchema, rawData, socket, 'iterm:detach');
    if (!validated) return;
    itermBridge.detachItermViewer(validated.id, socket);
  });

  socket.on('iterm:input', (rawData) => {
    const validated = validateSocketData(itermInputSchema, rawData, socket, 'iterm:input');
    if (!validated) return;
    if (!itermBridge.sendItermInput(validated.id, validated.data)) {
      socket.emit('iterm:error', { id: validated.id, error: 'iTerm2 session not found' });
    }
  });
};
