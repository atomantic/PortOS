import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CreativeSetupPanel from './CreativeSetupPanel.jsx';
import { getUniverse } from '../../services/apiUniverseBuilder.js';
vi.mock('../../services/apiUniverseBuilder.js', () => ({
  listUniverseNames: vi.fn(async () => [{ id: 'u1', name: 'Example universe' }, { id: 'u2', name: 'Other universe' }]),
  getUniverse: vi.fn(),
}));
const CLAUDIA = { id: 'claudia-slopcore', label: 'Claudia slopcore', summary: 'Deadpan AI pop singer.', credit: 'Claudia by anabology', sourceUrl: 'https://example.com/claudia', characterName: 'Claudia', sheetPrompt: 'Character reference sheet', referenceImageId: null };
vi.mock('../../services/apiMusicVideo.js', () => ({
  listMusicVideoCharacterStyles: vi.fn(async () => [CLAUDIA]),
  setMusicVideoCharacterStyleReference: vi.fn(async (_id, imageId) => ({ ...CLAUDIA, referenceImageId: imageId })),
}));
vi.mock('./VideoCastLinks.jsx', () => ({
  VideoCastLinksDisclosure: ({ summary, defaultOpen }) => <p data-open={String(!!defaultOpen)}>{summary}</p>,
}));
vi.mock('../IngredientPicker.jsx', () => ({
  default: ({ open: isOpen, type, excludeIds, onSelect }) => (isOpen ? (
    <div role="dialog" aria-label={`Pick ${type}`} data-exclude={excludeIds.join(',')}>
      <button type="button" onClick={() => onSelect({ id: 'cat-plc-7', type: 'place', name: 'Night diner', thumbnailKey: 'diner.png', payload: { description: 'Chrome booths' } })}>Night diner</button>
    </div>
  ) : null),
}));
const project = { id: 'mv1', concept: {}, visualSpec: {} };
const open = (onSave = vi.fn(async () => {})) => {
  render(<MemoryRouter><CreativeSetupPanel project={project} onSave={onSave} onPendingChange={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Set up creative direction'));
  return onSave;
};
beforeEach(() => {
  vi.clearAllMocks();
  getUniverse.mockResolvedValue({ id: 'u1', name: 'Example universe', styleNotes: 'Ink silhouettes', characters: [{ id: 'c1', name: 'Example singer', physicalDescription: 'Silver coat' }], places: [], objects: [] });
});
describe('creative setup', () => {
  it('saves image-free canon and an authored prop, leaving the mood board to Look references', async () => {
    const onSave = open();
    await screen.findByText('Example universe');
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u1' } });
    await screen.findByText('Example singer');
    fireEvent.change(screen.getByLabelText('Select cast'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Role for Example singer'), { target: { value: 'band' } });
    fireEvent.change(screen.getByLabelText('Create for this video'), { target: { value: 'object' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Glass guitar' } });
    fireEvent.change(screen.getByLabelText('Appearance / description'), { target: { value: 'Transparent blue glass' } });
    fireEvent.click(screen.getByText('Add to production'));
    fireEvent.click(screen.getByText('Save creative setup'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      concept: { universeId: 'u1', subjects: [
        { kind: 'character', name: 'Example singer', role: 'band', description: 'Silver coat', canonId: 'c1' },
        { kind: 'object', name: 'Glass guitar', description: 'Transparent blue glass' },
      ] },
    });
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('visualSpec');
  });
  it('casts from the catalog and from universe canon with the catalog link, adding the catalog image as a look reference', async () => {
    getUniverse.mockResolvedValue({ id: 'u1', name: 'Example universe', characters: [{ id: 'c1', ingredientId: 'cat-chr-1', name: 'Example singer', physicalDescription: 'Silver coat' }], places: [], objects: [] });
    const onSave = open();
    await screen.findByText('Example universe');
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u1' } });
    await screen.findByText('Example singer');
    fireEvent.change(screen.getByLabelText('Select cast'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add places' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Pick place' })).getByText('Night diner'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add places' }));
    expect(screen.getByRole('dialog', { name: 'Pick place' })).toHaveAttribute('data-exclude', 'cat-chr-1,cat-plc-7');
    fireEvent.click(screen.getByText('Save creative setup'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved.concept.subjects).toMatchObject([
      { kind: 'character', name: 'Example singer', canonId: 'c1', ingredientId: 'cat-chr-1' },
      { kind: 'place', name: 'Night diner', description: 'Chrome booths', ingredientId: 'cat-plc-7' },
    ]);
    expect(saved.concept.subjects[1]).not.toHaveProperty('canonId');
    expect(saved.visualSpec.references).toEqual([expect.objectContaining({ imageId: 'diner.png', role: 'set', label: 'Night diner', condition: false })]);
  });

  it('links a catalog subject to its record and lets the director keep a new one in this video only', async () => {
    const onSave = vi.fn(async () => {});
    const cast = { ...project, concept: { subjects: [
      { id: 'mvc-1', kind: 'character', name: 'Example singer', ingredientId: 'cat-chr-1' },
      { id: 'mvc-2', kind: 'object', name: 'Glass guitar' },
    ] } };
    render(<MemoryRouter><CreativeSetupPanel project={cast} onSave={onSave} onPendingChange={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByRole('link', { name: 'Open in catalog' })).toHaveAttribute('href', '/casting/cat-chr-1');
    fireEvent.click(screen.getByLabelText("Don't save to Objects"));
    fireEvent.click(screen.getByText('Save creative setup'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].concept.subjects[1]).toEqual(expect.objectContaining({ id: 'mvc-2', localOnly: true }));
  });

  it('discards an unsaved cast when the director cancels setup', async () => {
    const onSave = open();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved singer' } });
    fireEvent.click(screen.getByText('Add to production'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText(/Unsaved singer/)).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Set up creative direction'));
    await act(async () => {});
    expect(screen.queryByText(/Unsaved singer/)).toBeNull();
  });

  it('cannot save while a newly chosen universe is still loading and sends a null id on deselection', async () => {
    let resolveNext;
    getUniverse.mockResolvedValueOnce({ id: 'u1', name: 'Example universe', styleNotes: 'Old style', characters: [] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
    const onSave = open();
    await screen.findByText('Example universe');
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u1' } });
    await waitFor(() => expect(screen.getByText('Save creative setup').disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u2' } });
    expect(screen.getByText('Save creative setup').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save creative setup'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ concept: expect.objectContaining({ universeId: null }) })));
    await act(async () => { resolveNext({ id: 'u2', name: 'Other universe', styleNotes: 'Wrong style' }); });
  });

  it('ignores stale universe responses and retains the draft when saving fails', async () => {
    let resolveOld;
    getUniverse.mockImplementation((id) => id === 'u1' ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ id: 'u2', name: 'Other universe', characters: [] }));
    open(vi.fn(async () => { throw new Error('Save rejected'); }));
    await screen.findByText('Example universe');
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u1' } });
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u2' } });
    await waitFor(() => expect(screen.queryByText('Loading canon…')).toBeNull());
    resolveOld({ id: 'u1', characters: [{ id: 'c1', name: 'Stale singer' }] });
    fireEvent.click(screen.getByText('Save creative setup'));
    await screen.findByText('Save rejected');
    expect(screen.queryByText('Stale singer')).toBeNull();
    expect(screen.getByLabelText('Universe').value).toBe('u2');
  });
});

describe('tools / policy conflict', () => {
  const render_ = (extra, onSave = vi.fn(async () => {})) => {
    render(<MemoryRouter><CreativeSetupPanel project={{ ...project, ...extra }} onSave={onSave} onPendingChange={vi.fn()} /></MemoryRouter>);
    return onSave;
  };
  const noVideo = { automation: { tools: ['image:codex', 'code:render'] } };

  it('warns when no video tool is selected but footage is still planned, and only a deliberate replan saves the new policy', async () => {
    const onSave = render_({ ...noVideo, productionPolicy: { strategy: 'legacy', maxGeneratedVideoPercent: 100 } });
    expect(screen.getByRole('status')).toHaveTextContent('No video tool is selected');
    expect(screen.getByText(/stay as saved until you replan/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Replan as code-first, no generated video'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } }));
  });

  it('keeps a failed replan visible and re-enables the action', async () => {
    render_({ ...noVideo }, vi.fn(async () => { throw new Error('Save rejected'); }));
    fireEvent.click(screen.getByText('Replan as code-first, no generated video'));
    await screen.findByText('Save rejected');
    expect(screen.getByText('Replan as code-first, no generated video')).not.toBeDisabled();
  });

  it.each([
    ['a video tool is selected', { automation: { tools: ['image:codex', 'video:fal'] } }],
    ['the policy already allows no generated video', { ...noVideo, productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } }],
    ['the brief names no tools', {}],
  ])('shows nothing when %s', (_label, extra) => {
    render_(extra);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('loads a character style into the concept and picks its character sheet from the look references', async () => {
    const { setMusicVideoCharacterStyleReference } = await import('../../services/apiMusicVideo.js');
    const onSave = vi.fn(async () => {});
    render(<MemoryRouter><CreativeSetupPanel project={{ ...project, visualSpec: { references: [{ imageId: 'sheet.png' }] } }} onSave={onSave} onPendingChange={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByText('Set up creative direction'));
    await screen.findByText('Claudia slopcore');
    fireEvent.change(screen.getByLabelText('Character style'), { target: { value: 'claudia-slopcore' } });
    expect(screen.getByText('Claudia joins the cast as protagonist when you save.')).toBeTruthy();
    expect(screen.getByText('Render a character sheet').getAttribute('href')).toBe('/media/image?prompt=Character+reference+sheet');
    fireEvent.change(screen.getByLabelText('Use a look reference as the sheet'), { target: { value: 'sheet.png' } });
    await screen.findByAltText('Claudia character sheet');
    expect(setMusicVideoCharacterStyleReference).toHaveBeenCalledWith('claudia-slopcore', 'sheet.png', { silent: true });
    fireEvent.click(screen.getByText('Save creative setup'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].concept).toMatchObject({ characterStyleId: 'claudia-slopcore' });
  });
});

describe('creative setup already made', () => {
  it('offers Edit, not Set up, once the cast exists', () => {
    const made = { id: 'mv2', concept: { subjects: [{ id: 's1', kind: 'character', name: 'Example lead', role: 'protagonist' }] }, visualSpec: {} };
    render(<MemoryRouter><CreativeSetupPanel project={made} onSave={vi.fn()} onPendingChange={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Edit creative direction' })).toBeTruthy();
    expect(screen.queryByText('Set up creative direction')).toBeNull();
  });
});
