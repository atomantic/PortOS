import express from 'express';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PATHS } from './lib/fileUtils.js';
import { existsSync } from 'fs';
import { createTailscaleServers } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';
import { getBuildId, getStampedIndexHtml } from './lib/buildId.js';

import alertsRoutes from './routes/alerts.js';
import appleHealthRoutes from './routes/appleHealth.js';
import avatarRoutes from './routes/avatar.js';
import systemHealthRoutes from './routes/systemHealth.js';
import capabilitiesRoutes from './routes/capabilities.js';
import appsRoutes from './routes/apps/index.js';
import workspaceContextsRoutes from './routes/workspaceContexts.js';
import referenceReposRoutes from './routes/referenceRepos.js';
import portsRoutes from './routes/ports.js';
import networkExposureRoutes from './routes/networkExposure.js';
import logsRoutes from './routes/logs.js';
import detectRoutes from './routes/detect.js';
import scaffoldRoutes from './routes/scaffold.js';
import historyRoutes from './routes/history.js';
import commandsRoutes from './routes/commands.js';
import gitRoutes from './routes/git.js';
import usageRoutes from './routes/usage.js';
import screenshotsRoutes from './routes/screenshots.js';
import attachmentsRoutes from './routes/attachments.js';
import clientErrorsRoutes from './routes/clientErrors.js';
import autoFixMetricsRoutes from './routes/autoFixMetrics.js';
import uploadsRoutes from './routes/uploads.js';
import imageCleanRoutes from './routes/imageClean.js';
import agentsRoutes from './routes/agents.js';
import agentPersonalitiesRoutes from './routes/agentPersonalities.js';
import platformAccountsRoutes from './routes/platformAccounts.js';
import automationSchedulesRoutes from './routes/automationSchedules.js';
import agentActivityRoutes from './routes/agentActivity.js';
import agentToolsRoutes from './routes/agentTools.js';
import cosRoutes from './routes/cos.js';
import featureAgentsRoutes from './routes/featureAgents.js';
import feedsRoutes from './routes/feeds.js';
import gsdRoutes from './routes/gsd.js';
import catalogRoutes from './routes/catalog.js';
import memoryRoutes from './routes/memory.js';
import tribeRoutes from './routes/tribe.js';
import timelineRoutes from './routes/timeline.js';
import imessageRoutes from './routes/imessage.js';
import contactsRoutes from './routes/contacts.js';
import signalRoutes from './routes/signal.js';
import spotifyRoutes from './routes/spotify.js';
import youtubeRoutes from './routes/youtube.js';
import notificationsRoutes from './routes/notifications.js';
import standardizeRoutes from './routes/standardize.js';
import brainRoutes from './routes/brain.js';
import brainImportRoutes from './routes/brainImport.js';
import notesRoutes from './routes/notes.js';
import mediaRoutes from './routes/media.js';
import calendarRoutes from './routes/calendar.js';
import messagesRoutes from './routes/messages.js';
import genomeRoutes from './routes/genome.js';
import digitalTwinRoutes from './routes/digital-twin/index.js';
import modelPersonalityRoutes from './routes/model-personality.js';
import socialAccountsRoutes from './routes/socialAccounts.js';
import lmstudioRoutes from './routes/lmstudio.js';
import voiceRoutes from './routes/voice.js';
import voicePublicRoutes from './routes/voicePublic.js';
import apiDocsRoutes from './routes/apiDocs.js';
import browserRoutes from './routes/browser.js';
import moltworldToolsRoutes from './routes/moltworldTools.js';
import moltworldWsRoutes from './routes/moltworldWs.js';
import insightsRoutes from './routes/insights.js';
import datadogRoutes from './routes/datadog.js';
import dataManagerRoutes from './routes/dataManager.js';
import jiraRoutes from './routes/jira.js';
import autobiographyRoutes from './routes/autobiography.js';
import backupRoutes from './routes/backup.js';
import legacyExportRoutes from './routes/legacyExport.js';
import cityRoutes from './routes/cityRoutes.js';
import databaseRoutes from './routes/database.js';
import localLlmRoutes from './routes/localLlm.js';
import codeReviewRoutes from './routes/codeReview.js';
import searchRoutes from './routes/search.js';
import paletteRoutes from './routes/palette.js';
import dashboardLayoutsRoutes from './routes/dashboardLayouts.js';
import dailyDriverRoutes from './routes/dailyDriver.js';
import mediaCollectionsRoutes from './routes/mediaCollections.js';
import mediaAnnotationsRoutes from './routes/mediaAnnotations.js';
import mediaSketchesRoutes from './routes/mediaSketches.js';
import dataSyncRoutes from './routes/dataSync.js';
import identityRoutes from './routes/identity.js';
import instancesRoutes from './routes/instances.js';
import meatspaceRoutes from './routes/meatspace.js';
import mortallomRoutes from './routes/mortalloom.js';
import reviewRoutes from './routes/review.js';
import githubRoutes from './routes/github.js';
import settingsRoutes from './routes/settings.js';
import authRoutes from './routes/auth.js';
import { authGate, socketAuthGate } from './lib/authGate.js';
import telegramRoutes from './routes/telegram.js';
import updateRoutes from './routes/update.js';
import loopsRoutes from './routes/loops.js';
import characterRoutes from './routes/character.js';
import toolsRoutes from './routes/tools.js';
import imageGenRoutes from './routes/imageGen.js';
import videoGenRoutes from './routes/videoGen.js';
import videoDownloadRoutes from './routes/videoDownload.js';
import videoTimelineRoutes from './routes/videoTimeline.js';
import mediaJobsRoutes from './routes/mediaJobs.js';
import creativeDirectorRoutes from './routes/creativeDirector.js';
import creativeCommissionRoutes from './routes/creativeCommissions.js';
import musicVideoRoutes from './routes/musicVideo.js';
import spriteRoutes from './routes/sprites.js';
import moodBoardRoutes from './routes/moodBoard.js';
import threejsModelsRoutes from './routes/threejsModels.js';
import privacyRoutes from './routes/privacy.js';
import writersRoomRoutes from './routes/writersRoom.js';
import universeBuilderRoutes from './routes/universeBuilder.js';
import authorsRoutes from './routes/authors.js';
import artistsRoutes from './routes/artists.js';
import albumsRoutes from './routes/albums.js';
import tracksRoutes from './routes/tracks.js';
import musicRoutes from './routes/music.js';
import conflictJournalRoutes from './routes/conflictJournal.js';
import pipelineRoutes from './routes/pipeline/index.js';
import importerRoutes from './routes/importer.js';
import storyBuilderRoutes from './routes/storyBuilder.js';
import imageVideoModelsRoutes from './routes/imageVideoModels.js';
import lorasRoutes from './routes/loras.js';
import loraDatasetsRoutes from './routes/loraDatasets.js';
import loraTrainingRoutes from './routes/loraTraining.js';
import sdapiRoutes from './routes/sdapi.js';
import openclawRoutes from './routes/openclaw.js';
import sharingRoutes from './routes/sharing.js';
import roundsRoutes from './routes/rounds.js';
import midiRuntimeRoutes from './routes/midiRuntime.js';
import peerSyncRoutes from './routes/peerSync.js';
import askRoutes from './routes/ask.js';
import { initSocket } from './services/socket.js';
import { bootstrapServices, runBootSequence, registerShutdownHandlers } from './services/bootstrap.js';
import { errorMiddleware } from './lib/errorHandler.js';
import { setHttpsEnabledAtBoot } from './lib/httpsState.js';
import { wrWorksDir } from './services/writersRoom/_shared.js';
import { createPortOSProviderRoutes } from './routes/providers.js';
import { createPortOSRunsRoutes } from './routes/runs.js';
import { createPortOSPromptsRoutes } from './routes/prompts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5555;
const HOST = process.env.HOST || '0.0.0.0';

