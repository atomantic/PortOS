import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { request } from '../../lib/testHelper.js';
import * as twin from '../../services/digital-twin.js';
import analysisRoutes from './analysis.js';
import enrichmentRoutes from './enrichment.js';

vi.mock('../../services/digital-twin.js', () => ({
  validateCompleteness: vi.fn(),
  detectContradictions: vi.fn(),
  analyzeWritingSamples: vi.fn(),
  compareSpokenWrittenStyle: vi.fn(),
  analyzeIdentityImage: vi.fn(),
  saveIdentityImageDocument: vi.fn(),
  getTraits: vi.fn(),
  analyzeTraits: vi.fn(),
  updateTraits: vi.fn(),
  getConfidence: vi.fn(),
  calculateConfidence: vi.fn(),
  getGapRecommendations: vi.fn(),
  analyzeAssessment: vi.fn(),
  getEnrichmentProgress: vi.fn(),
  generateEnrichmentQuestion: vi.fn(),
  processEnrichmentAnswer: vi.fn(),
  analyzeEnrichmentList: vi.fn(),
  saveEnrichmentListDocument: vi.fn(),
  getEnrichmentListItems: vi.fn(),
}));

const base = '/api/digital-twin';
const app = express();
app.use(express.json());
app.use(base, analysisRoutes, enrichmentRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.resetAllMocks());

const picker = { providerId: 'example-provider', model: 'example-model' };
const pickerArgs = [picker.providerId, picker.model];
const samples = ['Example writing sample.'];
const spokenStyle = { spokenTranscript: 'Example transcript. '.repeat(6), writtenSamples: samples, ...picker };
const imageInput = { imageDataUrl: 'data:image/png;base64,ZXhhbXBsZQ==', ...picker };
const appearance = { content: 'Example appearance description.', title: 'Example appearance' };
const traits = { bigFive: { O: 0.6 } };
const assessment = 'Example assessment with fictional results about communication style.';
const category = 'favorite_books';
const items = [{ title: 'Example book', note: 'Example note' }];
const listContent = 'Example reading preferences.';
const overrides = { providerOverride: picker.providerId, modelOverride: picker.model };
const answer = {
  questionId: '00000000-0000-4000-8000-000000000001',
  category,
  question: 'What kind of books do you enjoy?',
  answer: 'Example adventure novels.',
  ...overrides,
};

describe('Digital Twin analysis and enrichment routes', () => {
  it.each([
    { path: '/validate/completeness', service: twin.validateCompleteness, result: { complete: false }, body: { complete: false }, args: [] },
    { path: '/traits', service: twin.getTraits, result: traits, body: { traits }, args: [] },
    { path: '/confidence', service: twin.getConfidence, result: null, body: { confidence: null }, args: [] },
    { path: '/gaps', service: twin.getGapRecommendations, result: [], body: { gaps: [] }, args: [] },
    { path: '/enrich/progress', service: twin.getEnrichmentProgress, result: { completedCategories: [category] }, body: { completedCategories: [category] }, args: [] },
    { path: '/enrich/list-items/favorite_books', service: twin.getEnrichmentListItems, result: items, body: items, args: [category] },
  ])('GET $path returns the service data', async ({ path, service, result, body, args }) => {
    service.mockResolvedValueOnce(result);
    const response = await request(app).get(base + path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
    expect(service).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it('rejects an unsupported enrichment list category before reading it', async () => {
    const response = await request(app).get(base + '/enrich/list-items/unsupported');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(twin.getEnrichmentListItems).not.toHaveBeenCalled();
  });

  const mutations = [
    {
      method: 'post', path: '/validate/contradictions', service: twin.detectContradictions,
      input: picker, invalid: { ...picker, model: '' }, args: pickerArgs,
    },
    {
      method: 'post', path: '/analyze-writing', service: twin.analyzeWritingSamples,
      input: { samples, ...picker }, invalid: { samples: ['Too short'], ...picker }, args: [samples, ...pickerArgs],
    },
    {
      method: 'post', path: '/style/spoken-written', service: twin.compareSpokenWrittenStyle,
      input: spokenStyle, invalid: { ...spokenStyle, spokenTranscript: 'Too short' }, args: [spokenStyle],
    },
    {
      method: 'post', path: '/identity/image', service: twin.analyzeIdentityImage,
      input: imageInput, invalid: { ...imageInput, imageDataUrl: 'https://example.com/image.png' }, args: [imageInput],
    },
    {
      method: 'post', path: '/identity/image/save', service: twin.saveIdentityImageDocument,
      input: appearance, invalid: { ...appearance, content: '' }, args: [appearance],
    },
    {
      method: 'post', path: '/traits/analyze', service: twin.analyzeTraits,
      input: picker, invalid: { ...picker, forceReanalyze: 'yes' }, args: [...pickerArgs, false],
    },
    {
      method: 'put', path: '/traits', service: twin.updateTraits,
      input: traits, invalid: { bigFive: { O: 2 } }, args: [traits],
      wrap: 'traits',
    },
    {
      method: 'post', path: '/confidence/calculate', service: twin.calculateConfidence,
      input: picker, invalid: { ...picker, providerId: 1 }, args: pickerArgs,
    },
    {
      method: 'post', path: '/interview/analyze', service: twin.analyzeAssessment,
      input: { content: assessment, ...picker }, invalid: { content: 'Too short', ...picker }, args: [assessment, ...pickerArgs],
    },
    {
      method: 'post', path: '/enrich/question', service: twin.generateEnrichmentQuestion,
      input: { category, ...overrides, skipIndices: [1, 3], structuredOnly: true },
      invalid: { category, skipIndices: [1.5] },
      args: [category, ...pickerArgs, [1, 3], { structuredOnly: true }],
    },
    {
      method: 'post', path: '/enrich/answer', service: twin.processEnrichmentAnswer,
      input: answer, invalid: { ...answer, questionType: 'scale', scaleValue: 4 },
      args: [{ ...answer, questionType: 'text' }],
    },
    {
      method: 'post', path: '/enrich/analyze-list', service: twin.analyzeEnrichmentList,
      input: { category, items, ...picker }, invalid: { category, items: [], ...picker },
      args: [category, items, ...pickerArgs],
    },
    {
      method: 'post', path: '/enrich/save-list', service: twin.saveEnrichmentListDocument,
      input: { category, content: listContent, items },
      invalid: { category, content: listContent, items: [{ title: '' }] }, args: [category, listContent, items],
    },
  ];

  it.each(mutations)('$method $path forwards parsed inputs and returns the result', async ({ method, path, service, input, args, wrap }) => {
    const result = wrap === 'traits' ? traits : { result: 'example' };
    service.mockResolvedValueOnce(result);
    const response = await request(app)[method](base + path).send(input);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(wrap ? { [wrap]: result } : result);
    expect(service).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it.each(mutations)('$method $path rejects invalid inputs before calling the service', async ({ method, path, service, invalid }) => {
    const response = await request(app)[method](base + path).send(invalid);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    { path: '/identity/image/save', service: twin.saveIdentityImageDocument, input: appearance, code: 'VALIDATION_ERROR' },
    { path: '/interview/analyze', service: twin.analyzeAssessment, input: { content: assessment, ...picker }, code: 'ANALYSIS_ERROR' },
  ])('POST $path maps a service error result to $code', async ({ path, service, input, code }) => {
    service.mockResolvedValueOnce({ error: 'Example service rejection.' });
    const response = await request(app).post(base + path).send(input);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code, error: 'Example service rejection.' });
  });
});
