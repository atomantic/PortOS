import { expect, it } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import loraTrainingRoutes from './loraTraining.js';

it.each([
  ['post', '/runs'],
  ['post', '/runs/example/resume'],
  ['post', '/runs/example/cancel'],
  ['post', '/runs/example/promote-checkpoint'],
  ['delete', '/runs/example'],
  ['get', '/runs/example/checkpoints'],
  ['get', '/runs/example/samples/step-1.png'],
])('returns the retirement response for %s %s', async (method, path) => {
  const app = express();
  app.use('/api/lora-training', loraTrainingRoutes);
  app.use(errorMiddleware);

  const response = await request(app)[method](`/api/lora-training${path}`);
  expect(response.status).toBe(410);
  expect(response.body.code).toBe('LORA_TRAINING_RETIRED');
});
