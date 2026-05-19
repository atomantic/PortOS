// Barrel for client/src/hooks/ — discovery surface, not a forced import path.
// See client/src/hooks/README.md for the human-readable catalog and
// CLAUDE.md "Module organization" for the maintenance convention.
//
// Hooks export shape: most are named exports (`export function useX`), but a
// handful default-export (`export default function useX`). The barrel
// surfaces both as `useX` so importers don't need to know which style each
// hook uses.

// === Default-exporting hooks (re-exported as named) ===
export { default as useCityAudio } from './useCityAudio.js';
export { default as useClickOutside } from './useClickOutside.js';
export { default as useContainerWidth } from './useContainerWidth.js';
export { default as useFieldDraft } from './useFieldDraft.js';
export { default as useImageGenQueue } from './useImageGenQueue.js';
export { default as useImagePreviewActions } from './useImagePreviewActions.js';
export { default as useKeyboardControls } from './useKeyboardControls.js';
export { default as useMediaJobProgress } from './useMediaJobProgress.js';
export { default as useMoltworldWs } from './useMoltworldWs.js';
export { default as useMounted } from './useMounted.js';
export { default as useProviderModels } from './useProviderModels.js';
export { default as useRowDraft } from './useRowDraft.js';
export { default as useTheme } from './useTheme.js';
export { default as useUniverseAction } from './useUniverseAction.js';

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
export * from './useSharingNotifications.js';

// === Progress & streaming (SSE / socket) ===
export * from './useImageGenProgress.js';
export * from './useOpenClawStream.js';
export * from './usePipelineAutoRunProgress.js';
export * from './usePipelineVolumeBeatsProgress.js';
export * from './useSseProgress.js';

// === Media (annotations, completion, attachments) ===
export * from './useMediaAnnotations.js';
export * from './useMediaCompletionRefresh.js';
export * from './useOpenClawAttachments.js';

// === Sockets & lifecycle ===
export * from './useSocket.js';
export * from './useUpdateChecker.jsx';

// === UI / interaction ===
export * from './useArmedAction.js';
export * from './useAutoRefetch.js';
export * from './useCmdKSearch.js';
export * from './useKeyboardHelp.js';
export * from './useLockToggle.js';
export * from './useScrollLock.js';
export * from './useSwipeNav.js';

// === Storage & persistence ===
export * from './useLocalStorageBool.js';

// === Domain: City / Voice / Mortality / Universe / Apps / Sessions ===
export * from './useAppDeploy.js';
export * from './useAppOperation.js';
export * from './useCityData.js';
export * from './useDeathClock.js';
export * from './usePostSession.js';
export * from './useVoiceUiSync.js';
