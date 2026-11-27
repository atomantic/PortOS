import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware, ServerError } from '../../lib/errorHandler.js';
import { request } from '../../lib/testHelper.js';
import * as twin from '../../services/digital-twin.js';
import * as taste from '../../services/taste-questionnaire.js';
import tasteRoutes from './taste.js';
import testRoutes from './tests.js';

vi.mock('../../services/socketIo.js', () => ({ emitToOperatorsOn: vi.fn() }));
vi.mock('../../services/digital-twin.js', () => ({
  runTests: vi.fn(),
  getPersonaById: vi.fn(),
  getTestHistory: vi.fn(),
  generateDynamicTests: vi.fn(),
  parseValuesAlignmentSuite: vi.fn(),
  runValuesAlignmentTests: vi.fn(),
  getValuesAlignmentHistory: vi.fn(),
  parseAdversarialSuite: vi.fn(),
  runAdversarialTests: vi.fn(),
  getAdversarialTestHistory: vi.fn(),
  parseMultiTurnSuite: vi.fn(),
  runMultiTurnTests: vi.fn(),
  getMultiTurnTestHistory: vi.fn(),
}));
vi.mock('../../services/taste-questionnaire.js', () => ({
  getTasteProfile: vi.fn(),
  getNextQuestion: vi.fn(),
  submitAnswer: vi.fn(),
  getSectionResponses: vi.fn(),
  generateSectionSummary: vi.fn(),
  generateOverallSummary: vi.fn(),
  generatePersonalizedTasteQuestion: vi.fn(),
  resetSection: vi.fn(),
}));

const base = '/api/digital-twin';
const app = express();
app.use(express.json());
app.use(base, testRoutes, tasteRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.resetAllMocks());

const picker = { providerId: 'example-provider', model: 'example-model' };
const pickerArgs = [picker.providerId, picker.model];
const personaId = '00000000-0000-4000-8000-000000000001';

