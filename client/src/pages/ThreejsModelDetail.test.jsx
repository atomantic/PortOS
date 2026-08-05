import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThreejsModelDetail from './ThreejsModelDetail';

vi.mock('../services/api', () => ({
  deleteThreejsModel: vi.fn(),
  generateThreejsModel: vi.fn(),
  getThreejsModel: vi.fn(),
  getThreejsModelSource: vi.fn(),
  threejsModelSourceUrl: (id) => `/api/threejs-models/${id}/source`,
}));

vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'vision-api', name: 'Vision API', type: 'api', enabled: true }],
    selectedProviderId: 'vision-api',
    selectedModel: '',
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

vi.mock('../components/ProviderModelSelector', () => ({
  default: () => <div>Vision API</div>,
}));

// The preview mounts a react-three-fiber Canvas, which cannot render in jsdom.
vi.mock('../components/threejsModels/ThreejsModelPreview', () => ({
  default: () => <div>Model preview</div>,
}));

import { getThreejsModel } from '../services/api';

const baseRecord = {
  id: 'threejs-example',
  name: 'Example Beacon',
  status: 'ready',
  providerId: 'vision-api',
  model: null,
  prompt: '',
  updatedAt: new Date().toISOString(),
  sourceImage: { filename: 'example-beacon.png', path: '/data/images/example-beacon.png' },
  spec: { name: 'Example Beacon', summary: 'A beacon.', detailInventory: [] },
  runs: [],
};

const renderDetail = () => render(
  <MemoryRouter initialEntries={['/media/threejs/threejs-example']}>
    <Routes>
      <Route path="/media/threejs/:id" element={<ThreejsModelDetail />} />
    </Routes>
  </MemoryRouter>,
);

describe('ThreejsModelDetail assembly coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the findings, tallies them, and states the gate is not a completeness proof', async () => {
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      coverage: {
        errorCount: 1,
        warningCount: 1,
        noteCount: 0,
        findings: [
          { code: 'fused-parts', severity: 'error', message: 'Two promised features collapsed onto "Hull".' },
          { code: 'orphan-geometry', severity: 'warning', count: 1, message: '1 geometry part is claimed by no entry.' },
        ],
      },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Assembly coverage')).toBeInTheDocument());
    expect(screen.getByText('Two promised features collapsed onto "Hull".')).toBeInTheDocument();
    expect(screen.getByText('1 geometry part is claimed by no entry.')).toBeInTheDocument();
    expect(screen.getByText('1 error · 1 warning · 0 note')).toBeInTheDocument();
    expect(screen.getByText(/never that the spec promised enough/)).toBeInTheDocument();
    // An error-severity finding is what the unsteered refinement will aim at.
    expect(screen.getByText(/will target the errors above/)).toBeInTheDocument();
  });

  it('counts from the findings it rendered rather than the stored tallies', async () => {
    // A record that reached this install without its counts (an older or newer
    // peer, a hand-repaired row) must not print "undefined error".
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      coverage: {
        findings: [{ code: 'folded-detail', severity: 'note', message: 'Minor relief rides on "Hull".' }],
      },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Assembly coverage')).toBeInTheDocument());
    expect(screen.getByText('0 error · 0 warning · 1 note')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    // Notes are not defects, so no refinement is suggested.
    expect(screen.queryByText(/will target the errors above/)).not.toBeInTheDocument();
  });

  it('says nothing went unbuilt on a clean pass, without claiming the spec was complete', async () => {
    getThreejsModel.mockResolvedValue({ ...baseRecord, coverage: { errorCount: 0, warningCount: 0, noteCount: 0, findings: [] } });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Assembly coverage')).toBeInTheDocument());
    expect(screen.getByText('Nothing promised was left unbuilt')).toBeInTheDocument();
    expect(screen.getByText(/never that the spec promised enough/)).toBeInTheDocument();
  });

  it('hides the section entirely for a record generated before the gate existed', async () => {
    getThreejsModel.mockResolvedValue({ ...baseRecord, coverage: null });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Example Beacon')).toBeInTheDocument());
    expect(screen.queryByText('Assembly coverage')).not.toBeInTheDocument();
  });
});

describe('ThreejsModelDetail cross-section gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the flatness finding and says an unsteered refinement will ask for depth', async () => {
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      flatness: {
        errorCount: 0,
        warningCount: 1,
        noteCount: 0,
        identityDetailCount: 3,
        flatIdentityDetailCount: 3,
        flatRatio: 1,
        slabPartIds: ['front', 'back', 'fin'],
        findings: [{
          code: 'flat-identity-parts',
          severity: 'warning',
          message: '3 of 3 identity-defining features are built only from flat parts (Front, Back, Fin).',
        }],
      },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Cross-section')).toBeInTheDocument());
    expect(screen.getByText('3 of 3 identity-defining features are built only from flat parts (Front, Back, Fin).')).toBeInTheDocument();
    expect(screen.getByText('0 error · 1 warning · 0 note')).toBeInTheDocument();
    expect(screen.getByText(/will also ask for real depth/)).toBeInTheDocument();
  });

  it('reports real depth on a clean pass and stays quiet about refinement', async () => {
    getThreejsModel.mockResolvedValue({ ...baseRecord, flatness: { warningCount: 0, findings: [] } });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Cross-section')).toBeInTheDocument());
    expect(screen.getByText('Identity parts carry real depth')).toBeInTheDocument();
    expect(screen.queryByText(/will also ask for real depth/)).not.toBeInTheDocument();
  });

  it('hides the section for a record generated before the gate existed', async () => {
    getThreejsModel.mockResolvedValue({ ...baseRecord, flatness: null });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Example Beacon')).toBeInTheDocument());
    expect(screen.queryByText('Cross-section')).not.toBeInTheDocument();
  });
});
