import { useEffect, useMemo, useState } from 'react';
import {
  contractSeedOf, readRuntimeContract, trackFrameCountOf, validateRuntimeContract,
} from './publishRuntimeContract.js';

export function usePublishBindingDraft(saved, trackDefinitions, current, setConfirmStage) {
  const {
    appId, atlasDestPath, portraitDestPath, presentationIdleDestPath, codeBinding,
  } = saved ?? {};
  const { path, resourcePath } = codeBinding ?? {};
  const savedContract = saved?.runtimeContract || null;
  const bindingSeed = useMemo(() => ({
    appId: appId || '',
    atlasDestPath: atlasDestPath || '',
    portraitDestPath: portraitDestPath || '',
    presentationIdleDestPath: presentationIdleDestPath || '',
    codePath: path || '',
    resourcePath: resourcePath || '',
  }), [appId, atlasDestPath, portraitDestPath, presentationIdleDestPath, path, resourcePath]);

  // Contract fields are strings so an empty input is distinguishable from a 0.
  // The served registry owns track fields, bounds, labels and the primary marker.
  const contractSeed = useMemo(() => ({
    trackCounts: contractSeedOf(trackDefinitions, savedContract),
    cell: savedContract?.cellSize != null ? String(savedContract.cellSize) : '',
    columns: savedContract?.columnCount != null ? String(savedContract.columnCount) : '',
  }), [trackDefinitions, savedContract]);

  const [binding, setBinding] = useState(bindingSeed);
  const [contract, setContract] = useState(contractSeed);

  // A save round-trip re-seeds the draft and drops consent for the old binding.
  useEffect(() => {
    setBinding(bindingSeed);
    setContract(contractSeed);
    setConfirmStage(null);
  }, [bindingSeed, contractSeed, setConfirmStage]);

  const setBindingField = (field, value) => setBinding((draft) => ({ ...draft, [field]: value }));
  const setContractField = (field, value) => setContract((draft) => ({ ...draft, [field]: value }));
  const setTrackCount = (field, value) => setContract((draft) => ({
    ...draft,
    trackCounts: { ...draft.trackCounts, [field]: value },
  }));

  const fillFromAtlas = () => {
    const geometry = current?.geometry;
    if (!geometry) return;
    setContract({
      trackCounts: Object.fromEntries(trackDefinitions.map((definition) => {
        const frames = trackFrameCountOf(geometry, definition);
        return [definition.contractFrameCountField, frames == null ? '' : String(frames)];
      })),
      cell: Number.isInteger(geometry.cellSize) ? String(geometry.cellSize) : '',
      columns: Array.isArray(geometry.columns) ? String(geometry.columns.length) : '',
    });
  };

  const clearContract = () => setContract({
    trackCounts: contractSeedOf(trackDefinitions, null),
    cell: '',
    columns: '',
  });

  const parsedContract = readRuntimeContract(trackDefinitions, contract, contractSeed);
  const contractError = validateRuntimeContract(parsedContract, Boolean(binding.appId && binding.atlasDestPath.trim()));
  // The server inherits an omitted contract only for the same app. A re-point
  // with a populated contract must also send the contract shown in the editor.
  const contractDirty = parsedContract.contractFieldsDirty
    || (parsedContract.hasContract && binding.appId !== bindingSeed.appId);
  const bindingDirty = contractDirty || Object.keys(bindingSeed).some((field) => (
    bindingSeed[field] !== (field === 'appId' ? binding[field] : binding[field].trim())
  ));

  return {
    binding, setBindingField, bindingDirty,
    contract, setContractField, setTrackCount, clearContract, fillFromAtlas,
    parsedContract, contractError, contractDirty, savedContract,
  };
}
