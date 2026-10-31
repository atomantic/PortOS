# Execution options

Execution options are optional, bounded settings independent of model and reasoning effort. Version 1 supports Codex subscription speed: **Inherit/default**, **Standard**, and **Fast**. Existing records gain no tier and retain their prior behavior. Fast may consume more subscription usage or credits; no fixed multiplier is assumed.

## Selection and persistence

The canonical registry is `server/lib/aiToolkit/internal/executionOptions.js`, reexported for the UI by `server/lib/executionOptions.js`. Descriptors declare stable keys, types, allowed values, inheritance and help. The server capability endpoint narrows values by the actual harness, mode, model, account and installed protocol. Adding an option requires its registry entry, capability inspection and transport adapter; existing forms use the shared descriptor renderer.

Structured callers save optional `executionOptions`. Resolution is per key: provider defaults, saved selection, task override, then run override. Empty/unset inherits; explicit Standard overrides Fast. Baked provider speed/auth routing conflicts are refused with a remedy. Global Codex configuration is never written.

Legacy forms persist only a provider reference. An explicit speed edit creates or reuses a deterministic source-linked provider selection. Its reference goes through the form's existing persistence, cloning, scheduling, retry and import/export paths, so no extra field can be discarded by an older form. Ordinary source providers are resolved on every read; a disabled or missing source disables the selection. Composite routes are materialized as machine-local source snapshots for standalone readers. Existing records and pinned jobs are never rewritten. Generated selections are excluded from automatic provider discovery; explicitly selected references remain usable.

CoS also stores structured options in tasks, jobs, templates, schedule/stage configuration, role assignments and resume overrides. The merged Claim Workflow Audit uses the shared AgentJobProviderFields selector and the same persisted job fields. Saving speed never enables a job, changes its interval or starts a run. A saved recurring job uses its explicitly selected tier on future runs. Changing providers clears stale task/run options. Resume retains explicit task/run pins without freezing inherited defaults. CoS task schema version 10 prevents older peers from ignoring execution semantics. Provider credentials and generated provider records remain in their existing machine-local store.

## Dispatch and attribution

Capability inspection is read-only: initialize, account/read, configRequirements/read, config/read and paginated model/list. It never starts a model turn. Dispatch revalidates fresh evidence under the selected route environment/cwd and remaining timeout. Unverified/old runtimes, API authentication, local/gateway routes, managed Fast restrictions and unsupported models are refused. Unsupported saved choices remain visible and clearable. No model or paid route is substituted to satisfy speed, and an option refusal does not bench a healthy provider or trigger fallback/investigation.

Verified with Codex CLI 0.162.1 and its generated protocol. Native CLI and TUI request Fast with `-c service_tier="fast"`; explicit Standard uses `-c service_tier="default"`. Only Fast enables the documented `features.fast_mode` config capability; explicit Standard remains usable when managed policy disables Fast. No invented `--fast` flag or `/fast` prompt is sent. Approval and sandbox settings stay owned by the existing execution profile. The text app-server route uses **serviceTierForTurn** (fast/default), preserving its ephemeral read-only tool-free envelope. Direct API service tiers are a separate contract and are not inferred from subscription speed.

Run metadata records version, requested values, effective values, per-key provenance and confirmation. Current transports prove the request but do not report the effective tier, so effective remains empty and UI says **requested / effective unconfirmed**. Agent/run details and shell session details expose this distinction and the usage caveat; a provider name or requested argv is never evidence of applied Fast.

