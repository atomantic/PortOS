import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThreejsModelDetail from './ThreejsModelDetail';

vi.mock('../services/api', () => ({
  deleteThreejsModel: vi.fn(),
  generateThreejsModel: vi.fn(),
  getThreejsModel: vi.fn(),
  getThreejsModelSource: vi.fn(),
  listThreejsModelFamilies: vi.fn(),
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

import { generateThreejsModel, getThreejsModel, listThreejsModelFamilies } from '../services/api';

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

const FAMILY_OPTIONS = [
  { id: 'general', label: 'General (no checklist)', description: 'One general-purpose prompt.' },
  { id: 'vehicle', label: 'Vehicle', description: 'Cars, ships, aircraft.' },
];

const resetMocks = () => {
  vi.clearAllMocks();
  listThreejsModelFamilies.mockResolvedValue(FAMILY_OPTIONS);
};

const renderDetail = () => render(
  <MemoryRouter initialEntries={['/media/threejs/threejs-example']}>
    <Routes>
      <Route path="/media/threejs/:id" element={<ThreejsModelDetail />} />
    </Routes>
  </MemoryRouter>,
);

describe('ThreejsModelDetail assembly coverage', () => {
  beforeEach(resetMocks);

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
  beforeEach(resetMocks);

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

describe('ThreejsModelDetail cross-part penetration gate', () => {
  beforeEach(resetMocks);

  it('lists the buried-part finding and says an unsteered refinement will target it', async () => {
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      penetration: {
        errorCount: 1,
        warningCount: 0,
        noteCount: 0,
        evaluatedPartCount: 4,
        comparedPairCount: 3,
        undecidedPairCount: 0,
        findings: [{
          code: 'buried-part',
          severity: 'error',
          partIds: ['lens', 'body'],
          message: '1 part(s) are entirely inside another part they are not attached to or parented under ("Lens" inside "Body").',
        }],
      },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Cross-part penetration')).toBeInTheDocument());
    expect(screen.getByText('1 part(s) are entirely inside another part they are not attached to or parented under ("Lens" inside "Body").')).toBeInTheDocument();
    expect(screen.getByText('1 error · 0 warning · 0 note')).toBeInTheDocument();
    expect(screen.getByText(/each part to get its own volume/)).toBeInTheDocument();
  });

  it('does not promise a refinement for an undecided note alone', async () => {
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      penetration: {
        errorCount: 0,
        warningCount: 0,
        noteCount: 1,
        findings: [{
          code: 'undecided-contact',
          severity: 'note',
          partIds: ['peg', 'body'],
          message: '1 unrelated part pair(s) overlap partially ("Peg" and "Body" (22%)).',
        }],
      },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Cross-part penetration')).toBeInTheDocument());
    expect(screen.queryByText(/each part to get its own volume/)).not.toBeInTheDocument();
  });

  it('hides the section for a record generated before the gate existed', async () => {
    getThreejsModel.mockResolvedValue({ ...baseRecord, penetration: null });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Example Beacon')).toBeInTheDocument());
    expect(screen.queryByText('Cross-part penetration')).not.toBeInTheDocument();
  });
});

describe('ThreejsModelDetail subject family', () => {
  beforeEach(resetMocks);

  const withFamily = (family) => ({
    ...baseRecord,
    family: 'vehicle',
    coverage: { errorCount: 0, warningCount: 0, noteCount: 0, findings: [], family },
  });

  it('marks each expected component resolved or not and names the orbit views to check', async () => {
    getThreejsModel.mockResolvedValue(withFamily({
      id: 'vehicle',
      label: 'Vehicle',
      components: ['Chassis or hull', 'Glazing', 'Lights'],
      missing: ['Lights'],
      reviewAxes: ['wheelbase and track proportion'],
      orbitViews: ['side profile', 'top-down'],
    }));
    renderDetail();

    await waitFor(() => expect(screen.getByText('Vehicle checklist')).toBeInTheDocument());
    expect(screen.getByText('1 of 3 unaccounted for')).toBeInTheDocument();
    expect(screen.getByText('Lights')).toBeInTheDocument();
    expect(screen.getByText(/side profile, top-down/)).toBeInTheDocument();
    expect(screen.getByText(/wheelbase and track proportion/)).toBeInTheDocument();
    // The floor-not-ceiling framing has to reach the user too — otherwise the
    // checklist reads as the whole job rather than the minimum.
    expect(screen.getByText(/floor, not a ceiling/)).toBeInTheDocument();
  });

  it('reports a fully accounted-for checklist without claiming completeness', async () => {
    getThreejsModel.mockResolvedValue(withFamily({
      id: 'vehicle', label: 'Vehicle', components: ['Chassis or hull'], missing: [], reviewAxes: [], orbitViews: [],
    }));
    renderDetail();

    await waitFor(() => expect(screen.getByText('Vehicle checklist')).toBeInTheDocument());
    expect(screen.getByText('Every expected component is accounted for')).toBeInTheDocument();
  });

  it('hides the checklist for a record generated with no family', async () => {
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      coverage: { errorCount: 0, warningCount: 0, noteCount: 0, findings: [], family: null },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Assembly coverage')).toBeInTheDocument());
    expect(screen.queryByText(/checklist$/)).not.toBeInTheDocument();
    // With no family the coverage footer keeps its original honest caveat.
    expect(screen.getByText(/never that the spec promised enough/)).toBeInTheDocument();
  });

  it('seeds the picker from the record and sends the family with a refinement', async () => {
    getThreejsModel.mockResolvedValue({ ...baseRecord, family: 'vehicle' });
    generateThreejsModel.mockResolvedValue({ ...baseRecord, family: 'general', status: 'generating' });
    renderDetail();

    // The picker renders as soon as the taxonomy lands and is seeded from the
    // record a tick later, so the two fetches can resolve in either order.
    const picker = await screen.findByLabelText('Subject family');
    await waitFor(() => expect(picker).toHaveValue('vehicle'));

    // Switching back to General must turn the checklist OFF for the next pass
    // rather than silently re-applying the record's stored family.
    fireEvent.change(picker, { target: { value: 'general' } });
    fireEvent.click(screen.getByRole('button', { name: /Refine model/ }));

    await waitFor(() => expect(generateThreejsModel).toHaveBeenCalledWith(
      'threejs-example',
      expect.objectContaining({ family: 'general' }),
      { silent: true },
    ));
  });

  it('falls back to General for a family this build no longer ships', async () => {
    // A record written by a build with a larger taxonomy (a downgrade, or a
    // restored backup). Left as-is, the select would carry a value it has no
    // option for: what is on screen stops matching the state behind it, and
    // picking the option it appears to show fires no change event at all.
    getThreejsModel.mockResolvedValue({ ...baseRecord, family: 'kaiju-mecha-hybrid' });
    generateThreejsModel.mockResolvedValue({ ...baseRecord, status: 'generating' });
    renderDetail();

    const picker = await screen.findByLabelText('Subject family');
    await waitFor(() => expect(picker).toHaveValue('general'));
    // The header must not name a different family than the picker is showing.
    expect(screen.queryByText(/kaiju-mecha-hybrid/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Refine model/ }));
    await waitFor(() => expect(generateThreejsModel).toHaveBeenCalledWith(
      'threejs-example',
      expect.objectContaining({ family: 'general' }),
      { silent: true },
    ));
  });
});

describe('ThreejsModelDetail rig readiness', () => {
  beforeEach(resetMocks);

  it('reports an articulation-ready character with its joint and pivot counts', async () => {
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      rig: {
        articulationReady: true,
        reasons: [],
        jointCount: 6,
        socketCount: 5,
        attachmentCount: 1,
        rootJointId: 'rootJoint',
        subjectType: 'character',
      },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Rig readiness')).toBeInTheDocument());
    expect(screen.getByText('Articulation-ready')).toBeInTheDocument();
    expect(screen.getByText('6 joints · 5 pivot sockets · 1 declared attachment')).toBeInTheDocument();
    // The claim has to stay bounded: readiness is not a rigged mesh.
    expect(screen.getByText(/never a skeleton/)).toBeInTheDocument();
  });

  it('reports a static assembly with the reasons rather than a silent pass', async () => {
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      rig: {
        articulationReady: false,
        reasons: ['The spec declares no articulation graph, so this character is a static assembly.'],
        jointCount: 0,
        socketCount: 0,
        attachmentCount: 0,
        rootJointId: null,
        subjectType: 'character',
      },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Rig readiness')).toBeInTheDocument());
    expect(screen.getByText('Static assembly')).toBeInTheDocument();
    expect(screen.getByText('0 joints · 0 pivot sockets · 0 declared attachments')).toBeInTheDocument();
    expect(screen.getByText(/declares no articulation graph/)).toBeInTheDocument();
    expect(screen.queryByText('Articulation-ready')).not.toBeInTheDocument();
  });

  // A record from before the report shipped was never evaluated, which is not
  // the same as having passed — it degrades to static and says so.
  it('degrades a record with no report to an unevaluated static assembly', async () => {
    getThreejsModel.mockResolvedValue({ ...baseRecord, rig: undefined });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Rig readiness')).toBeInTheDocument());
    expect(screen.getByText('Static assembly')).toBeInTheDocument();
    expect(screen.getByText(/generated before rig readiness was reported/)).toBeInTheDocument();
  });

  it('omits the panel entirely until there is a generated scene', async () => {
    getThreejsModel.mockResolvedValue({ ...baseRecord, spec: null, rig: undefined });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Example Beacon')).toBeInTheDocument());
    expect(screen.queryByText('Rig readiness')).not.toBeInTheDocument();
  });
});

describe('ThreejsModelDetail rig readiness fallbacks', () => {
  beforeEach(resetMocks);

  // A report that reached this install without its counts must not print
  // "undefined joints" — it falls back to what the spec itself declares.
  it('counts from the spec when the stored report arrived without tallies', async () => {
    getThreejsModel.mockResolvedValue({
      ...baseRecord,
      spec: {
        ...baseRecord.spec,
        articulation: {
          joints: [
            { id: 'rootJoint', partId: 'torso', parentJointId: null, pivotSocket: null },
            { id: 'armJoint', partId: 'arm', parentJointId: 'rootJoint', pivotSocket: 'shoulder' },
          ],
          attachmentPartIds: ['pack'],
        },
      },
      rig: { articulationReady: true, reasons: [] },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Rig readiness')).toBeInTheDocument());
    expect(screen.getByText('2 joints · 1 pivot socket · 1 declared attachment')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });
});
