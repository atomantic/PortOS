import { EventEmitter, once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { registerModelObservationSocket } from './modelObservation.js';
import './localModelObservations.js';

const probes = vi.hoisted(() => ({
  models: vi.fn(async () => []),
  config: vi.fn(async () => ({ enabled: true, stt: { engine: 'test' }, tts: { engine: 'test' } })),
}));
vi.mock('./settings.js', () => ({ getSettings: async () => ({}) }));
vi.mock('./ollamaManager.js', () => ({ getLoadedModels: probes.models, getLastLoadedModelsError: () => null }));
vi.mock('./lmStudioManager.js', () => ({ getLoadedModels: async () => [], getLastLoadedModelsError: () => null }));
vi.mock('./voice/config.js', () => ({ getVoiceConfig: probes.config }));
vi.mock('./voice/health.js', () => ({ checkAll: async () => ({}) }));
vi.mock('./voice/bootstrap.js', () => ({ verifyBinaries: async () => ({}), verifyModels: () => ({}) }));

it('starts each model probe on a socket subscription before any HTTP request', async () => {
  const socket = new EventEmitter();
  socket.connected = true;
  registerModelObservationSocket(socket);
  for (const [name, probe] of [['voice-readiness', probes.config], ['loaded-models', probes.models]]) {
    expect(probe).not.toHaveBeenCalled();
    const changed = once(socket, name + ':changed');
    socket.emit(name + ':subscribe');
    await changed;
    expect(probe).toHaveBeenCalledTimes(1);
  }
  socket.emit('disconnect');
});
