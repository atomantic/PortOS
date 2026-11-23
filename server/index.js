import maintenanceRoutes from './routes/maintenance.js';
import './services/databaseBootFence.js';
import express from 'express';
import { Server } from 'socket.io';
import { SOCKET_MAX_PAYLOAD_BYTES } from './lib/socketPayloadLimits.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PATHS } from './lib/fileUtils.js';
import { createLazyRouter } from './lib/lazyRouter.js';
import { defaultRequestBody } from './lib/defaultRequestBody.js';
import { mountAssetRoutes, mountClientDist } from './services/assetMounts.js';
import { existsSync } from 'fs';
import { createTailscaleServers } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';
import { getBuildId, getStampedIndexHtml } from './lib/buildId.js';
import { getBuildIdentity } from './lib/buildIdentity.js';
import { httpCompression } from './lib/httpCompression.js';
import { PORTS } from './lib/ports.js';
import { isSmokeBoot } from './lib/runtimeEnv.js';
import { installUpgradeFallback } from './lib/upgradeFallback.js';

import systemHealthRoutes from './routes/systemHealth.js';
import shellBootstrapRoutes from './routes/shellBootstrap.js';
import systemActivityRoutes from './routes/systemActivity.js';
import { createManagedVisitorRoutes } from './routes/managedVisitors.js';
import { createManagedVisitorAdminRoutes } from './routes/managedVisitorAdmin.js';
import authRoutes from './routes/auth.js';
import { allowSocketRequest, authGate, hostControlRouteGate, socketAuthGate } from './services/authGate.js';
// Side-effect import (#5920): evaluating the completion hook is what registers the
// Creative Director project starter on `creativeDirector/projectStartSink.js`, the
// seam `pipeline/episodeVideo.js` starts a CD project through. Arm it before
// the first pipeline request, including when the CD router has never loaded.
import './services/creativeDirector/completionHook.js';
// Side-effect import (#17896): binds every late-bound service name to its module.
import './services/serviceLoaders.js';
import './services/localModelObservations.js';
import { initSocket } from './services/socket.js';
import { remoteDesktopBroker } from './services/remoteDesktop.js';
import { authEvents } from './services/auth.js';
import { mountEidoverseOnServer } from './services/eidoverseHost.js';
import { closeEidoverseProxySockets } from './services/eidoverseProxy.js';
import { bootstrapServices, runBootSequence, registerShutdownHandlers } from './services/bootstrap.js';
import { syncLocalProviderModels } from './services/localLlm.js';
import { errorMiddleware } from './lib/errorHandler.js';
import { setHttpsEnabledAtBoot } from './lib/httpsState.js';
import { JSON_BODY_LIMIT } from './lib/uploadLimits.js';
import { createPortOSProviderRoutes } from './routes/providers.js';
import { configureTailcatIngress } from './services/tailcatIngress.js';
import { createModelComparisonRoutes } from './routes/modelComparison.js';
import { createModelPerformanceBenchmarkRoutes } from './routes/modelPerformanceBenchmarks.js';
import { createPortOSRunsRoutes } from './routes/runs.js';
import { createPortOSPromptsRoutes } from './routes/prompts.js';
import { startNativeUsageRefresh } from './services/nativeUsageHistory.js';