// Delegates HTTPS / HTTP-mirror wiring to lib/tailscale-https.js — see there.
const { dir: CERT_DIR } = certPaths(PATHS.data);
const { server: httpServer, mirror: localHttpServer, httpsEnabled } =
  createTailscaleServers(app, { certDir: CERT_DIR });
setHttpsEnabledAtBoot(httpsEnabled);

// Socket.IO with relative path support for Tailscale
const io = new Server(httpServer, {
  cors: {
    origin: true, // Allow any origin (local network only)
    credentials: true
  },
  path: '/socket.io'
});

// Auth gate for Socket.IO — when settings.secrets.auth.enabled is true the
// handshake must carry a valid token cookie or Authorization: Bearer header
// (set by POST /api/auth/login). No-op when auth is off.
io.use(socketAuthGate);

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
app.set('io', io);

// Auth gate runs BEFORE the body parsers so unauthenticated requests to
// gated routes are rejected from the headers alone, without forcing the
// server to read and parse a 55 MB JSON body first (DoS surface).
// Public routes (login, status, health) still need a parsed body / no body,
// and they flow through to the parsers below normally. When
// settings.secrets.auth.enabled is true the gate returns 401 for everything
// except the small public set in lib/authGate.js (auth status/whoami/login/
// logout + /api/system/health). No-op when auth is off.
app.use(authGate);

