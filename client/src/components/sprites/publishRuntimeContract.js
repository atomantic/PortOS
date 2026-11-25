export function contractSeedOf(definitions, contract) {
  return Object.fromEntries(definitions.map((definition) => {
    const value = contract?.[definition.contractFrameCountField];
    return [definition.contractFrameCountField, value == null ? '' : String(value)];
  }));
}

export function trackFrameCountOf(geometry, definition) {
  const direct = geometry?.[definition.contractFrameCountField];
  if (Number.isInteger(direct)) return direct;
  const spanCount = geometry?.tracks?.[definition.id]?.count;
  return Number.isInteger(spanCount) ? spanCount : null;
}

export function readRuntimeContract(trackDefinitions, { trackCounts, cell, columns }, seed) {
  const trackInputs = trackDefinitions.map((definition) => {
    const raw = (trackCounts[definition.contractFrameCountField] || '').trim();
    return {
      definition,
      raw,
      value: raw === '' ? null : Number(raw),
    };
  });
  const cellRaw = cell.trim();
  const colsRaw = columns.trim();
  const cellNum = cellRaw === '' ? null : Number(cellRaw);
  const colsNum = colsRaw === '' ? null : Number(colsRaw);
  const primaryInput = trackInputs.find(({ definition }) => definition.standaloneContract);
  const hasContract = primaryInput?.value != null;

  // Whether the contract INPUTS were edited (vs. merely seeded from the saved
  // binding). Used both for the dirty check and to scope the no-binding error
  // to a user who actually typed a contract — an untouched seeded contract must
  // not block an unbind (sending `binding: null` clears it server-side anyway).
  const contractFieldsDirty = trackInputs.some(
    ({ definition, raw }) => seed.trackCounts[definition.contractFrameCountField] !== raw,
  ) || seed.cell !== cellRaw || seed.columns !== colsRaw;

  return { trackInputs, cellRaw, colsRaw, cellNum, colsNum, primaryInput, hasContract, contractFieldsDirty };
}

function intInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function validateRuntimeContract(contract, hasBinding) {
  const { trackInputs, cellRaw, colsRaw, cellNum, colsNum, primaryInput, hasContract, contractFieldsDirty } = contract;
  if (!hasContract && (trackInputs.some(({ raw }) => raw !== '') || cellRaw !== '' || colsRaw !== '')) {
    return `${primaryInput?.definition.label || 'Primary track'} frame count is required for a runtime contract.`;
  }
  const invalidTrack = trackInputs.find(({ definition, value }) => (
    value !== null && !intInRange(value, definition.minFrameCount, definition.maxFrameCount)
  ));
  if (invalidTrack) {
    const { definition } = invalidTrack;
    return `${definition.label} frame count must be a whole number ${definition.minFrameCount}–${definition.maxFrameCount}.`;
  }
  if (cellNum !== null && !intInRange(cellNum, 16, 1024)) {
    return 'Cell size must be a whole number 16–1024.';
  }
  if (colsNum !== null && !intInRange(colsNum, 1, 256)) {
    return 'Column count must be a whole number 1–256.';
  }
  // A newly typed contract needs a binding or the value would be discarded.
  if (hasContract && contractFieldsDirty && !hasBinding) {
    return 'Bind an app and destination, or clear the contract.';
  }
  return null;
}

function describeContractMismatch(savedContract, atlasTrackCounts, atlasCols, atlasCell) {
  if (!savedContract) return null;
  const trackMismatch = atlasTrackCounts.find(({ definition, count }) => {
    const expected = savedContract[definition.contractFrameCountField];
    return Number.isInteger(expected) && expected !== count;
  });
  if (trackMismatch) {
    const { definition, count } = trackMismatch;
    return `contract expects ${savedContract[definition.contractFrameCountField]} ${definition.label.toLowerCase()} frames, atlas has ${count ?? 'none'}`;
  }
  if (Number.isInteger(savedContract.columnCount) && savedContract.columnCount !== atlasCols) {
    return `contract expects ${savedContract.columnCount} cols, atlas has ${atlasCols ?? '?'}`;
  }
  if (Number.isInteger(savedContract.cellSize) && savedContract.cellSize !== atlasCell) {
    return `contract expects ${savedContract.cellSize}px cells, atlas has ${atlasCell ?? '?'}px`;
  }
  return null;
}

export function describeRuntimeAtlas(trackDefinitions, atlasGeom, savedContract) {
  if (!atlasGeom) return { atlasSummary: null, savedContractMismatch: null };
  const atlasTrackCounts = trackDefinitions.map((definition) => ({
    definition,
    count: trackFrameCountOf(atlasGeom, definition),
  }));
  const atlasCols = Array.isArray(atlasGeom.columns) ? atlasGeom.columns.length : null;
  const atlasCell = Number.isInteger(atlasGeom.cellSize) ? atlasGeom.cellSize : null;
  const atlasSummary = [
    ...atlasTrackCounts
      .filter(({ count }) => count !== null)
      .map(({ definition, count }) => `${count} ${definition.label.toLowerCase()} frames`),
    `${atlasCols ?? '?'} cols`,
    ...(atlasCell == null ? [] : [`${atlasCell}px`]),
  ].join(' · ');
  // Mirrors runtimeContractMismatch on the server.
  const savedContractMismatch = describeContractMismatch(savedContract, atlasTrackCounts, atlasCols, atlasCell);
  return { atlasSummary, savedContractMismatch };
}
