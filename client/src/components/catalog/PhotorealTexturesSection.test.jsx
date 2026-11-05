import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PhotorealTexturesSection from './PhotorealTexturesSection';
import { getCatalogPhotorealTextures, installCatalogPhotorealTexture, saveCatalogPhotorealLook, searchCatalogPhotorealTextures } from '../../services/apiCatalog';

vi.mock('../../services/apiCatalog', () => ({
  getCatalogPhotorealTextures: vi.fn(), installCatalogPhotorealTexture: vi.fn(), saveCatalogPhotorealLook: vi.fn(), searchCatalogPhotorealTextures: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const record = { id: 'plc-example' };
const look = {
  materials: [
    { id: 'floor', zone: 'rink', preset: 'wood-floor', color: '#aa7744' },
    { id: 'ball', part: 'mirror-ball', preset: 'mirror', color: '#ffffff' },
    { id: 'walls', zone: 'walls', preset: 'painted-wall', color: '#222222' },
  ],
  lights: [], atmosphere: {}, textures: { 'painted-wall': 'old_plaster' },
};

beforeEach(() => {
  vi.resetAllMocks();
  getCatalogPhotorealTextures.mockResolvedValue({ installed: [{ id: 'old_plaster', name: 'Old Plaster', thumbnail: 'https://example.com/p.png' }] });
});

describe('PhotorealTexturesSection', () => {
  it('downloads a texture only when tapped and saves it on the look, keeping the other picks', async () => {
    searchCatalogPhotorealTextures.mockResolvedValue({ results: [{ id: 'oak_planks', name: 'Oak Planks', thumbnail: 'https://example.com/o.png', installed: false }] });
    installCatalogPhotorealTexture.mockResolvedValue({ id: 'oak_planks', name: 'Oak Planks', sizeM: 2.4 });
    saveCatalogPhotorealLook.mockResolvedValue({ id: 'plc-example' });
    const onSaved = vi.fn();
    render(<PhotorealTexturesSection record={record} look={look} onSaved={onSaved} />);

    // Mirror stays procedural; wall shows its installed pick.
    expect(await screen.findByText(/Old Plaster/)).toBeInTheDocument();
    expect(screen.queryByText(/^mirror/)).not.toBeInTheDocument();
    expect(searchCatalogPhotorealTextures).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Choose photo/ }));
    await waitFor(() => expect(searchCatalogPhotorealTextures).toHaveBeenCalledWith('wood-floor', '', { silent: true }));
    expect(installCatalogPhotorealTexture).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /Oak Planks/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(installCatalogPhotorealTexture).toHaveBeenCalledWith('oak_planks', { silent: true });
    expect(saveCatalogPhotorealLook).toHaveBeenCalledWith('plc-example',
      expect.objectContaining({ textures: { 'painted-wall': 'old_plaster', 'wood-floor': 'oak_planks' } }), { silent: true });
  });

  // Catches a second texture save starting from the same stale snapshot.
  it('returns a material to the procedural surface, one save at a time', async () => {
    let finish;
    saveCatalogPhotorealLook.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<PhotorealTexturesSection record={record} look={{ ...look, textures: { ...look.textures, 'wood-floor': 'old_plaster' } }} />);
    const [first, second] = await screen.findAllByRole('button', { name: 'Procedural' });
    fireEvent.click(first);
    await waitFor(() => expect(second).toBeDisabled());
    fireEvent.click(second);
    expect(saveCatalogPhotorealLook).toHaveBeenCalledTimes(1);
    expect(saveCatalogPhotorealLook).toHaveBeenCalledWith('plc-example', expect.objectContaining({ textures: { 'painted-wall': 'old_plaster' } }), { silent: true });
    await act(async () => finish({ id: 'plc-example' }));
    await waitFor(() => expect(second).toBeEnabled());
  });
});