describe('Digital Twin behavioral test routes', () => {
  const suites = [
    { path: '/values-tests', parse: twin.parseValuesAlignmentSuite, run: twin.runValuesAlignmentTests, history: twin.getValuesAlignmentHistory },
    { path: '/adversarial-tests', parse: twin.parseAdversarialSuite, run: twin.runAdversarialTests, history: twin.getAdversarialTestHistory },
    { path: '/multi-turn-tests', parse: twin.parseMultiTurnSuite, run: twin.runMultiTurnTests, history: twin.getMultiTurnTestHistory },
  ];

  it.each(suites)('GET $path returns the parsed suite', async ({ path, parse }) => {
    const scenarios = [{ id: 1, title: 'Example scenario' }];
    parse.mockResolvedValueOnce(scenarios);
    const response = await request(app).get(base + path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(scenarios);
  });

  const historyEndpoints = [
    { path: '/tests', history: twin.getTestHistory },
    ...suites,
  ];

  it.each(historyEndpoints)('GET $path/history passes the parsed limit and returns history', async ({ path, history }) => {
    const entries = [{ id: 'example-run' }];
    history.mockResolvedValueOnce(entries);
    const response = await request(app).get(base + path + '/history?limit=3');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(entries);
    expect(history).toHaveBeenCalledExactlyOnceWith(3);
  });

  it.each(historyEndpoints)('GET $path/history rejects an out-of-range limit before reading history', async ({ path, history }) => {
    const response = await request(app).get(base + path + '/history?limit=101');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(history).not.toHaveBeenCalled();
  });

  it.each(suites)('POST $path/run forwards selected tests and a verified persona', async ({ path, run }) => {
    const results = { runId: 'example-run', results: [] };
    twin.getPersonaById.mockResolvedValueOnce({ id: personaId });
    run.mockResolvedValueOnce(results);
    const response = await request(app).post(base + path + '/run').send({ ...picker, testIds: [2], personaId });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(results);
    expect(twin.getPersonaById).toHaveBeenCalledExactlyOnceWith(personaId);
    expect(run).toHaveBeenCalledExactlyOnceWith(...pickerArgs, [2], personaId);
    expect(run).toHaveBeenCalledAfter(twin.getPersonaById);
  });

  it.each(suites)('POST $path/run rejects invalid test IDs before any lookup or run', async ({ path, run }) => {
    const response = await request(app).post(base + path + '/run').send({ ...picker, testIds: [0], personaId });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(twin.getPersonaById).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ...suites.map(({ path, run }) => ({ path: path + '/run', run, input: picker })),
    { path: '/tests/run-multi', run: twin.runTests, input: { providers: [picker] } },
  ])('POST $path returns NOT_FOUND before running against an unknown persona', async ({ path, run, input }) => {
    twin.getPersonaById.mockResolvedValueOnce(null);
    const response = await request(app).post(base + path).send({ ...input, personaId });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(twin.getPersonaById).toHaveBeenCalledExactlyOnceWith(personaId);
    expect(run).not.toHaveBeenCalled();
  });

  it('generates tests with the requested provider and model', async () => {
    const generated = { tests: [{ id: 1, prompt: 'Example prompt' }] };
    twin.generateDynamicTests.mockResolvedValueOnce(generated);
    const response = await request(app).post(base + '/tests/generate').send(picker);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(generated);
    expect(twin.generateDynamicTests).toHaveBeenCalledExactlyOnceWith(...pickerArgs);
  });

  it('rejects generation without a model before calling the service', async () => {
    const response = await request(app).post(base + '/tests/generate').send({ providerId: picker.providerId });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(twin.generateDynamicTests).not.toHaveBeenCalled();
  });
});

describe('Digital Twin taste routes', () => {
  const section = 'music';
  const questionId = 'example-question';
  const answer = 'Example acoustic tracks.';
  const provenance = {
    source: 'personalized',
    generatedQuestion: 'What kind of music do you enjoy?',
    identityContextUsed: ['EXAMPLE.md'],
  };
  const sectionRoutes = [
    { method: 'get', suffix: '/next', service: taste.getNextQuestion },
    { method: 'get', suffix: '/responses', service: taste.getSectionResponses },
    { method: 'post', suffix: '/personalized-question', service: taste.generatePersonalizedTasteQuestion },
    { method: 'delete', suffix: '', service: taste.resetSection },
  ];

  it('returns the taste profile', async () => {
    const profile = { sections: { music: { status: 'pending' } } };
    taste.getTasteProfile.mockResolvedValueOnce(profile);
    const response = await request(app).get(base + '/taste');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(profile);
  });

  it.each([
    { suffix: '/next', service: taste.getNextQuestion, result: { questionId, section, text: 'Example question?' } },
    { suffix: '/responses', service: taste.getSectionResponses, result: [{ questionId, answer }] },
  ])('GET /taste/music$suffix returns data for the requested section', async ({ suffix, service, result }) => {
    service.mockResolvedValueOnce(result);
    const response = await request(app).get(base + '/taste/music' + suffix);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(service).toHaveBeenCalledExactlyOnceWith(section);
  });

  it.each(sectionRoutes)('$method /taste/unsupported$suffix rejects an unknown section before calling the service', async ({ method, suffix, service }) => {
    const response = await request(app)[method](base + '/taste/unsupported' + suffix);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR', error: 'Invalid taste section: unsupported' });
    expect(service).not.toHaveBeenCalled();
  });

  it('forwards personalized provenance with the answer', async () => {
    const saved = { section, questionId };
    taste.submitAnswer.mockResolvedValueOnce(saved);
    const response = await request(app).post(base + '/taste/answer').send({ section, questionId, answer, ...provenance });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(saved);
    expect(taste.submitAnswer).toHaveBeenCalledExactlyOnceWith(section, questionId, answer, provenance);
  });

  it.each([
    { scope: 'section', input: { ...picker, section }, service: taste.generateSectionSummary, args: [section, ...pickerArgs] },
    { scope: 'overall', input: picker, service: taste.generateOverallSummary, args: pickerArgs },
  ])('returns the $scope summary using the selected provider', async ({ input, service, args }) => {
    const summary = { summary: 'Example listening preferences.' };
    service.mockResolvedValueOnce(summary);
    const response = await request(app).post(base + '/taste/summary').send(input);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(summary);
    expect(service).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it('forwards the selected provider for a personalized question', async () => {
    const question = { question: { id: questionId, text: 'Example follow-up?' } };
    taste.generatePersonalizedTasteQuestion.mockResolvedValueOnce(question);
    const response = await request(app).post(base + '/taste/music/personalized-question').send(picker);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(question);
    expect(taste.generatePersonalizedTasteQuestion).toHaveBeenCalledExactlyOnceWith(section, ...pickerArgs);
  });

  it('returns 502 for a personalized-question provider failure', async () => {
    taste.generatePersonalizedTasteQuestion.mockRejectedValueOnce(
      new ServerError('Example provider unavailable.', { status: 502, code: 'AI_PROVIDER_ERROR' }),
    );
    const response = await request(app).post(base + '/taste/music/personalized-question').send(picker);
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('AI_PROVIDER_ERROR');
  });

  it.each([
    { path: '/taste/answer', input: { section, questionId, answer: '' }, services: [taste.submitAnswer] },
    { path: '/taste/summary', input: { ...picker, section: 'unsupported' }, services: [taste.generateSectionSummary, taste.generateOverallSummary] },
    { path: '/taste/music/personalized-question', input: { ...picker, model: '' }, services: [taste.generatePersonalizedTasteQuestion] },
  ])('POST $path rejects an invalid body before calling the service', async ({ path, input, services }) => {
    const response = await request(app).post(base + path).send(input);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    for (const service of services) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it('resets the requested section', async () => {
    const result = { section, status: 'reset' };
    taste.resetSection.mockResolvedValueOnce(result);
    const response = await request(app).delete(base + '/taste/music');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(taste.resetSection).toHaveBeenCalledExactlyOnceWith(section);
  });
});