const providerFallbackRoutes = createLazyRouter(() => import('./routes/providerFallbacks.js'));
const alertsRoutes = createLazyRouter(() => import('./routes/alerts.js'));
const systemCapabilitiesRoutes = createLazyRouter(() => import('./routes/systemCapabilities.js'));
const systemResourcesRoutes = createLazyRouter(() => import('./routes/systemResources.js'));
const capabilitiesRoutes = createLazyRouter(() => import('./routes/capabilities.js'));
const agentContextMcpRoutes = createLazyRouter(() => import('./routes/agentContextMcp.js'));
const appsRoutes = createLazyRouter(() => import('./routes/apps/index.js'));
const workspaceContextsRoutes = createLazyRouter(() => import('./routes/workspaceContexts.js'));
const referenceReposRoutes = createLazyRouter(() => import('./routes/referenceRepos.js'));
const portsRoutes = createLazyRouter(() => import('./routes/ports.js'));
const networkExposureRoutes = createLazyRouter(() => import('./routes/networkExposure.js'));
const logsRoutes = createLazyRouter(() => import('./routes/logs.js'));
const scaffoldRoutes = createLazyRouter(() => import('./routes/scaffold.js'));
const historyRoutes = createLazyRouter(() => import('./routes/history.js'));
const commandsRoutes = createLazyRouter(() => import('./routes/commands.js'));
const gitRoutes = createLazyRouter(() => import('./routes/git.js'));
const usageRoutes = createLazyRouter(() => import('./routes/usage.js'));
const quotaBurnRoutes = createLazyRouter(() => import('./routes/quotaBurn.js'));
const screenshotsRoutes = createLazyRouter(() => import('./routes/screenshots.js'));
const shellRoutes = createLazyRouter(() => import('./routes/shell.js'));
const itermRoutes = createLazyRouter(() => import('./routes/iterm.js'));
const attachmentsRoutes = createLazyRouter(() => import('./routes/attachments.js'));
const clientErrorsRoutes = createLazyRouter(() => import('./routes/clientErrors.js'));
const autoFixMetricsRoutes = createLazyRouter(() => import('./routes/autoFixMetrics.js'));
const uploadsRoutes = createLazyRouter(() => import('./routes/uploads.js'));
const agentsRoutes = createLazyRouter(() => import('./routes/agents.js'));
const cosRoutes = createLazyRouter(() => import('./routes/cos.js'));
const featureAgentsRoutes = createLazyRouter(() => import('./routes/featureAgents.js'));
const memoryRoutes = createLazyRouter(() => import('./routes/memory.js'));
const userActionsRoutes = createLazyRouter(() => import('./routes/userActions.js'));
const skillsRoutes = createLazyRouter(() => import('./routes/skills.js'));
const apiDocsRoutes = createLazyRouter(() => import('./routes/apiDocs.js'));
const browserRoutes = createLazyRouter(() => import('./routes/browser.js'));
const backupRoutes = createLazyRouter(() => import('./routes/backup.js'));
const eidoverseWorldRoutes = createLazyRouter(() => import('./routes/eidoverseWorldRoutes.js'));
const eidoverseTravelRoutes = createLazyRouter(() => import('./routes/eidoverseTravelRoutes.js'));
const databaseRoutes = createLazyRouter(() => import('./routes/database.js'));
const localLlmRoutes = createLazyRouter(() => import('./routes/localLlm.js'));
const codeReviewRoutes = createLazyRouter(() => import('./routes/codeReview.js'));
const searchRoutes = createLazyRouter(() => import('./routes/search.js'));
const dataSyncRoutes = createLazyRouter(() => import('./routes/dataSync.js'));
const instancesRoutes = createLazyRouter(() => import('./routes/instances.js'));
const settingsRoutes = createLazyRouter(() => import('./routes/settings.js'));
const updateRoutes = createLazyRouter(() => import('./routes/update.js'));
const mediaJobsRoutes = createLazyRouter(() => import('./routes/mediaJobs.js'));
const federatedMediaRoutes = createLazyRouter(() => import('./routes/federatedMedia.js'));
const peerAdministrationRoutes = createLazyRouter(() => import('./routes/peerAdministration.js'));
const peerAdminOperatorRoutes = createLazyRouter(() => import('./routes/peerAdminOperator.js'));
const humanActionRoutes = createLazyRouter(() => import('./routes/humanActions.js'));
const privacyRoutes = createLazyRouter(() => import('./routes/privacy.js'));
const dataMaintenanceRoutes = createLazyRouter(() => import('./routes/dataMaintenance.js'));
const sharingRoutes = createLazyRouter(() => import('./routes/sharing.js'));
const harnessRoutes = createLazyRouter(() => import('./routes/harnesses.js'));
const peerSyncRoutes = createLazyRouter(() => import('./routes/peerSync.js'));
const peerMediaRoutes = createLazyRouter(() => import('./routes/peerMedia.js'));
const remoteDesktopRoutes = createLazyRouter(() => import('./routes/remoteDesktop.js'));
const remoteDesktopViewerRoutes = createLazyRouter(() => import('./routes/remoteDesktopViewer.js'));
const agentPersonalitiesRoutes = createLazyRouter(() => import('./routes/agentPersonalities.js'));
const platformAccountsRoutes = createLazyRouter(() => import('./routes/platformAccounts.js'));
const automationSchedulesRoutes = createLazyRouter(() => import('./routes/automationSchedules.js'));
const agentActivityRoutes = createLazyRouter(() => import('./routes/agentActivity.js'));
const agentToolsRoutes = createLazyRouter(() => import('./routes/agentTools.js'));
const feedsRoutes = createLazyRouter(() => import('./routes/feeds.js'));
const gsdRoutes = createLazyRouter(() => import('./routes/gsd.js'));
const catalogRoutes = createLazyRouter(() => import('./routes/catalog.js'));
const catalogSheetRoutes = createLazyRouter(() => import('./routes/catalogSheets.js'));
const tribeRoutes = createLazyRouter(() => import('./routes/tribe.js'));
const timelineRoutes = createLazyRouter(() => import('./routes/timeline.js'));
const imessageRoutes = createLazyRouter(() => import('./routes/imessage.js'));
const contactsRoutes = createLazyRouter(() => import('./routes/contacts.js'));
const signalRoutes = createLazyRouter(() => import('./routes/signal.js'));
const beeperRoutes = createLazyRouter(() => import('./routes/beeper.js'));
const spotifyRoutes = createLazyRouter(() => import('./routes/spotify.js'));
const youtubeRoutes = createLazyRouter(() => import('./routes/youtube.js'));
const notificationsRoutes = createLazyRouter(() => import('./routes/notifications.js'));
const brainRoutes = createLazyRouter(() => import('./routes/brain.js'));
const brainImportRoutes = createLazyRouter(() => import('./routes/brainImport.js'));
const notesRoutes = createLazyRouter(() => import('./routes/notes.js'));
const mediaRoutes = createLazyRouter(() => import('./routes/media.js'));
const calendarRoutes = createLazyRouter(() => import('./routes/calendar.js'));
const messagesRoutes = createLazyRouter(() => import('./routes/messages.js'));
const stackerNewsRoutes = createLazyRouter(() => import('./routes/stackerNews.js'));
const xRoutes = createLazyRouter(() => import('./routes/x.js'));
const digitalTwinRoutes = createLazyRouter(() => import('./routes/digital-twin/index.js'));
const modelPersonalityRoutes = createLazyRouter(() => import('./routes/model-personality.js'));
const socialAccountsRoutes = createLazyRouter(() => import('./routes/socialAccounts.js'));
const lmstudioRoutes = createLazyRouter(() => import('./routes/lmstudio.js'));
const voiceRoutes = createLazyRouter(() => import('./routes/voice.js'));
const voicePublicRoutes = createLazyRouter(() => import('./routes/voicePublic.js'));
const moltworldToolsRoutes = createLazyRouter(() => import('./routes/moltworldTools.js'));
const moltworldWsRoutes = createLazyRouter(() => import('./routes/moltworldWs.js'));
const insightsRoutes = createLazyRouter(() => import('./routes/insights.js'));
const datadogRoutes = createLazyRouter(() => import('./routes/datadog.js'));
const dataManagerRoutes = createLazyRouter(() => import('./routes/dataManager.js'));
const jiraRoutes = createLazyRouter(() => import('./routes/jira.js'));
const autobiographyRoutes = createLazyRouter(() => import('./routes/autobiography.js'));
const legacyExportRoutes = createLazyRouter(() => import('./routes/legacyExport.js'));
const paletteRoutes = createLazyRouter(() => import('./routes/palette.js'));
const dashboardLayoutsRoutes = createLazyRouter(() => import('./routes/dashboardLayouts.js'));
const dashboardDailyActionsRoutes = createLazyRouter(() => import('./routes/dashboardDailyActions.js'));
const dailyDriverRoutes = createLazyRouter(() => import('./routes/dailyDriver.js'));
const mediaCollectionsRoutes = createLazyRouter(() => import('./routes/mediaCollections.js'));
const mediaAnnotationsRoutes = createLazyRouter(() => import('./routes/mediaAnnotations.js'));
const mediaSketchesRoutes = createLazyRouter(() => import('./routes/mediaSketches.js'));
const mediaHoldersRoutes = createLazyRouter(() => import('./routes/mediaHolders.js'));
const mediaUsageRoutes = createLazyRouter(() => import('./routes/mediaUsage.js'));
const identityRoutes = createLazyRouter(() => import('./routes/identity.js'));
const meatspaceRoutes = createLazyRouter(() => import('./routes/meatspace.js'));
const mortallomRoutes = createLazyRouter(() => import('./routes/mortalloom.js'));
const reviewRoutes = createLazyRouter(() => import('./routes/review.js'));
const githubRoutes = createLazyRouter(() => import('./routes/github.js'));
const telegramRoutes = createLazyRouter(() => import('./routes/telegram.js'));
const loopsRoutes = createLazyRouter(() => import('./routes/loops.js'));
const characterRoutes = createLazyRouter(() => import('./routes/character.js'));
const toolsRoutes = createLazyRouter(() => import('./routes/tools.js'));
const dockerContainmentRoutes = createLazyRouter(() => import('./routes/dockerContainment.js'));
const conflictJournalRoutes = createLazyRouter(() => import('./routes/conflictJournal.js'));
const openclawRoutes = createLazyRouter(() => import('./routes/openclaw.js'));
const roundsRoutes = createLazyRouter(() => import('./routes/rounds.js'));
const askRoutes = createLazyRouter(() => import('./routes/ask.js'));
const moaPresetRoutes = createLazyRouter(() => import('./routes/moaPresets.js'));
const appleHealthDaysRoutes = createLazyRouter(() => import('./routes/appleHealthDays.js'));
const appleHealthRoutes = createLazyRouter(() => import('./routes/appleHealth.js'));
const avatarRoutes = createLazyRouter(() => import('./routes/avatar.js'));
const imageCleanRoutes = createLazyRouter(() => import('./routes/imageClean.js'));
const genomeRoutes = createLazyRouter(() => import('./routes/genome.js'));
const rapidReaderRoutes = createLazyRouter(() => import('./routes/rapidReader.js'));
const imageGenRoutes = createLazyRouter(() => import('./routes/imageGen.js'));
const imageVerifierRoutes = createLazyRouter(() => import('./routes/imageVerifier.js'));
const videoGenRoutes = createLazyRouter(() => import('./routes/videoGen.js'));
const continuousVideoEpisodeRoutes = createLazyRouter(() => import('./routes/continuousVideoEpisode.js'));
const videoDownloadRoutes = createLazyRouter(() => import('./routes/videoDownload.js'));
const videoTimelineRoutes = createLazyRouter(() => import('./routes/videoTimeline.js'));
const htmlCompositionRoutes = createLazyRouter(() => import('./routes/htmlComposition.js'));
const creativeDirectorRoutes = createLazyRouter(() => import('./routes/creativeDirector.js'));
const creativeCommissionRoutes = createLazyRouter(() => import('./routes/creativeCommissions.js'));
const gamesRoutes = createLazyRouter(() => import('./routes/games.js'));
const fableLoomRoutes = createLazyRouter(() => import('./routes/fableLoom.js'));
const musicVideoRoutes = createLazyRouter(() => import('./routes/musicVideo.js'));
const musicVideoCharacterStyleRoutes = createLazyRouter(() => import('./routes/musicVideoCharacterStyles.js'));
const musicVideoCameoRoutes = createLazyRouter(() => import('./routes/musicVideoCameos.js'));
const spriteRoutes = createLazyRouter(() => import('./routes/sprites.js'));
const moodBoardRoutes = createLazyRouter(() => import('./routes/moodBoard.js'));
const storyboardRoutes = createLazyRouter(() => import('./routes/storyboards.js'));
const deckRoutes = createLazyRouter(() => import('./routes/decks.js'));
const threejsModelsRoutes = createLazyRouter(() => import('./routes/threejsModels.js'));
const htmlPagesRoutes = createLazyRouter(() => import('./routes/htmlPages.js'));
const filmStylesRoutes = createLazyRouter(() => import('./routes/filmStyles.js'));
const codeAnimationRoutes = createLazyRouter(() => import('./routes/codeAnimation.js'));
const codeAnimationExecutionRoutes = createLazyRouter(() => import('./routes/codeAnimationExecution.js'));
const imageTo3dRoutes = createLazyRouter(() => import('./routes/imageTo3d.js'));
const blenderModelsRoutes = createLazyRouter(() => import('./routes/blenderModels.js'));
const riggingRoutes = createLazyRouter(() => import('./routes/rigging.js'));
const writersRoomRoutes = createLazyRouter(() => import('./routes/writersRoom.js'));
const universeBuilderRoutes = createLazyRouter(() => import('./routes/universeBuilder/index.js'));
const authorsRoutes = createLazyRouter(() => import('./routes/authors.js'));
const artistsRoutes = createLazyRouter(() => import('./routes/artists.js'));
const albumsRoutes = createLazyRouter(() => import('./routes/albums.js'));
const tracksRoutes = createLazyRouter(() => import('./routes/tracks.js'));
const musicRoutes = createLazyRouter(() => import('./routes/music.js'));
const superColliderRoutes = createLazyRouter(() => import('./routes/superCollider.js'));
const pipelineRoutes = createLazyRouter(() => import('./routes/pipeline/index.js'));
const importerRoutes = createLazyRouter(() => import('./routes/importer.js'));
const storyBuilderRoutes = createLazyRouter(() => import('./routes/storyBuilder.js'));
const imageVideoModelsRoutes = createLazyRouter(() => import('./routes/imageVideoModels.js'));
const lorasRoutes = createLazyRouter(() => import('./routes/loras.js'));
const loraTrainingRoutes = createLazyRouter(() => import('./routes/loraTraining.js'));
const sdapiRoutes = createLazyRouter(() => import('./routes/sdapi.js'));
const midiRuntimeRoutes = createLazyRouter(() => import('./routes/midiRuntime.js'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || PORTS.API;
const HOST = process.env.HOST || '0.0.0.0';

// Delegates HTTPS / HTTP-mirror wiring to lib/tailscale-https.js — see there.
const { dir: CERT_DIR } = certPaths(PATHS.data);
const { server: httpServer, mirror: localHttpServer, httpsEnabled } =
  createTailscaleServers(app, { certDir: CERT_DIR });
setHttpsEnabledAtBoot(httpsEnabled);

// Socket.IO with relative path support for Tailscale
const io = new Server(httpServer, {
  destroyUpgrade: false,
  maxHttpBufferSize: SOCKET_MAX_PAYLOAD_BYTES,
  // CORS headers are reflected only for handshakes allowRequest admits: the
  // same browser-relay guard as the HTTP gate refuses a foreign Origin or a
  // rebindable Host on both the polling and websocket transports, in both
  // auth modes (a password-free install would otherwise take shell:start from
  // any web page). Origin-less native/peer clients pass through.
  cors: {
    origin: true,
    credentials: true
  },
  allowRequest: allowSocketRequest,
  path: '/socket.io'
});

// noVNC uses a standards-based WebSocket rather than Socket.IO. The broker
// accepts only short-lived session tokens issued by the authenticated API and
// forwards them to a VNC server on loopback; port 5900 is never selected from
// request input. Mount the HTTPS server and its optional loopback HTTP mirror.
remoteDesktopBroker.mountWebSocket(httpServer);
remoteDesktopBroker.mountWebSocket(localHttpServer);
// Viewer tokens obey the same revocation contract as every other session credential.
authEvents.on('sessions:revoked-all', () => remoteDesktopBroker.revokeAll('PortOS sessions revoked'));
// Eidoverse same-origin path + root allowlist (active only after the on-demand
// host starts). Upgrade for `/ws` and `/eidoverse-host/**` on both listeners.
mountEidoverseOnServer(null, [httpServer, localHttpServer]);
authEvents.on('sessions:revoked-all', closeEidoverseProxySockets);

// Close unclaimed upgrade sockets after a bounded timeout (replaces engine.io's
// destroyUpgrade timer so reverse proxies with slow upstreams aren't cut short).
installUpgradeFallback(httpServer);
installUpgradeFallback(localHttpServer);

// Auth gate for Socket.IO — when settings.secrets.auth.enabled is true the
// handshake must carry a valid token cookie or Authorization: Bearer header
// (set by POST /api/auth/login). No-op when auth is off.
io.use(socketAuthGate);
configureTailcatIngress({ app, io, certDir: CERT_DIR, httpsEnabled });

// Initialize socket handlers
initSocket(io);

// Build absolute paths - use centralized PATHS for data, __dirname for non-data paths
const DATA_DIR = PATHS.data;
const DATA_REFERENCE_DIR = join(__dirname, '..', 'data.reference');

// Pre-route boot: data migrations, collection schema verification, AI Toolkit
// construction + runner registration, spawner/autofixer/task-learning. Awaited
// (top-level await) because the toolkit-backed route factories below need the
// toolkit, and because migrations must land before any request can be served.
// See services/bootstrap.js for the ordering contract.
const { aiToolkit, spawnerReady } = await bootstrapServices({
  io,
  dataDir: DATA_DIR,
  dataReferenceDir: DATA_REFERENCE_DIR,
  serverDir: __dirname
});

// Middleware - allow any origin for Tailscale access
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Make io available to routes
app.use(httpCompression);
app.set('io', io);

// Auth gate runs BEFORE the body parsers so unauthenticated requests to
// gated routes are rejected from the headers alone, without forcing the
// server to read and parse a 55 MB JSON body first (DoS surface).
// Public routes (login, status, health) still need a parsed body / no body,
// and they flow through to the parsers below normally. When
// settings.secrets.auth.enabled is true the gate returns 401 for everything
// except the small public set in services/authGate.js (auth status/whoami/login/
// logout + /api/system/health). No-op when auth is off.
app.use(authGate);
// Every /api write and the sensitive GETs (lib/hostControlRoutes.js) additionally
// need operator authority: a session, or a local connection on a password-free install.
app.use(hostControlRouteGate);

// Eidoverse same-origin reverse-proxy (`/eidoverse-host` + root allowlist while
// the host is active). Must sit above express.json() / express.urlencoded() so
// mutating POST/PUT request body streams are not consumed before proxyHttpToEidoverse
// pipes them upstream (#12068), above mountAssetRoutes so the `/eidoverse-host`
// SERVER_OWNED terminator cannot 404 proxied paths, and above the SPA fallback
// so `/version` / `/ws` are not answered with PortOS index.html.
mountEidoverseOnServer(app);

// Body limit is set slightly above the 50MB combined base64 cap enforced by sendMessageSchema
// so the Zod validation (not the body parser) is the binding constraint for attachment payloads.
// Every per-file upload cap is derived from this value — see lib/uploadLimits.js.
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ limit: JSON_BODY_LIMIT, extended: true }));
app.use(defaultRequestBody);

