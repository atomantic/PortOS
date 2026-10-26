import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CatalogCard from './CatalogCard';
import { getCatalogType } from '../../lib/catalogTypes';
import { getCatalogIngredientDetails, setCatalogIngredientPortrait } from '../../services/apiCatalog';
import { getUniverse } from '../../services/apiUniverseBuilder';
import { generateImage } from '../../services/apiSystem';

vi.mock('../../services/apiCatalog', () => ({ getCatalogIngredientDetails: vi.fn(),
  setCatalogIngredientPortrait: vi.fn(async () => ({})), attachCatalogIngredientMedia: vi.fn(async () => ({})) }));
vi.mock('../../services/apiUniverseBuilder', () => ({ getUniverse: vi.fn() }));
vi.mock('../../services/apiSystem', () => ({ generateImage: vi.fn() }));
vi.mock('../../services/apiImageVideo', () => ({ previewImagePrompt: vi.fn(async body => ({
  sentPrompt: body.prompt, sentNegativePrompt: body.negativePrompt, promptAdditions: body.promptAdditions,
})) }));
vi.mock('../pipeline/MediaJobThumb', () => ({ default: ({ jobId }) => <span>Job {jobId}</span> }));

const record = { id: 'example-subject', name: 'Example subject', type: 'character', tags: ['brass'],
  payload: { physicalDescription: 'Detailed appearance. '.repeat(80), visualNotes: 'Blue coat' } };
const details = () => ({ ingredient: record, media: [], sharedIdentity: { writable: true },
  universeContext: { status: 'owned', owner: { refId: 'example-world' } } });
const showCard = (type = 'character') => render(<MemoryRouter><ul style={{ overflow: 'hidden', height: 180 }}>
  <CatalogCard ingredient={{ id: record.id, name: record.name, type, payload: { description: 'Bounded list snippet' } }}
    getType={getCatalogType} selected={false} onToggleSelect={vi.fn()} onArm={vi.fn()} />
</ul></MemoryRouter>);

beforeEach(() => {
  getCatalogIngredientDetails.mockReset().mockImplementation(async () => details());
  getUniverse.mockReset().mockResolvedValue({ id: 'example-world', name: 'Example world',
    influences: { embrace: ['analog photography', 'soft light'], avoid: ['cartoon'] } });
  generateImage.mockReset().mockResolvedValue({ filename: 'example-render.png' });
});

describe('catalog card image actions', () => {
  it.each(['character', 'place', 'object', 'idea'])('generates %s from the full record and explicit universe in one click', async type => {
    getCatalogIngredientDetails.mockImplementation(async () => ({ ...details(), ingredient: { ...record, type,
      payload: { ...record.payload, ...(type === 'place' ? { palette: 'Copper and teal', recurringDetails: 'Tall arches', weather: 'Fog' } : {}) } } }));
    showCard(type);
    expect(getCatalogIngredientDetails).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate image for Example subject' }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    const [body] = generateImage.mock.calls[0];
    expect(body.prompt).toContain(record.payload.physicalDescription.trim());
    expect(body.prompt).toContain('Blue coat');
    expect(body.prompt).toContain('brass');
    if (type === 'place') {
      expect(body.prompt).toContain('Copper and teal');
      expect(body.prompt).toContain('Tall arches');
      expect(body.prompt).toContain('Fog');
    }
    expect(body.prompt).toMatch(/^analog photography, soft light\./);
    expect(body.prompt).not.toContain('Bounded list snippet');
    expect(body.negativePrompt).toBe('cartoon');
    expect(body.promptAdditions.map(item => item.label)).toEqual(['Universe style', 'Style negatives']);
    expect(body.catalogIngredientId).toBe(record.id);
    expect(body.universeRun).toEqual({ universeId: 'example-world', universeName: 'Example world' });
    await waitFor(() => expect(setCatalogIngredientPortrait).toHaveBeenCalledWith(record.id, { mediaKey: 'example-render.png' }, { silent: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('portals the editable preview outside clipping cards and sends the exact edited input', async () => {
    const { container } = showCard();
    fireEvent.click(screen.getByRole('button', { name: 'Edit image prompt for Example subject' }));
    const dialog = screen.getByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    const input = within(dialog).getByLabelText('Prompt', { exact: true });
    await waitFor(() => expect(input.value).toContain('Blue coat'));
    expect(input.value).not.toContain('analog photography');
    const authored = '  My exact prompt\nwith all its details  ';
    fireEvent.change(input, { target: { value: authored } });
    expect(await within(dialog).findByRole('button', { name: '+ Universe style' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Render', exact: true }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    // Shared composition determines the final text, without truncation.
    expect(generateImage.mock.calls[0][0].prompt).toContain('My exact prompt\nwith all its details');
  });

  it('refuses to generate without the owning universe, then retries on the next click', async () => {
    getUniverse.mockRejectedValueOnce(new Error('Universe unavailable'));
    showCard();
    const button = screen.getByRole('button', { name: 'Generate image for Example subject' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(generateImage).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
  });

  it('preserves a deliberate prompt clear while universe context is loading', async () => {
    let resolveWorld;
    getUniverse.mockImplementation(() => new Promise(resolve => { resolveWorld = resolve; }));
    showCard();
    fireEvent.click(screen.getByRole('button', { name: 'Edit image prompt for Example subject' }));
    const input = screen.getByLabelText('Prompt', { exact: true });
    fireEvent.change(input, { target: { value: 'Temporary edit' } });
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(resolveWorld).toBeTypeOf('function'));
    resolveWorld({ id: 'example-world' });
    await waitFor(() => expect(screen.queryByLabelText('Loading universe style')).toBeNull());
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Render', exact: true })).toBeDisabled();
  });

  it('blocks read-only identities learned from the fresh record', async () => {
    getCatalogIngredientDetails.mockResolvedValue({ ...details(), sharedIdentity: { writable: false } });
    showCard();
    const button = screen.getByRole('button', { name: 'Generate image for Example subject' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(generateImage).not.toHaveBeenCalled();
    expect(getUniverse).not.toHaveBeenCalled();
  });

  it('deduplicates clicks during context loading and keeps the durable target on queued work', async () => {
    let resolveWorld;
    getUniverse.mockImplementation(() => new Promise(resolve => { resolveWorld = resolve; }));
    generateImage.mockResolvedValue({ jobId: 'example-job' });
    showCard();
    const button = screen.getByRole('button', { name: 'Generate image for Example subject' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(resolveWorld).toBeTypeOf('function'));
    resolveWorld({ id: 'example-world' });
    await screen.findByText('Job example-job');
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(generateImage.mock.calls[0][0].catalogIngredientId).toBe(record.id);
    expect(button).toBeDisabled();
  });
});
