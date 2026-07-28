/**
 * User-triggered AI feedback for a Game's asset plan.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { buildEffortArgs } from '../../lib/providerModels.js';
import {
  resolveEffectiveModel,
  runPromptThroughProvider,
} from '../../lib/promptRunner.js';
import { getAppById } from '../apps.js';
import { getProviderById } from '../providers.js';
import { getRecord as getSpriteRecord } from '../sprites/records.js';
import { getTrack } from '../tracks/index.js';
import { GAME_HISTORY_LIMIT, getGame, mutateGame } from './records.js';

async function buildGameFeedbackPrompt(game, request) {
  const [app, sprites, tracks] = await Promise.all([
    getAppById(game.appId),
    Promise.all(game.spriteBindings.map((binding) => getSpriteRecord(binding.spriteId))),
    Promise.all(game.musicBindings.map((binding) => getTrack(binding.trackId))),
  ]);
  if (!app) throw new ServerError('The bound managed app no longer exists', { status: 409, code: 'APP_MISSING' });

  const assetSummary = {
    game: game.name,
    app: {
      name: app.name,
      type: app.type || 'unknown',
      description: app.description || '',
    },
    sprites: sprites.filter(Boolean).map((sprite) => ({
      id: sprite.id,
      name: sprite.name,
      kind: sprite.kind,
      status: sprite.status,
    })),
    music: tracks.filter(Boolean).map((track) => ({
      id: track.id,
      title: track.title,
      hasAudio: Boolean(track.audioFilename),
    })),
    compiledManifest: game.compiledManifest,
  };
  return `You are reviewing an asset bundle plan for a game project.

Give concise, actionable feedback about coverage, visual/audio cohesion, missing gameplay-facing assets, and the next highest-value improvements. Do not propose implementing a game engine or changing the managed app's repository.

USER REQUEST:
${request}

GAME ASSET PLAN:
${JSON.stringify(assetSummary, null, 2)}`;
}

export async function requestGameFeedback(id, { providerId, model, effort, prompt }) {
  const game = await getGame(id);
  if (!game) throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  const provider = await getProviderById(providerId);
  if (!provider) {
    throw new ServerError('AI provider not found', { status: 404, code: 'PROVIDER_NOT_FOUND' });
  }
  if (provider.enabled === false) {
    throw new ServerError('Choose an enabled AI provider', { status: 400, code: 'PROVIDER_UNAVAILABLE' });
  }
  const selectedModel = resolveEffectiveModel(provider, model);
  const effortArgs = buildEffortArgs(effort, provider, provider.args || []);
  const run = await runPromptThroughProvider({
    provider: effortArgs.length ? { ...provider, args: [...(provider.args || []), ...effortArgs] } : provider,
    model: selectedModel ?? undefined,
    prompt: await buildGameFeedbackPrompt(game, prompt),
    source: 'game-asset-feedback',
  });
  const createdAt = new Date().toISOString();
  const feedback = {
    id: `feedback-${randomUUID()}`,
    prompt,
    text: run.text,
    providerId: run.provider?.id || run.fallbackProvider?.id || provider.id,
    model: run.model || selectedModel || provider.defaultModel || null,
    effort: effort || null,
    createdAt,
  };
  const updated = await mutateGame(id, (current) => ({
    ...current,
    feedbackHistory: [...current.feedbackHistory, feedback].slice(-GAME_HISTORY_LIMIT),
  }));
  return { feedback, game: updated };
}