// Body limit is set slightly above the 50MB combined base64 cap enforced by sendMessageSchema
// so the Zod validation (not the body parser) is the binding constraint for attachment payloads.
app.use(express.json({ limit: '55mb' }));
app.use(express.urlencoded({ limit: '55mb', extended: true }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/avatar', avatarRoutes);
app.use('/api/system', systemHealthRoutes);
app.use('/api/capabilities', capabilitiesRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/workspace-contexts', workspaceContextsRoutes);
app.use('/api/apps/:appId/reference-repos', referenceReposRoutes);
app.use('/api/ports', portsRoutes);
app.use('/api/network-exposure', networkExposureRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/detect', detectRoutes);
app.use('/api/scaffold', scaffoldRoutes);

// AI Toolkit routes with PortOS extensions
app.use('/api/providers', createPortOSProviderRoutes(aiToolkit));
app.use('/api/runs', createPortOSRunsRoutes(aiToolkit));
app.use('/api/prompts', createPortOSPromptsRoutes(aiToolkit));

app.use('/api/history', historyRoutes);
app.use('/api/commands', commandsRoutes);
app.use('/api/git', gitRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/screenshots', screenshotsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/palette', paletteRoutes);
app.use('/api/dashboard/layouts', dashboardLayoutsRoutes);
app.use('/api/daily-driver', dailyDriverRoutes);
app.use('/api/media/collections', mediaCollectionsRoutes);
app.use('/api/media/annotations', mediaAnnotationsRoutes);
app.use('/api/media/sketches', mediaSketchesRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/client-errors', clientErrorsRoutes);
app.use('/api/autofix', autoFixMetricsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/legacy-export', legacyExportRoutes);
app.use('/api/city', cityRoutes);
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
app.use('/api/memory', memoryRoutes);
app.use('/api/tribe', tribeRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/imessage', imessageRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/signal', signalRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/standardize', standardizeRoutes);
app.use('/api/brain/import', brainImportRoutes);
app.use('/api/brain', brainRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/messages', messagesRoutes);
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
app.use('/api/health', appleHealthRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/instances', instancesRoutes);
app.use('/api/sync', dataSyncRoutes);
app.use('/api/meatspace', meatspaceRoutes);
app.use('/api/mortalloom', mortallomRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/update', updateRoutes);
app.use('/api/loops', loopsRoutes);
app.use('/api/character', characterRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/image-gen', imageGenRoutes);
app.use('/api/video-gen', videoGenRoutes);
app.use('/api/devtools/video-download', videoDownloadRoutes);
app.use('/api/video-timeline', videoTimelineRoutes);
app.use('/api/media-jobs', mediaJobsRoutes);
app.use('/api/creative-director', creativeDirectorRoutes);
app.use('/api/creative-commission', creativeCommissionRoutes);
app.use('/api/music-video', musicVideoRoutes);
app.use('/api/sprites', spriteRoutes);
app.use('/api/mood-boards', moodBoardRoutes);
app.use('/api/threejs-models', threejsModelsRoutes);
app.use('/api/privacy', privacyRoutes);
app.use('/api/writers-room', writersRoomRoutes);
app.use('/api/universe-builder', universeBuilderRoutes);
app.use('/api/authors', authorsRoutes);
app.use('/api/artists', artistsRoutes);
app.use('/api/albums', albumsRoutes);
app.use('/api/tracks', tracksRoutes);
app.use('/api/music', musicRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/conflict-journal', conflictJournalRoutes);
app.use('/api/importer', importerRoutes);
app.use('/api/story-builder', storyBuilderRoutes);
app.use('/api/image-video/models', imageVideoModelsRoutes);
app.use('/api/loras', lorasRoutes);
app.use('/api/lora-datasets', loraDatasetsRoutes);
app.use('/api/lora-training', loraTrainingRoutes);
// AUTOMATIC1111-compatible surface for tailnet clients — gated by
// settings.imageGen.expose.a1111 so it returns 403 unless the user opted in.
app.use('/sdapi/v1', sdapiRoutes);
app.use('/api/openclaw', openclawRoutes);
app.use('/api/sharing', sharingRoutes);
app.use('/api/rounds', roundsRoutes);
app.use('/api/midi-runtime', midiRuntimeRoutes);
app.use('/api/peer-sync', peerSyncRoutes);
app.use('/api/ask', askRoutes);

// Asset static mounts. `acceptRanges: true` is the serve-static default
// already, but we set it explicitly because the federated peer-sync receiver
// (services/sharing/peerSync.js) background-pulls missing assets from these
// URLs and relies on HTTP Range to resume partial downloads over flaky
// Tailnet links — losing range support here would silently force every
// retry to restart from byte 0 on a multi-MB PNG / video. Same posture for
// every kind below (image, image-ref, video, video-thumbnail).
const ASSET_STATIC_OPTS = { acceptRanges: true };
app.use('/data/images', express.static(PATHS.images, ASSET_STATIC_OPTS));
// Reference images (multi-ref upload inputs + generated character reference
// sheets) — served read-only so the UI can render thumbnails by URL.
app.use('/data/image-refs', express.static(PATHS.imageRefs, ASSET_STATIC_OPTS));
// LoRA training dataset images (lora-datasets/<id>/images/*.png).
app.use('/data/lora-datasets', express.static(PATHS.loraDatasets, ASSET_STATIC_OPTS));
// Serve generated videos + thumbnails so the Media UI and tailnet clients
// can pull them by URL without going through an explicit download route.
app.use('/data/videos', express.static(PATHS.videos, ASSET_STATIC_OPTS));
app.use('/data/video-thumbnails', express.static(PATHS.videoThumbnails, ASSET_STATIC_OPTS));
// Sprite Manager library previews (anchors, strips, atlases) render inline
// via <img src="/data/sprites/<id>/<rel>"> (#2895).
app.use('/data/sprites', express.static(PATHS.sprites, ASSET_STATIC_OPTS));
// Voice-over WAVs rendered by the pipeline audio stage — the AudioStage UI
// pulls them inline via <audio src="/data/audio/<filename>">.
app.use('/data/audio', express.static(PATHS.audio));
// Background-music tracks (uploaded today, generated locally tomorrow). The
// AudioStage music picker plays them inline via <audio src="/data/music/...">.
app.use('/data/music', express.static(PATHS.music));
// Extracted third-party import assets (ChatGPT export images/audio/PDFs). The
// Brain Memory conversation viewer renders these inline (`![](/data/brain-
// imports/...)`) and as asset links. Read-only; range support for large PDFs.
app.use('/data/brain-imports', express.static(PATHS.brainImportAssets, ASSET_STATIC_OPTS));
// Writers Room file-primary draft prose bodies (works/<workId>/drafts/<draftId>.md).
// Federation (#1565) pulls them peer→peer from this mount: a receiver that merged
// a work record GETs each missing body's bytes by its nested path. Read-only;
// range support for large drafts. (Tailnet-only per the project's threat model.)
// The gate restricts the mount to the draft-body path ONLY — without it, the
// static root would also serve adjacent work-metadata JSON (manifest.json /
// manifest.imported.json on file-backend/migrated installs) to any client that
// knows a work id. Only `<workId>/drafts/<draftId>.md` is needed for body pulls.
app.use('/data/writers-room/works', (req, res, next) => {
  if (!/^\/[^/]+\/drafts\/[^/]+\.md$/.test(req.path)) return res.status(404).end();
  next();
}, express.static(wrWorksDir(), ASSET_STATIC_OPTS));

// Serve built client UI (production mode — no Vite dev server needed)
const CLIENT_DIST = join(__dirname, '..', 'client', 'dist');
if (existsSync(CLIENT_DIST)) {
  // `index: false` keeps express.static from short-circuiting `/` (and any
  // bare directory) with the raw index.html — that path needs to flow through
  // the splat handler below so the meta-tag injection runs.
  app.use(express.static(CLIENT_DIST, { index: false }));
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

// Post-route boot: background service inits + schedulers, then the ordered
// instance/sync/media-queue/DB chain that ends in httpServer.listen(). Not
// awaited — boot proceeds in the background and any fatal step exits the
// process itself. See services/bootstrap.js.
runBootSequence({ io, httpServer, localHttpServer, httpsEnabled, port: PORT, host: HOST, spawnerReady });

registerShutdownHandlers({ io, httpServer, localHttpServer });