Official references: [speed configuration](https://learn.chatgpt.com/docs/agent-configuration/speed), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). No paid live generation is needed to inspect capabilities.

## Consumer checklist

Every shared-selector consumer below uses the legacy reference bridge unless it supplies the additive controlled `executionOptions` / `onExecutionOptionsChange` pair. Persist the returned provider reference exactly as any other preset; never reconstruct it from a display name. Shared compact, stacked and dense layouts render the same controls adjacent to effort. The inventory test requires new consumers to be listed here.

| Shared selector consumer | Persistence contract |
| --- | --- |
| `client/src/components/FeatureProviderPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/components/agents/AgentList.jsx` | Shared structured options or saved provider reference |
| `client/src/components/agents/tabs/OverviewTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/apps/AppQualityRunner.jsx` | Shared structured options or saved provider reference |
| `client/src/components/apps/LaunchVideoPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/apps/SlashDoPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/apps/SlashDoRunDrawer.jsx` | Shared structured options or saved provider reference |
| `client/src/components/apps/tabs/IssuesTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/apps/tabs/PullRequestsTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/brain/tabs/ConfigTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/brain/tabs/DailyLogTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/catalog/CatalogDesignPanel.jsx` | Request-local provider reference forwarded unchanged to the face-design writing request; nothing is persisted |
| `client/src/components/codeAnimation/CodeAnimationCodeScore.jsx` | Shared structured options or saved provider reference |
| `client/src/components/codeAnimation/ProductionProjectForm.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/AgentJobProviderFields.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/AppProviderPin.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/PersistentMindProfileControls.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/PersistentMindSandboxControls.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/PersistentMindTaskModelAllowlistControls.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/PersistentMindThinkingPresets.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/ReviewerPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/TaskAddFormView.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/tabs/ConfigTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/tabs/MemoryTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/tabs/RelaunchAgentModal.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/tabs/ResumeAgentModal.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/tabs/schedule/MusicVideoAutopilotSettings.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/tabs/schedule/PipelineStageConfig.jsx` | Shared structured options or saved provider reference |
| `client/src/components/cos/tabs/schedule/TaskModelQuickControls.jsx` | Shared structured options or saved provider reference |
| `client/src/components/creative-commission/CommissionConfigForm.jsx` | Shared structured options or saved provider reference |
| `client/src/components/creative-director/CreativeDirectorModelsDrawer.jsx` | Shared structured options or saved provider reference |
| `client/src/components/creative/CreativeRefinement.jsx` | Conversation-local provider reference forwarded unchanged to preview and refinement requests; the host editor owns draft persistence |
| `client/src/components/decks/DeckLlmPinPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/components/digital-twin/TwinProviderPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/components/digital-twin/tabs/AppearanceTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/digital-twin/tabs/AvatarBioTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/digital-twin/tabs/InterviewTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/digital-twin/tabs/PersonalityTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/digital-twin/tabs/VoiceStyleTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/fableloom/LoomEditorialAutomation.jsx` | Shared structured options or saved provider reference |
| `client/src/components/fableloom/LoomEpisodeFeedback.jsx` | Shared structured options or saved provider reference |
| `client/src/components/fableloom/LoomEpisodeOutlinePlanner.jsx` | Shared structured options or saved provider reference |
| `client/src/components/fableloom/LoomSeriesPlan.jsx` | Shared structured options or saved provider reference |
| `client/src/components/fableloom/LoomSettingsDrawer.jsx` | Shared structured options or saved provider reference |
| `client/src/components/games/GameFeedback.jsx` | Shared structured options or saved provider reference |
| `client/src/components/github/GitHubAgentPinForm.jsx` | Shared structured options or saved provider reference |
| `client/src/components/github/GitHubAgentRules.jsx` | Shared structured options or saved provider reference |
| `client/src/components/goals/GoalsListView.jsx` | Shared structured options or saved provider reference |
| `client/src/components/goals/GoalsTreeView.jsx` | Shared structured options or saved provider reference |
| `client/src/components/insights/GoalScorecardTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/meatspace/post/PostDrillConfig.jsx` | Shared structured options or saved provider reference |
| `client/src/components/meatspace/post/RhetoricTrainer.jsx` | Shared structured options or saved provider reference |
| `client/src/components/meatspace/post/WordplayTrainer.jsx` | Shared structured options or saved provider reference |
| `client/src/components/media/PromptEnhancer.jsx` | Shared structured options or saved provider reference |
| `client/src/components/media/PromptFromMedia.jsx` | Shared structured options or saved provider reference |
| `client/src/components/media/PromptRefineModal.jsx` | Shared structured options or saved provider reference |
| `client/src/components/messages/ConfigTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/models/ComparisonResearch.jsx` | Shared structured options or saved provider reference |
| `client/src/components/models/ProviderFallbacks.jsx` | Shared structured options or saved provider reference |
| `client/src/components/models/UntrustedContentPolicyPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/moodBoard/MoodBoardGeneratePanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/moodBoard/MoodBoardStylePanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/music/ChiptunePanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/music/MusicDesigner.jsx` | Shared structured options or saved provider reference |
| `client/src/components/music/TrackWaveformHost.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/ArtGuideDrafter.jsx` | Session-local structured options forwarded to art-guide preview and draft requests |
| `client/src/components/musicVideo/AutoReviewPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/AutonomousStartDrawer.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/AutopilotPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/CodeAuthoringPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/CodeVideoPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/DocumentCompositionPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/MusicVideoLlmPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/PromotionPlanPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/PublishKitPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/musicVideo/StoryWorkbench.jsx` | Shared structured options for this story-development session |
| `client/src/components/musicVideo/TreatmentPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/pipeline/AutopilotPanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/pipeline/SeriesAutopilotSchedule.jsx` | Shared structured options or saved provider reference |
| `client/src/components/pipeline/SeriesLlmPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/components/pipeline/stages/NounsStage.jsx` | Shared structured options or saved provider reference |
| `client/src/components/pipeline/stages/VisualGenSettings.jsx` | Shared structured options or saved provider reference |
| `client/src/components/quotaBurn/StepSettings.jsx` | Shared structured options or saved provider reference |
| `client/src/components/settings/AiAssignmentsTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/settings/OrchestrationTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/settings/VoiceTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/songs/SongScoreParts.jsx` | Shared structured options or saved provider reference |
| `client/src/components/system-resources/StoragePanel.jsx` | Shared structured options or saved provider reference |
| `client/src/components/universe/VisionProviderPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/components/universeBuilder/MoodBoardStyleSynthesis.jsx` | Shared structured options or saved provider reference |
| `client/src/components/universeBuilder/UniverseBibleTab.jsx` | Shared structured options or saved provider reference |
| `client/src/components/writers-room/StagePromptModelPicker.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/AIProviders.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/CatalogIngest.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/CodeAnimation.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/FableLoom.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/Importer.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/Loops.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/PipelineEditorialChecks.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/PipelineManuscriptEditor.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/PromptManager.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/RunnerPage.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/StoryBuilder.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/ThreejsModelDetail.jsx` | Shared structured options or saved provider reference |
| `client/src/pages/ThreejsModels.jsx` | Shared structured options or saved provider reference |

Custom adapters are `client/src/components/cos/tabs/TaskItem.jsx`, `client/src/components/cos/tabs/schedule/GlobalConfigControls.jsx`, `client/src/components/cos/tabs/schedule/TaskModelQuickControls.jsx`, `client/src/components/providers/ProviderForm.jsx`, `client/src/components/providers/ProviderComposePopover.jsx`, `client/src/components/cos/ReviewerPicker.jsx`, and `client/src/components/shell/ShellProviderLauncher.jsx`. These use ExecutionOptionsSelect directly. Resume/Relaunch use the shared selector; shell settings save a selection without launching until the user presses Launch. The server resolves the reference and validates before opening a provider shell.

Verification covers default compatibility, explicit Standard precedence, unsupported/unknown options, native CLI/TUI/resume argv, app-server turn-only fields, provider-store reload/source edits, task retry/resume, audit-job configuration with recurrence disabled, legacy selector reference round-trip, and shell refusal/attribution. Required hosted CI supplies broader coverage.