// The viewer and vendored noVNC modules are outside /api so WKWebView can load
// them without persisting the user's PortOS password. The viewer URL itself is
// gated by the one-purpose session token created below.
app.use('/remote-desktop', remoteDesktopViewerRoutes);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/avatar', avatarRoutes);
app.use('/api/system', systemActivityRoutes);
app.use('/api/system', systemHealthRoutes);
app.use('/api/shell', shellBootstrapRoutes);
app.use('/api/system', maintenanceRoutes);
app.use('/api/system/capabilities', systemCapabilitiesRoutes);
app.use('/api/system-resources', systemResourcesRoutes);
app.use('/api/remote-desktop', remoteDesktopRoutes);
app.use('/api/capabilities', capabilitiesRoutes);
app.use('/api/agent-context', agentContextMcpRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/workspace-contexts', workspaceContextsRoutes);
app.use('/api/apps/:appId/reference-repos', referenceReposRoutes);
app.use('/api/ports', portsRoutes);
app.use('/api/network-exposure', networkExposureRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/scaffold', scaffoldRoutes);

// AI Toolkit routes with PortOS extensions
app.use('/api/provider-fallbacks', providerFallbackRoutes);
app.use('/api/providers/comparison', createModelComparisonRoutes());
app.use('/api/models/performance/task-benchmark', createModelPerformanceBenchmarkRoutes(aiToolkit.services.providers));
app.use('/api/providers', createPortOSProviderRoutes(aiToolkit, { syncProviderCatalogs: (providers) => syncLocalProviderModels({ providers }) }));
app.use('/api/runs', createPortOSRunsRoutes(aiToolkit));
app.use('/api/prompts', createPortOSPromptsRoutes(aiToolkit));

app.use('/api/history', historyRoutes);
app.use('/api/commands', commandsRoutes);
app.use('/api/git', gitRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/quota-burn', quotaBurnRoutes);
app.use('/api/screenshots', screenshotsRoutes);
app.use('/api/shell', shellRoutes);
app.use('/api/iterm', itermRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/rapid-reader', rapidReaderRoutes);
app.use('/api/palette', paletteRoutes);
app.use('/api/dashboard/layouts', dashboardLayoutsRoutes);
app.use('/api/dashboard/daily-actions', dashboardDailyActionsRoutes);
app.use('/api/daily-driver', dailyDriverRoutes);
app.use('/api/media/collections', mediaCollectionsRoutes);
app.use('/api/media/annotations', mediaAnnotationsRoutes);
app.use('/api/media/sketches', mediaSketchesRoutes);
app.use('/api/media/holders', mediaHoldersRoutes);
app.use('/api/media/usages', mediaUsageRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/client-errors', clientErrorsRoutes);
app.use('/api/autofix', autoFixMetricsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/legacy-export', legacyExportRoutes);
app.use('/api/eidoverse/world', eidoverseWorldRoutes);
app.use('/api/eidoverse/travel', eidoverseTravelRoutes);
app.use('/api/managed-visitors/v1', createManagedVisitorRoutes());
app.use('/api/managed-visitor-admin', createManagedVisitorAdminRoutes());
app.use('/api/database', databaseRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/image-clean', imageCleanRoutes);
// Agent Personalities feature routes (must be before /api/agents to avoid route conflicts)
app.use('/api/agents/personalities', agentPersonalitiesRoutes);
app.use('/api/agents/accounts', platformAccountsRoutes);
app.use('/api/agents/schedules', automationSchedulesRoutes);
app.use('/api/agents/activity', agentActivityRoutes);
app.use('/api/agents/tools/moltworld/ws', moltworldWsRoutes);
app.use('/api/agents/tools/moltworld', moltworldToolsRoutes);
app.use('/api/agents/tools', agentToolsRoutes);
// Existing running agents routes (process management)
app.use('/api/agents', agentsRoutes);
app.use('/api/cos/gsd', gsdRoutes);
app.use('/api/cos', cosRoutes);
app.use('/api/feature-agents', featureAgentsRoutes);
app.use('/api/feeds', feedsRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/catalog', catalogSheetRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/tribe', tribeRoutes);
app.use('/api/user-actions', userActionsRoutes);
app.use('/api/skills', skillsRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/imessage', imessageRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/signal', signalRoutes);
app.use('/api/beeper', beeperRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/brain/import', brainImportRoutes);
app.use('/api/brain', brainRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/stacker-news', stackerNewsRoutes);
app.use('/api/x', xRoutes);
app.use('/api/digital-twin/social-accounts', socialAccountsRoutes);
app.use('/api/meatspace/genome', genomeRoutes);
app.use('/api/digital-twin/identity', identityRoutes);
app.use('/api/digital-twin/autobiography', autobiographyRoutes);
app.use('/api/digital-twin', digitalTwinRoutes);
app.use('/api/model-personality', modelPersonalityRoutes);
app.use('/api/lmstudio', lmstudioRoutes);
app.use('/api/local-llm', localLlmRoutes);
app.use('/api/code-review', codeReviewRoutes);
// Public, externally-callable TTS surface. Mounted BEFORE the main voice
// router for readability; Express matches the more specific `/api/voice/public`
// regardless of order since `voiceRoutes` defines no `/public/*` paths. This
// mount is the only voice surface `authGate` will re-open when exposed — the
// main `/api/voice` router (config/whisper/etc.) stays fully gated.
app.use('/api/voice/public', voicePublicRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/api-docs', apiDocsRoutes);
app.use('/api/browser', browserRoutes);
app.use('/api/data', dataManagerRoutes);
app.use('/api/datadog', datadogRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/apple-health', appleHealthDaysRoutes);
app.use('/api/health', appleHealthRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/instances', instancesRoutes);
app.use('/api/sync', dataSyncRoutes);
app.use('/api/meatspace', meatspaceRoutes);
app.use('/api/mortalloom', mortallomRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/human-actions', humanActionRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/update', updateRoutes);
app.use('/api/loops', loopsRoutes);
app.use('/api/character', characterRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/image-gen', imageGenRoutes);
app.use('/api/image-verifier', imageVerifierRoutes);
app.use('/api/video-gen', videoGenRoutes);
app.use('/api/continuous-video', continuousVideoEpisodeRoutes);
app.use('/api/devtools/video-download', videoDownloadRoutes);
app.use('/api/video-timeline', videoTimelineRoutes);
app.use('/api/html-composition', htmlCompositionRoutes);
app.use('/api/media-jobs', mediaJobsRoutes);
app.use('/api/federation/media/v1', federatedMediaRoutes);
app.use('/api/federation/admin/v1', peerAdministrationRoutes);
app.use('/api/peer-administration', peerAdminOperatorRoutes);
app.use('/api/creative-director', creativeDirectorRoutes);
app.use('/api/creative-commission', creativeCommissionRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/fableloom', fableLoomRoutes);
// Before the project router so `/character-styles` is not read as a project id.
app.use('/api/music-video/character-styles', musicVideoCharacterStyleRoutes);
app.use('/api/music-video', musicVideoCameoRoutes);
app.use('/api/music-video', musicVideoRoutes);
app.use('/api/sprites', spriteRoutes);
app.use('/api/mood-boards', moodBoardRoutes);
app.use('/api/storyboards', storyboardRoutes);
app.use('/api/decks', deckRoutes);
app.use('/api/threejs-models', threejsModelsRoutes);
app.use('/api/html-pages', htmlPagesRoutes);
app.use('/api/film-styles', filmStylesRoutes);
app.use('/api/code-animation/execution', codeAnimationExecutionRoutes);
app.use('/api/code-animation', codeAnimationRoutes);
app.use('/api/image-to-3d', imageTo3dRoutes);
app.use('/api/blender-models', blenderModelsRoutes);
app.use('/api/rigging', riggingRoutes);
app.use('/api/privacy', privacyRoutes);
app.use('/api/writers-room', writersRoomRoutes);
app.use('/api/universe-builder', universeBuilderRoutes);
app.use('/api/authors', authorsRoutes);
app.use('/api/artists', artistsRoutes);
app.use('/api/albums', albumsRoutes);
app.use('/api/tracks', tracksRoutes);
app.use('/api/music/supercollider', superColliderRoutes);
app.use('/api/docker-containment', dockerContainmentRoutes);
app.use('/api/music', musicRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/conflict-journal', conflictJournalRoutes);
app.use('/api/importer', importerRoutes);
app.use('/api/story-builder', storyBuilderRoutes);
app.use('/api/image-video/models', imageVideoModelsRoutes);
app.use('/api/loras', lorasRoutes);
app.use('/api/data-maintenance', dataMaintenanceRoutes);
app.use('/api/lora-training', loraTrainingRoutes);
// AUTOMATIC1111-compatible surface for tailnet clients — gated by
// settings.imageGen.expose.a1111 so it returns 403 unless the user opted in.
app.use('/sdapi/v1', sdapiRoutes);
app.use('/api/openclaw', openclawRoutes);
app.use('/api/sharing', sharingRoutes);
app.use('/api/rounds', roundsRoutes);
app.use('/api/midi-runtime', midiRuntimeRoutes);
app.use('/api/harnesses', harnessRoutes);
app.use('/api/peer-sync', peerSyncRoutes);
app.use('/api/peer-media', peerMediaRoutes);
app.use('/api/ask', askRoutes);
app.use('/api/moa-presets', moaPresetRoutes);


// Asset static mounts, then a terminating 404 for every server-owned prefix so
// an extensionless `/data/…` or a mistyped `/api/…` can no longer fall through
// to the SPA fallback below and be answered with index.html and a 200 (#4688).
// Both lists live in lib/assetRoutePrefixes.js, which `scripts/dev-proxy-drift.test.js`
// reads as data. NOTE: this call installs a terminating 404 on `/api` and
// `/sdapi` too, so every router above must stay above — one added BELOW it is
// shadowed and never runs. That guard test holds the ordering.
mountAssetRoutes(app);

// Serve built client UI (production mode — no Vite dev server needed)
const CLIENT_DIST = join(__dirname, '..', 'client', 'dist');
if (existsSync(CLIENT_DIST)) {
  // Hashed `/assets/**` as immutable, the rest of dist/ revalidated per load,
  // and no index short-circuit on `/` — that path has to reach the splat
  // handler below so the meta-tag injection runs. See services/assetMounts.js.
  mountClientDist(app, CLIENT_DIST);
  // SPA fallback: serve index.html for page navigations only
  // Skip asset requests (.js, .css, etc.) so stale chunk requests get a proper 404
  // instead of index.html with text/html MIME type. We serve the stamped HTML
  // string (with <meta name="portos-build-id"> injected) instead of sendFile
  // so the bundled JS can read its own build id at boot. Re-read per request —
  // a `npm run build` between server start and the request rewrites index.html
  // with new chunk filenames; a stale snapshot would tell the browser to load
  // chunks that no longer exist on disk.
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.match(/\.\w+$/) && !req.path.endsWith('.html')) {
      return next();
    }
    // index.html embeds the current build's hashed asset filenames. After a
    // rebuild + restart, a browser still holding a cached copy would point at
    // chunks that no longer exist on disk (the `index-CwBEDqDF.css` class of
    // 404). `no-cache` lets the browser keep the file but forces an etag
    // revalidation on every navigation, so a fresh build is picked up on the
    // very next request without a hard refresh.
    res.set('Cache-Control', 'no-cache');
    const stampedIndexHtml = getStampedIndexHtml();
    if (stampedIndexHtml) {
      res.type('html').send(stampedIndexHtml);
    } else {
      res.sendFile(join(CLIENT_DIST, 'index.html'));
    }
  });
  console.log(`📦 Serving built UI from client/dist (build ${getBuildId()})`);
}

// 404 handler (API routes that didn't match)
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND'
  });
});

// Error middleware (must be last)
app.use(errorMiddleware);

// Warm the build-identity cache (one git spawn, no output) so the boot banner
// and the first socket handshake read it synchronously rather than waiting on
// git (#4694). Fire-and-forget and outside the request lifecycle, so it carries
// its own catch; nothing downstream depends on when it lands.
getBuildIdentity().catch((err) => console.error(`❌ Build identity probe failed: ${err.message}`));

// Install shutdown handlers before advertising readiness to the smoke parent.
registerShutdownHandlers({ io, httpServer, localHttpServer });
if (isSmokeBoot() && process.send) {
  httpServer.once('listening', () => {
    // The smoke binds port 0 (#12543); report the port the kernel assigned.
    process.send({ type: 'portos:smoke-ready', port: httpServer.address()?.port });
  });
}

// Post-route boot: background service inits + schedulers, then the ordered
// instance/sync/media-queue/DB chain that ends in httpServer.listen(). Not
// awaited — boot proceeds in the background and any fatal step exits the
// process itself. See services/bootstrap.js.
runBootSequence({ io, httpServer, localHttpServer, httpsEnabled, port: PORT, host: HOST, spawnerReady });

// Opt-in listener only: restores host configuration without generating tokens.
// The boot smoke (#8343) opens no listener beyond the API server it probes.
if (!isSmokeBoot()) {
  // Local runtime probes and public release metadata only; no installer or AI calls.
  import('./services/runtimeUpdateReview.js').then(({ startRuntimeUpdateReview }) => startRuntimeUpdateReview())
    .catch((err) => console.error(`❌ Runtime update checks could not start: ${err.message}`));
  // Event-driven notifications for parked Music Video runs (#10156); zero provider calls.
  import('./services/musicVideo/attentionNotifier.js').then(({ initMusicVideoAttentionNotifier }) => initMusicVideoAttentionNotifier())
    .catch((err) => console.error(`❌ Music video attention notifier could not start: ${err.message}`));
  // Reminders for scheduled human action steps (Brain threads); zero provider calls.
  import('./services/humanActionReminders.js').then(({ initHumanActionReminders }) => initHumanActionReminders())
    .catch((err) => console.error(`❌ Human action reminders could not start: ${err.message}`));
  import('./services/fleetLlmHost.js').then(({ startFleetLlmHost, describeFleetHostError }) => startFleetLlmHost().catch((err) => {
    console.error(`❌ Dedicated model host listener could not start (${describeFleetHostError(err)}); open AI Providers → Model host setup.`);
  }))
    .catch((err) => console.error(`❌ Dedicated model host listener could not load: ${err.message}`));
  // Local file scan only (no provider calls): keeps each provider app's own usage
  // history (Claude Code, Codex, Grok) current for the Usage report and peers
  // even when the usage page is never opened.
  Promise.resolve().then(() => startNativeUsageRefresh())
    .catch((err) => console.error(`❌ Native usage history refresh could not start: ${err.message}`));
}
