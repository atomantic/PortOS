/**
 * Download/integrity status for every weight a local VideoGen render needs: model, speed adapter, text encoders and IC-LoRA.
 *
 * Use when: The /media/video page shows the "Available" / "Download" badges under the Model
 * field, the repair banners, and gates Generate on a missing or damaged weight before the
 * multi-GB pull would surface at Render.
 */

import { useCallback } from 'react';
import { isMiniMaxH3SpeedProfile } from '../lib/videoGenParams.js';
import {
  TEXT_ENCODER_DOWNLOAD_ID, speedProfileDownloadId, textEncoderDownloadId,
  useDownloadableAssets, useModelDownloadStatus,
} from './useModelDownloadStatus';

// The optional LTX 2.5 Ingredients adapter, offered beside any LTX 2.5 model.
const LTX25_REFERENCE_ID = 'ic-ingredients-25';

/**
 * `model` and `ic` are `useVideoGenForm()` groups. `rendersOffMachine` turns
 * the gate off for a hosted lane, whose weights live with the provider.
 */
export function useVideoGenWeightAssets({ model, ic, catalogLoading, rendersOffMachine }) {
  const { modelId, currentModel, speedProfileId, textEncoderOptions, textEncoderId, setTextEncoderId } = model;
  const { icSpec, icModeActive } = ic;
  // Inline cache-status badge for the picked video model + the active text
  // encoder (a separate ~7-25 GB HF pull). Drives the "Available" / "Download"
  // affordance under the Model select, so users learn about the multi-GB
  // pull before hitting Render.
  const modelDownload = useModelDownloadStatus({ kind: 'video' });
  const modelStatus = modelId ? modelDownload.getStatus(modelId) : null;
  const ltx25ReferenceStatus = currentModel?.runtime === 'ltx25' ? modelDownload.getStatus(LTX25_REFERENCE_ID) : null;
  const selectedH3SpeedProfile = currentModel?.speedProfiles?.find((p) => p.id === speedProfileId && isMiniMaxH3SpeedProfile(p));
  const speedProfileAssetId = selectedH3SpeedProfile ? speedProfileDownloadId(modelId, speedProfileId) : null;
  const speedProfileStatus = speedProfileAssetId ? modelDownload.getStatus(speedProfileAssetId) : null;
  const usesSharedTextEncoder = currentModel?.runtime === 'mlx_video' || currentModel?.runtime === 'ltx2';
  const textEncoderInfo = modelDownload.extra.textEncoder || null;
  const textEncoderStatus = textEncoderInfo
    ? (modelDownload.activeModelId === TEXT_ENCODER_DOWNLOAD_ID
      ? { ...textEncoderInfo, downloading: true, progress: modelDownload.progress }
      : textEncoderInfo)
    : null;
  // Substitutable prompt conditioner (#4081). A built-in option ships inside
  // the model's own weights, so only a substitute has a download of its own to
  // track — and only then can it gate Generate.
  const selectedTextEncoder = textEncoderOptions.find((option) => option.id === textEncoderId) || null;
  // Non-null exactly when the selection has a download of its own — a built-in
  // conditioner ships inside the model's weights. Doubles as the "needs
  // weights" predicate so there's one derivation, not two.
  const textEncoderOptionDownloadId = selectedTextEncoder && !selectedTextEncoder.builtIn
    ? textEncoderDownloadId(selectedTextEncoder.id)
    : null;
  const textEncoderOptionStatus = textEncoderOptionDownloadId
    ? modelDownload.getStatus(textEncoderOptionDownloadId)
    : null;
  // Choosing a substitute IS the request for its weights: it is unusable until
  // resident and Generate is gated on it either way, so `startWhenIdle` turns
  // the pick into the pull (it owns waiting for the cache verdict, skipping an
  // already-downloaded one, and queueing behind an active download).
  //
  // Wired to the PICKER's onChange alone, deliberately — a Remix, a resumed
  // render, and the snap-to-stock on a model change all reach `setTextEncoderId`
  // too, and a multi-GB pull must follow a click the user just made rather than
  // a state restore. Passing null for a built-in option clears any queued pull.
  const { startWhenIdle: startEncoderWhenIdle } = modelDownload;
  const handleTextEncoderChange = useCallback((id) => {
    setTextEncoderId(id);
    const option = textEncoderOptions.find((entry) => entry.id === id);
    startEncoderWhenIdle(option && !option.builtIn ? textEncoderDownloadId(id) : null);
  }, [setTextEncoderId, textEncoderOptions, startEncoderWhenIdle]);
  const icWeightStatus = icSpec ? modelDownload.getStatus(icSpec.mode) : null;
  const assets = useDownloadableAssets([
    {
      key: 'model', id: modelId, label: 'selected model weights',
      applies: true, extraBlocked: catalogLoading || !modelId || !currentModel,
      status: modelStatus, keyPrefix: modelId,
      name: currentModel?.name || modelId, repairLabel: 'Repair model',
    },
    {
      key: 'speed-profile', id: speedProfileAssetId, label: 'speed profile adapter',
      applies: !!speedProfileAssetId, status: speedProfileStatus, keyPrefix: speedProfileAssetId,
      name: selectedH3SpeedProfile?.name || 'The selected speed adapter', repairLabel: 'Download adapter again',
    },
    {
      key: 'shared-encoder', id: TEXT_ENCODER_DOWNLOAD_ID, label: 'shared text encoder',
      applies: usesSharedTextEncoder, status: textEncoderStatus, keyPrefix: 'text-encoder',
      name: `The shared text encoder${textEncoderStatus?.repo ? ` (${textEncoderStatus.repo})` : ''}`, repairLabel: 'Repair encoder',
    },
    {
      key: 'encoder-option', id: textEncoderOptionDownloadId,
      label: `${selectedTextEncoder?.label || 'selected'} text encoder`,
      applies: !!textEncoderOptionDownloadId, status: textEncoderOptionStatus, keyPrefix: textEncoderOptionDownloadId,
      name: `The ${selectedTextEncoder?.label || 'selected'} text encoder`, repairLabel: 'Repair text encoder',
    },
    {
      key: 'ic-lora', id: icSpec?.mode, label: `${icSpec?.label || 'IC-LoRA'} weight`,
      applies: icModeActive, status: icWeightStatus, keyPrefix: icSpec?.mode,
      name: `The ${icSpec?.label || 'IC-LoRA'} weight`, repairLabel: `Repair ${icSpec?.label || 'IC-LoRA'}`,
    },
  ], { loading: modelDownload.loading, downloading: modelDownload.downloading, enabled: !rendersOffMachine });
  const sharedEncoderAsset = assets.find(asset => asset.key === 'shared-encoder');
  const blockedAsset = assets.find(asset => asset.blocked);
  const activeWeightErrorIds = [...assets.filter(asset => asset.applies).map(asset => asset.id).filter(Boolean),
    ...(currentModel?.runtime === 'ltx25' ? [LTX25_REFERENCE_ID] : [])];
  const activeWeightError = activeWeightErrorIds.includes(modelDownload.lastError?.modelId)
    ? modelDownload.lastError
    : null;

  return {
    modelDownload, modelStatus, ltx25ReferenceId: LTX25_REFERENCE_ID, ltx25ReferenceStatus,
    selectedH3SpeedProfile, speedProfileAssetId, speedProfileStatus,
    usesSharedTextEncoder, textEncoderStatus, sharedEncoderAsset,
    textEncoderOptionDownloadId, textEncoderOptionStatus, handleTextEncoderChange,
    icWeightStatus, assets, blockedAsset, activeWeightError,
  };
}

export default useVideoGenWeightAssets;
