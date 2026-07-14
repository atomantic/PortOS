// Barrel for client/src/hooks/ — discovery surface, not a forced import path.
// See client/src/hooks/README.md for the human-readable catalog and
// CLAUDE.md "Module organization" for the maintenance convention.
//
// Hooks export shape: most are named exports (`export function useX`), but a
// handful default-export (`export default function useX`). The barrel
// surfaces both as `useX` so importers don't need to know which style each
// hook uses.

// === Default-exporting hooks (re-exported as named) ===
export { default as useAnchorReveal } from './useAnchorReveal.js';
export { default as useCityAudio } from './useCityAudio.js';
export { default as useAutoSizeTextarea } from './useAutoSizeTextarea.js';
export { default as useChartColors } from './useChartColors.js';
export * from './useChartColors.js';
export { default as useClickOutside } from './useClickOutside.js';
export { default as useConfirmDelete } from './useConfirmDelete.js';
export { default as useColorMatch } from './useColorMatch.js';
export { default as useContainerWidth } from './useContainerWidth.js';
export { default as useEscapeKey } from './useEscapeKey.js';
export { default as useFieldDraft } from './useFieldDraft.js';
export { default as useFocusTrap } from './useFocusTrap.js';
export { default as useImageGenQueue } from './useImageGenQueue.js';
export { default as useImageRenderSettings } from './useImageRenderSettings.js';
export { default as useSingleImageRender } from './useSingleImageRender.js';
export { default as useSlotInFlight } from './useSlotInFlight.js';
export { default as useSseJobSlot } from './useSseJobSlot.js';
export { default as useSingToScore } from './useSingToScore.js';
export * from './useSingToScore.js';
export { default as useSongTraining } from './useSongTraining.js';
export { default as useMediaPreviewActions } from './useMediaPreviewActions.js';
export { default as useKeyboardControls } from './useKeyboardControls.js';
export { default as useKeyboardShortcuts } from './useKeyboardShortcuts.js';
export * from './useKeyboardShortcuts.js';
export { default as useMediaJobProgress } from './useMediaJobProgress.js';
export * from './useMediaJobSse.js';
export { default as useSceneRenderLifecycle } from './useSceneRenderLifecycle.js';
export { default as useMoltworldWs } from './useMoltworldWs.js';
export { default as useMounted } from './useMounted.js';
export { default as usePendingListRows } from './usePendingListRows.js';
export { default as usePopoverPosition } from './usePopoverPosition.js';
export { default as useLocalModels } from './useLocalModels.js';
export { default as usePreviewRoute } from './usePreviewRoute.js';
export { default as useProviderModels } from './useProviderModels.js';
export { default as useRowDraft } from './useRowDraft.js';
export { default as useTheme } from './useTheme.js';
export { default as useUniverse } from './useUniverse.js';
export { default as useUniverseAction } from './useUniverseAction.js';
export { default as useUniverseGallery } from './useUniverseGallery.js';
export { default as useVideoDownload } from './useVideoDownload.js';
export { default as useYoutubeTrackImport } from './useYoutubeTrackImport.js';
export { default as useReferenceAudioImport } from './useReferenceAudioImport.js';
export { default as useMidiTranscription } from './useMidiTranscription.js';
export { default as useMidiNotes } from './useMidiNotes.js';
export { default as useMidiPlayer } from './useMidiPlayer.js';
export { default as useCanvasDprSize } from './useCanvasDprSize.js';
export { default as useCanvasRollPalette } from './useCanvasRollPalette.js';

// === Mixed (both default and named) — surface both ===
export { default as useAsyncAction } from './useAsyncAction.js';
export * from './useAsyncAction.js';
export { default as useCitySettings } from './useCitySettings.js';
export * from './useCitySettings.js';

// === Notifications & toasts ===
export * from './useAIStatusNotifications.js';
export * from './useAgentFeedbackToast.jsx';
export * from './useErrorNotifications.js';
export * from './useNotifications.js';
export * from './useOnDemandTaskToast.js';
export * from './useSharingNotifications.js';

// === Pipeline / Story Builder wiring ===
export * from './useArcCanvasSync.js';

// === Progress & streaming (SSE / socket) ===
export * from './useImageGenProgress.js';
export * from './useImporterProgress.js';
export * from './useInstallStream.js';
export * from './useOpenClawStream.js';
export * from './usePipelineProgress.js';
export * from './useReaderPanel.js';
export * from './useSeriesEditorial.js';
export * from './useSseProgress.js';
export * from './useModelDownloadStatus.js';

// === Media (annotations, completion, attachments) ===
export * from './useMediaAnnotations.js';
export * from './useMediaCompletionRefresh.js';
export * from './useOpenClawAttachments.js';

// === Settings-derived shared state ===
export * from './useCodeReviewDefaults.jsx';
export { default as useCatalogTypes } from './useCatalogTypes.jsx';
export * from './useCatalogTypes.jsx';

// === Sockets & lifecycle ===
export * from './usePrevious.js';
export * from './useSocket.js';
export * from './useTimeTick.js';
export * from './useUpdateChecker.jsx';
export * from './useVisibilityEvent.js';

// === UI / interaction ===
export * from './useArmedAction.js';
export * from './useAutoRefetch.js';
export * from './useCmdKSearch.js';
export * from './useCooldownTick.js';
export { default as useDrawerTab } from './useDrawerTab.js';
export * from './useKeyboardHelp.js';
export * from './useLockToggle.js';
export * from './useScrollLock.js';
export * from './useSwipeNav.js';
export * from './useValidTab.js';

// === Storage & persistence ===
export * from './useLocalStorageBool.js';
export * from './useNavWorkingSet.js';

// === Sidebar navigation data ===
export * from './useFocusRefreshedList.js';
export * from './useSidebarApps.js';
export * from './useSidebarSeries.js';
export * from './useSidebarUniverses.js';

// === Domain: City / Voice / Mortality / Universe / Apps / Sessions ===
export * from './useAppDeploy.js';
export * from './useAppOperation.js';
export * from './useAppOverrideActions.js';
export * from './useCanonPatch.js';
export * from './useCityData.js';
export * from './useCityPlayback.js';
export * from './useDeathClock.js';
export * from './useGoalDetail.js';
export * from './usePostSession.js';
export * from './useRecordMerge.js';
export * from './useRenderJobQueue.js';
export * from './useSyncIntegrity.js';
export * from './useTwinEvaluationSuite.js';
export * from './useUniverseNav.js';
export * from './useVoiceUiSync.js';
