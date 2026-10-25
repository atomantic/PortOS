import * as shellService from '../services/shell.js';
import { getProviderById } from '../services/providers.js';
import { prepareExecutionOptions } from '../lib/providerExecutionOptions.js';
import { buildTuiShellLaunch } from '../lib/tuiShellLaunch.js';
import {
  shellAttachSchema,
  shellCdSchema,
  shellInputSchema,
  shellResizeSchema,
  shellStartSchema,
  shellStopSchema,
  validateSocketData
} from '../lib/socketValidation.js';

export const detachShellSocket = (socket) => shellService.detachSocketSessions(socket);

export const registerShellHandlers = (socket, _io) => {
  // `providerId` is the AI Providers page's "Launch in Shell" path. The client
  // sends only the ID and the server resolves the command and secret-bearing
  // environment, preventing both backend drift and client-selected commands.
  socket.on('shell:start', async (rawOptions) => {
    const options = validateSocketData(shellStartSchema, rawOptions, socket, 'shell:start');
    if (options === null) return;
    try {
      const cwd = options?.cwd || undefined;
      const providerId = typeof options?.providerId === 'string' ? options.providerId : null;
      let initialCommand = options?.initialCommand || undefined;
      let env;
      if (providerId) {
        let provider = await getProviderById(providerId).catch(() => null);
        if (provider) {
          const prepared = await prepareExecutionOptions(provider, provider.defaultModel, undefined, 'run', { cwd });
          provider = prepared.provider;
        }
        const launch = buildTuiShellLaunch(provider);
        if (!launch) {
          socket.emit('shell:error', { error: `Provider '${providerId}' is not a launchable TUI provider` });
          return;
        }
        initialCommand = launch.commandLine;
        env = launch.env;
      }
      const sessionId = shellService.createShellSession(socket, { cwd, env });
      if (sessionId) {
        socket.emit('shell:started', { sessionId });
        if (initialCommand) {
          setTimeout(() => shellService.submitToSession(sessionId, initialCommand), 200);
        }
      } else {
        socket.emit('shell:error', { error: 'Failed to create shell session' });
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [shell:start]: ${message}`);
      socket.emit('shell:error', { error: message });
    }
  });

  socket.on('shell:attach', (rawData) => {
    const validated = validateSocketData(shellAttachSchema, rawData, socket, 'shell:attach');
    if (!validated) return;
    const result = shellService.attachSession(validated.sessionId, socket, { claim: validated.claim });
    if (result?.claimRejected) {
      socket.emit('shell:error', { error: 'Session attached to another client', sessionId: validated.sessionId });
    } else if (result) {
      socket.emit('shell:attached', result);
    } else {
      socket.emit('shell:error', { error: 'Session not found', sessionId: validated.sessionId });
    }
  });

  socket.on('shell:list', () => {
    shellService.subscribeSessionList(socket);
    socket.emit('shell:sessions', shellService.listAllSessions(socket));
  });

  socket.on('shell:input', (rawData) => {
    const validated = validateSocketData(shellInputSchema, rawData, socket, 'shell:input');
    if (!validated) return;
    if (!shellService.writeToSession(validated.sessionId, validated.data)) {
      socket.emit('shell:error', { sessionId: validated.sessionId, error: 'Session not found' });
    }
  });

  // The client picks a folder; the server renders the command for the shell
  // actually backing the session, including Windows cmd.exe sessions.
  socket.on('shell:cd', (rawData) => {
    const validated = validateSocketData(shellCdSchema, rawData, socket, 'shell:cd');
    if (!validated) return;
    if (!shellService.changeSessionDirectory(validated.sessionId, validated.path)) {
      const isRun = shellService.getSession(validated.sessionId)?.external;
      socket.emit('shell:error', {
        sessionId: validated.sessionId,
        error: isRun ? 'This is a live agent run, not a shell — cd is unavailable here' : 'Session not found'
      });
    }
  });

  socket.on('shell:resize', (rawData) => {
    const validated = validateSocketData(shellResizeSchema, rawData, socket, 'shell:resize');
    if (!validated) return;
    if (!shellService.resizeSession(validated.sessionId, validated.cols, validated.rows)) {
      socket.emit('shell:error', { sessionId: validated.sessionId, error: 'Session not found or resize failed' });
    }
  });

  socket.on('shell:stop', (rawData) => {
    const validated = validateSocketData(shellStopSchema, rawData, socket, 'shell:stop');
    if (!validated) return;
    shellService.killSession(validated.sessionId);
  });

  socket.on('shell:release-views', () => {
    shellService.releaseExternalViewsForSocket(socket);
  });
};
