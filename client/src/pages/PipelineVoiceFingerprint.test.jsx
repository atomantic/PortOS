import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PipelineVoiceFingerprint from './PipelineVoiceFingerprint';

const getPipelineSeries = vi.fn();
const getVoiceFingerprint = vi.fn();

vi.mock('../services/api', () => ({
  getPipelineSeries: (...a) => getPipelineSeries(...a),
  getVoiceFingerprint: (...a) => getVoiceFingerprint(...a),
}));

vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

function renderAt(seriesId = 'ser-1') {
  return render(
    <MemoryRouter initialEntries={[`/pipeline/series/${seriesId}/voice-fingerprint`]}>
      <Routes>
        <Route path="/pipeline/series/:seriesId/voice-fingerprint" element={<PipelineVoiceFingerprint />} />
        <Route path="/pipeline" element={<div>Pipeline index</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const MATRIX_PAYLOAD = {
  seriesId: 'ser-1',
  config: { sigmaThreshold: 1.5, minIssues: 4, vocabularyWells: '' },
  wells: [],
  columns: [
    { key: 'sentenceLenMean', label: 'sentence-length mean', unit: ' words', higher: 'longer', lower: 'shorter', isWell: false },
    { key: 'dialogueRatio', label: 'dialogue ratio', unit: '%', higher: 'more dialogue', lower: 'more narration', isWell: false },
  ],
  gatedOff: false,
  issueCount: 5,
  threshold: 1.5,
  matrix: {
    metricKeys: ['sentenceLenMean', 'dialogueRatio'],
    issues: [
      { issue: 1, words: 100, sentences: 8, metrics: { sentenceLenMean: 12.5, dialogueRatio: 20 } },
      { issue: 5, words: 40, sentences: 8, metrics: { sentenceLenMean: 4, dialogueRatio: 0 } },
    ],
  },
  series: { sentenceLenMean: { mean: 10.5, std: 3 }, dialogueRatio: { mean: 15, std: 8 } },
  outliers: [
    { issue: 5, metricKey: 'sentenceLenMean', label: 'sentence-length mean', value: 4, mean: 10.5, std: 3, z: -2.1, direction: 'low', unit: ' words' },
  ],
};

beforeEach(() => {
  getPipelineSeries.mockReset();
  getVoiceFingerprint.mockReset();
  getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: 'Test Series' });
});

describe('PipelineVoiceFingerprint', () => {
  it('renders the issues×metrics matrix with an outlier cell highlighted', async () => {
    getVoiceFingerprint.mockResolvedValue(MATRIX_PAYLOAD);
    renderAt();
    await waitFor(() => expect(screen.getByText('Voice Fingerprint')).toBeInTheDocument());
    // Both issue rows render.
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#5')).toBeInTheDocument();
    // Column headers render.
    expect(screen.getAllByText('sentence-length mean').length).toBeGreaterThan(0);
    // The outlier cell (issue 5, sentenceLenMean = 4) is highlighted amber.
    const outlierCell = screen.getByText('4 words');
    expect(outlierCell.className).toContain('port-warning');
  });

  it('shows the gated-off notice below minIssues but still renders the matrix', async () => {
    getVoiceFingerprint.mockResolvedValue({
      ...MATRIX_PAYLOAD,
      gatedOff: true,
      issueCount: 2,
      outliers: [],
      matrix: { metricKeys: ['sentenceLenMean'], issues: [{ issue: 1, words: 5, sentences: 1, metrics: { sentenceLenMean: 5 } }, { issue: 2, words: 4, sentences: 1, metrics: { sentenceLenMean: 4 } }] },
    });
    renderAt();
    await waitFor(() => expect(screen.getByText(/Drift detection is off/)).toBeInTheDocument());
    expect(screen.getByText('#1')).toBeInTheDocument();
  });

  it('renders an empty state when nothing is drafted', async () => {
    getVoiceFingerprint.mockResolvedValue({
      ...MATRIX_PAYLOAD,
      gatedOff: false,
      issueCount: 0,
      outliers: [],
      matrix: { metricKeys: [], issues: [] },
    });
    renderAt();
    await waitFor(() => expect(screen.getByText(/Nothing is drafted yet/)).toBeInTheDocument());
  });
});
