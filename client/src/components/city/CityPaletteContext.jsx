import { createContext, useContext } from 'react';
import { deriveCityPalette } from './cityConstants';

// CyberCity's "brand" surfaces (ground grid, particles, online buildings, the lead
// neon accent, the dark structural bases) track the active PortOS theme accent. The
// palette is derived once per theme (see deriveCityPalette) and handed down through
// this context instead of mutating a shared module-level singleton during render —
// the old approach fired a side-effect mid-render that was fragile under React
// StrictMode's double-invoke and concurrent rendering.
//
// IMPORTANT: react-three-fiber's <Canvas> runs its own reconciler, so React context
// does NOT cross that boundary automatically (the same reason `settings` is prop-
// threaded into every scene component). The palette is therefore provided TWICE: once
// by CyberCityInner for the DOM-side HUD/minimap, and again inside <Canvas> by
// CityScene for the 3D scene. Both providers share the same derived palette object.

// Default to the cyan-era baseline so a consumer rendered outside a provider (or in a
// test) still gets a valid, fully-formed palette rather than crashing on undefined.
const DEFAULT_CITY_PALETTE = deriveCityPalette(undefined);

const CityPaletteContext = createContext(DEFAULT_CITY_PALETTE);

export function CityPaletteProvider({ palette, children }) {
  return (
    <CityPaletteContext.Provider value={palette || DEFAULT_CITY_PALETTE}>
      {children}
    </CityPaletteContext.Provider>
  );
}

export function useCityPalette() {
  return useContext(CityPaletteContext);
}
