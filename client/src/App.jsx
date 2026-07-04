import { Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { getSettings, updateSettings, getSelfInstance } from './services/api';
import BrailleSpinner from './components/BrailleSpinner';
import { CatalogTypesProvider } from './hooks/useCatalogTypes.jsx';
import Dashboard from './pages/Dashboard';
import { lazyWithReload } from './utils/lazyWithReload';

// Neither /apps nor /ambient is the landing route, so keep them out of the eager
// entry chunk — lazy-load them like every other non-index page.
const Apps = lazyWithReload(() => import('./pages/Apps'));
const Ambient = lazyWithReload(() => import('./pages/Ambient'));

// Lazy load heavier pages for code splitting
// DevTools pages are large (~2300 lines total) so lazy load them
const AIProviders = lazyWithReload(() => import('./pages/AIProviders'));
const HistoryPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.HistoryPage })));
const RunsHistoryPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.RunsHistoryPage })));
const RunnerPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.RunnerPage })));
const UsagePage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.UsagePage })));
const ProcessesPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.ProcessesPage })));
const AgentsPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.AgentsPage })));
const DataDog = lazyWithReload(() => import('./pages/DataDog'));
const FlowsDoc = lazyWithReload(() => import('./pages/FlowsDoc'));
const GitHub = lazyWithReload(() => import('./pages/GitHub'));
const CyberCity = lazyWithReload(() => import('./pages/CyberCity'));
const AppDetail = lazyWithReload(() => import('./pages/AppDetail'));
const FeatureAgents = lazyWithReload(() => import('./pages/FeatureAgents'));
const FeatureAgentDetail = lazyWithReload(() => import('./pages/FeatureAgentDetail'));
const CalendarPage = lazyWithReload(() => import('./pages/Calendar'));
const Messages = lazyWithReload(() => import('./pages/Messages'));
const Tribe = lazyWithReload(() => import('./pages/Tribe'));
const Timeline = lazyWithReload(() => import('./pages/Timeline'));
const Goals = lazyWithReload(() => import('./pages/Goals'));
const OpenClawPage = lazyWithReload(() => import('./pages/OpenClaw'));
const Submodules = lazyWithReload(() => import('./pages/Submodules'));
const ImageClean = lazyWithReload(() => import('./pages/ImageClean'));
const VideoDownloaderPage = lazyWithReload(() => import('./pages/VideoDownloaderPage'));
const ChiefOfStaff = lazyWithReload(() => import('./pages/ChiefOfStaff'));
const Ask = lazyWithReload(() => import('./pages/Ask'));
const MediaGen = lazyWithReload(() => import('./pages/MediaGen'));
const ImageGen = lazyWithReload(() => import('./pages/ImageGen'));
const VideoGen = lazyWithReload(() => import('./pages/VideoGen'));
const MediaHistory = lazyWithReload(() => import('./pages/MediaHistory'));
const MediaAnnotate = lazyWithReload(() => import('./pages/MediaAnnotate'));
const MediaCollections = lazyWithReload(() => import('./pages/MediaCollections'));
const MediaCollectionDetail = lazyWithReload(() => import('./pages/MediaCollectionDetail'));
const MediaCollectionSyncView = lazyWithReload(() => import('./pages/MediaCollectionSyncView'));
const SyncView = lazyWithReload(() => import('./pages/SyncView'));
const MediaModels = lazyWithReload(() => import('./pages/MediaModels'));
const Loras = lazyWithReload(() => import('./pages/Loras'));
const LoraTraining = lazyWithReload(() => import('./pages/LoraTraining'));
const LoraDatasetDetail = lazyWithReload(() => import('./pages/LoraDatasetDetail'));
const UniverseBuilder = lazyWithReload(() => import('./pages/UniverseBuilder'));
const Universes = lazyWithReload(() => import('./pages/Universes'));
const Authors = lazyWithReload(() => import('./pages/Authors'));
const Music = lazyWithReload(() => import('./pages/Music'));
const Catalog = lazyWithReload(() => import('./pages/Catalog'));
const Rounds = lazyWithReload(() => import('./pages/Rounds'));
const RoundEditor = lazyWithReload(() => import('./pages/RoundEditor'));
const RoundsGuide = lazyWithReload(() => import('./pages/RoundsGuide'));
const CatalogIngest = lazyWithReload(() => import('./pages/CatalogIngest'));
const CatalogIngredient = lazyWithReload(() => import('./pages/CatalogIngredient'));
const VideoTimeline = lazyWithReload(() => import('./pages/VideoTimeline'));
const VideoTimelineEditor = lazyWithReload(() => import('./pages/VideoTimelineEditor'));
const CreativeDirector = lazyWithReload(() => import('./pages/CreativeDirector'));
const CreativeDirectorDetail = lazyWithReload(() => import('./pages/CreativeDirectorDetail'));
const MusicVideo = lazyWithReload(() => import('./pages/MusicVideo'));
const MoodBoards = lazyWithReload(() => import('./pages/MoodBoards'));
const MoodBoardDetail = lazyWithReload(() => import('./pages/MoodBoardDetail'));
const CreateApp = lazyWithReload(() => import('./pages/CreateApp'));
const Templates = lazyWithReload(() => import('./pages/Templates'));
const PromptManager = lazyWithReload(() => import('./pages/PromptManager'));
const Brain = lazyWithReload(() => import('./pages/Brain'));
const Security = lazyWithReload(() => import('./pages/Security'));
const DigitalTwin = lazyWithReload(() => import('./pages/DigitalTwin'));
const Agents = lazyWithReload(() => import('./pages/Agents'));
const Uploads = lazyWithReload(() => import('./pages/Uploads'));
const Settings = lazyWithReload(() => import('./pages/Settings'));
const LocalLlmPlayground = lazyWithReload(() => import('./pages/LocalLlmPlayground'));
const Shell = lazyWithReload(() => import('./pages/Shell'));
const BrowserPage = lazyWithReload(() => import('./pages/Browser'));
const Jira = lazyWithReload(() => import('./pages/Jira'));
const JiraReports = lazyWithReload(() => import('./pages/JiraReports'));
const DataManager = lazyWithReload(() => import('./pages/DataManager'));
const Insights = lazyWithReload(() => import('./pages/Insights'));
const Instances = lazyWithReload(() => import('./pages/Instances'));
const WorkspaceContexts = lazyWithReload(() => import('./pages/WorkspaceContexts'));
const SystemHealthPage = lazyWithReload(() => import('./pages/SystemHealthPage'));
const CapabilityMap = lazyWithReload(() => import('./pages/CapabilityMap'));
const MeatSpace = lazyWithReload(() => import('./pages/MeatSpace'));
const Post = lazyWithReload(() => import('./pages/Post'));
const Review = lazyWithReload(() => import('./pages/Review'));
const Loops = lazyWithReload(() => import('./pages/Loops'));
const CharacterSheet = lazyWithReload(() => import('./pages/CharacterSheet'));
const Wiki = lazyWithReload(() => import('./pages/Wiki'));
const RapidReaderPage = lazyWithReload(() => import('./pages/RapidReader'));
const WritersRoom = lazyWithReload(() => import('./pages/WritersRoom'));
const WritersRoomGuide = lazyWithReload(() => import('./pages/WritersRoomGuide'));
const Pipeline = lazyWithReload(() => import('./pages/Pipeline'));
const Sharing = lazyWithReload(() => import('./pages/Sharing'));
const Importer = lazyWithReload(() => import('./pages/Importer'));
const StartStory = lazyWithReload(() => import('./pages/StartStory'));
const StoryBuilder = lazyWithReload(() => import('./pages/StoryBuilder'));
const PipelineSeries = lazyWithReload(() => import('./pages/PipelineSeries'));
const PipelineSeriesRoadmap = lazyWithReload(() => import('./pages/PipelineSeriesRoadmap'));
const PipelineEditorialChecks = lazyWithReload(() => import('./pages/PipelineEditorialChecks'));
const PipelineFindingRedirect = lazyWithReload(() => import('./pages/PipelineFindingRedirect'));
const PipelineReverseOutline = lazyWithReload(() => import('./pages/PipelineReverseOutline'));
const PipelineContinuityBible = lazyWithReload(() => import('./pages/PipelineContinuityBible'));
const PipelineManuscriptEditor = lazyWithReload(() => import('./pages/PipelineManuscriptEditor'));
const PipelineIssue = lazyWithReload(() => import('./pages/PipelineIssue'));
const Login = lazyWithReload(() => import('./pages/Login'));

// Loading fallback for lazy-loaded pages
const PageLoader = () => (
  <div className="flex items-center justify-center h-64">
    <BrailleSpinner text="Loading" />
  </div>
);

// Preserve query string + hash when redirecting legacy routes — Settings.jsx's
// /image-gen?settings=1 chain depends on ?settings=1 reaching the new path, and
// legacy universe bookmarks may carry a hash (e.g. `#canon`) we must not drop.
function RedirectWithSearch({ to }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

// Canon page was folded into Universe Builder; redirect the old sub-route to
// the builder so deep-links and bookmarks keep working. Strips the trailing
// `/canon` (with optional trailing slash — React Router matches both forms,
// otherwise `/universes/abc/canon/` would self-loop), preserves the
// query string (e.g. `?series=<id>` filter), and adds `#canon` so the
// browser scrolls to the embedded canon section instead of the bible at the
// top of the builder (UniverseCanonSection renders with `id="canon"`).
function CanonRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={`${pathname.replace(/\/canon\/?$/, '')}${search}#canon`} replace />;
}

// Redirect a legacy universe mount to the current `/universes/*` route. Two
// legacy prefixes feed this: `/media/universe-builder` (MediaGen tab removed in
// favor of the Create sidebar link) and `/universe-builder` (page route renamed
// when the list/table index landed). Both keep old bookmarks + in-app
// deep-links alive. The canon variant forces `#canon` to scroll the embedded
// canon section; non-canon preserves whatever hash the user had.
function UniverseRouteRedirect({ fromPrefix, canon = false }) {
  const { pathname, search, hash } = useLocation();
  const rest = pathname.replace(fromPrefix, '');
  const target = canon
    ? `/universes${rest.replace(/\/canon\/?$/, '')}${search}#canon`
    : `/universes${rest}${search}${hash}`;
  return <Navigate to={target} replace />;
}

// Force full reload on HMR — partial hot-replacement of the route tree
// causes stale lazy imports and React Router errors on nested paths
if (import.meta.hot) {
  import.meta.hot.decline();
}

// Self-heal timezone on first load: the server process runs under TZ=UTC, so
// if settings.timezone was never set the server fallback resolves to UTC and
// date-scoped features (daily log, schedulers) land on the wrong day. Push
// the browser's IANA zone once so remote/VPN clients don't need to visit
// Settings before their first entry is correct.
function useTimezoneBootstrap() {
  useEffect(() => {
    getSettings().then((s) => {
      if (s?.timezone) return;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz || tz === 'UTC') return;
      return updateSettings({ timezone: tz });
    }).catch(() => null);
  }, []);
}

// Stamp the machine's instance name into the browser tab so multiple federated
// installs are distinguishable at a glance — "PortOS: {name}". Falls back to the
// static "PortOS" title (set in index.html) when the name is missing/unfetchable.
function useDocumentTitle() {
  useEffect(() => {
    getSelfInstance({ silent: true }).then((self) => {
      const name = self?.name?.trim();
      if (name) document.title = `PortOS: ${name}`;
    }).catch(() => null);
  }, []);
}

export default function App() {
  useTimezoneBootstrap();
  useDocumentTitle();
  return (
    <CatalogTypesProvider>
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/ambient" element={<Ambient />} />
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="apps" element={<Apps />} />
          <Route path="devtools" element={<Navigate to="/devtools/runs" replace />} />
          <Route path="devtools/datadog" element={<DataDog />} />
          <Route path="devtools/flows" element={<FlowsDoc />} />
          <Route path="devtools/github" element={<GitHub />} />
          <Route path="devtools/history" element={<HistoryPage />} />
          <Route path="devtools/image-clean" element={<ImageClean />} />
          <Route path="devtools/runs" element={<RunsHistoryPage />} />
          <Route path="devtools/runner" element={<RunnerPage />} />
          <Route path="devtools/submodules" element={<Submodules />} />
          <Route path="devtools/usage" element={<UsagePage />} />
          <Route path="devtools/video-download" element={<VideoDownloaderPage />} />
          <Route path="devtools/processes" element={<ProcessesPage />} />
          <Route path="devtools/agents" element={<AgentsPage />} />
          <Route path="ai" element={<AIProviders />} />
          <Route path="prompts" element={<PromptManager />} />
          <Route path="cos" element={<Navigate to="/cos/tasks" replace />} />
          <Route path="cos/:tab" element={<ChiefOfStaff />} />
          <Route path="calendar" element={<Navigate to="/calendar/agenda" replace />} />
          <Route path="calendar/:tab" element={<CalendarPage />} />
          <Route path="brain" element={<Navigate to="/brain/inbox" replace />} />
          <Route path="brain/:tab" element={<Brain />} />
          <Route path="digital-twin" element={<Navigate to="/digital-twin/overview" replace />} />
          <Route path="digital-twin/:tab" element={<DigitalTwin />} />
          <Route path="goals" element={<Navigate to="/goals/tree" replace />} />
          <Route path="goals/:tab" element={<Goals />} />
          <Route path="feature-agents" element={<FeatureAgents />} />
          <Route path="feature-agents/create" element={<FeatureAgentDetail />} />
          <Route path="feature-agents/:id" element={<Navigate to="overview" replace />} />
          <Route path="feature-agents/:id/:tab" element={<FeatureAgentDetail />} />
          <Route path="apps/create" element={<CreateApp />} />
          <Route path="apps/:appId" element={<AppDetail />} />
          <Route path="apps/:appId/:tab" element={<AppDetail />} />
          <Route path="templates" element={<Templates />} />
          <Route path="security" element={<Security />} />
          <Route path="settings" element={<Navigate to="/settings/backup" replace />} />
          <Route path="settings/:tab" element={<Settings />} />
          <Route path="local-llm/playground" element={<LocalLlmPlayground />} />
          <Route path="uploads" element={<Uploads />} />
          <Route path="shell" element={<Shell />} />
          <Route path="shell/:sessionId" element={<Shell />} />
          <Route path="browser" element={<BrowserPage />} />
          <Route path="insights" element={<Navigate to="/insights/overview" replace />} />
          <Route path="insights/:tab" element={<Insights />} />
          <Route path="instances" element={<Instances />} />
          <Route path="workspace-contexts" element={<WorkspaceContexts />} />
          <Route path="workspace-contexts/:appId" element={<WorkspaceContexts />} />
          <Route path="system-health" element={<SystemHealthPage />} />
          <Route path="capabilities" element={<CapabilityMap />} />
          <Route path="loops" element={<Loops />} />
          <Route path="meatspace" element={<Navigate to="/meatspace/overview" replace />} />
          <Route path="meatspace/:tab" element={<MeatSpace />} />
          <Route path="post" element={<Navigate to="/post/launcher" replace />} />
          <Route path="post/:tab" element={<Post />} />
          <Route path="post/:tab/:subtab" element={<Post />} />
          <Route path="review" element={<Review />} />
          <Route path="messages" element={<Navigate to="/messages/inbox" replace />} />
          <Route path="messages/:tab" element={<Messages />} />
          <Route path="tribe" element={<Tribe />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="timeline/:date" element={<Timeline />} />
          <Route path="openclaw" element={<OpenClawPage />} />
          <Route path="datadog" element={<Navigate to="/devtools/datadog" replace />} />
          <Route path="jira" element={<Navigate to="/devtools/jira" replace />} />
          <Route path="devtools/jira" element={<Jira />} />
          <Route path="devtools/jira/reports" element={<JiraReports />} />
          <Route path="city" element={<CyberCity />} />
          <Route path="city/settings" element={<CyberCity />} />
          <Route path="data" element={<DataManager />} />
          <Route path="character" element={<CharacterSheet />} />
          <Route path="ask" element={<Ask />} />
          <Route path="ask/:conversationId" element={<Ask />} />
          <Route path="media" element={<MediaGen />}>
            <Route index element={<Navigate to="/media/image" replace />} />
            <Route path="image" element={<ImageGen />} />
            <Route path="video" element={<VideoGen />} />
            <Route path="history" element={<MediaHistory />} />
            <Route path="annotate" element={<MediaAnnotate />} />
            <Route path="annotate/:mediaKey" element={<MediaAnnotate />} />
            <Route path="collections" element={<MediaCollections />} />
            <Route path="collections/:id" element={<MediaCollectionDetail />} />
            <Route path="collections/:id/sync" element={<MediaCollectionSyncView />} />
            <Route path="creative-director" element={<CreativeDirector />} />
            <Route path="creative-director/:id" element={<Navigate to="overview" replace />} />
            <Route path="creative-director/:id/:tab" element={<CreativeDirectorDetail />} />
            <Route path="music-video" element={<MusicVideo />} />
            <Route path="music-video/:projectId" element={<MusicVideo />} />
            <Route path="timeline" element={<VideoTimeline />} />
            <Route path="timeline/:projectId" element={<VideoTimelineEditor />} />
            <Route path="models" element={<MediaModels />} />
            <Route path="loras" element={<Loras />} />
            <Route path="training" element={<LoraTraining />} />
            <Route path="training/:datasetId" element={<LoraDatasetDetail />} />
            {/* Universes live at /universes (Create sidebar link). These
                redirects keep legacy /media/universe-builder bookmarks working
                after the MediaGen tab was removed. */}
            <Route path="universe-builder" element={<RedirectWithSearch to="/universes" />} />
            <Route path="universe-builder/:universeId" element={<UniverseRouteRedirect fromPrefix={/^\/media\/universe-builder/} />} />
            <Route path="universe-builder/:universeId/canon" element={<UniverseRouteRedirect fromPrefix={/^\/media\/universe-builder/} canon />} />
          </Route>
          <Route path="image-gen" element={<RedirectWithSearch to="/media/image" />} />
          <Route path="video-gen" element={<RedirectWithSearch to="/media/video" />} />
          <Route path="media-history" element={<RedirectWithSearch to="/media/history" />} />
          <Route path="media-models" element={<RedirectWithSearch to="/media/models" />} />
          <Route path="wiki" element={<Navigate to="/wiki/overview" replace />} />
          <Route path="wiki/:tab" element={<Wiki />} />
          <Route path="rapid-reader" element={<RapidReaderPage />} />
          {/* `/universes` is the universe index (list/table). The editor lives
              at `/universes/:universeId`; `new` is the create-mode sentinel
              (UniverseBuilder treats it as no-id → blank draft). Universe ids are
              UUIDs, so `new` can never collide with a real record. */}
          <Route path="rounds" element={<Rounds />} />
          <Route path="rounds/guide" element={<RoundsGuide />} />
          <Route path="rounds/:id" element={<RoundEditor />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="catalog/ingest" element={<CatalogIngest />} />
          <Route path="catalog/:type/:id" element={<CatalogIngredient />} />
          <Route path="mood-boards" element={<MoodBoards />} />
          <Route path="mood-boards/:id" element={<MoodBoardDetail />} />
          <Route path="universes" element={<Universes />} />
          <Route path="universes/new" element={<UniverseBuilder />} />
          <Route path="universes/:universeId" element={<UniverseBuilder />} />
          <Route path="universes/:universeId/sync" element={<SyncView kind="universe" param="universeId" backPath="/universes" />} />
          <Route path="universes/:universeId/canon" element={<CanonRedirect />} />
          {/* Legacy /universe-builder* → /universes* (route renamed when the
              index landed). Keeps old bookmarks + in-app deep-links working. */}
          <Route path="universe-builder" element={<RedirectWithSearch to="/universes" />} />
          <Route path="universe-builder/:universeId/canon" element={<UniverseRouteRedirect fromPrefix={/^\/universe-builder/} canon />} />
          <Route path="universe-builder/:universeId" element={<UniverseRouteRedirect fromPrefix={/^\/universe-builder/} />} />
          <Route path="universe-builder/new" element={<RedirectWithSearch to="/universes/new" />} />
          <Route path="writers-room" element={<WritersRoom />} />
          <Route path="writers-room/guide" element={<WritersRoomGuide />} />
          <Route path="sharing" element={<Sharing />} />
          <Route path="sharing/:section" element={<Sharing />} />
          <Route path="sharing/:section/:bucketId" element={<Sharing />} />
          <Route path="importer" element={<Importer />} />
          <Route path="start-story" element={<StartStory />} />
          <Route path="story-builder" element={<StoryBuilder />} />
          <Route path="story-builder/:storyId" element={<Navigate to="idea" replace />} />
          <Route path="story-builder/:storyId/:step" element={<StoryBuilder />} />
          {/* Authors is a single master-detail page: the index + editor share one
              component, so selection rides `:authorId` (which also captures the
              `new` create-mode sentinel — author ids are UUIDs, so it can't
              collide). A bare `/authors` is the idle index. */}
          <Route path="authors" element={<Authors />} />
          <Route path="authors/:authorId" element={<Authors />} />
          {/* Music is tabbed (`:tab`); each tab's master-detail selection lives
              at `/music/:tab/:id` (`new` = create sentinel). */}
          <Route path="music" element={<Music />} />
          <Route path="music/:tab" element={<Music />} />
          <Route path="music/:tab/:id" element={<Music />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="pipeline/editorial-checks" element={<PipelineEditorialChecks />} />
          <Route path="pipeline/findings/:commentId" element={<PipelineFindingRedirect />} />
          <Route path="pipeline/series/:seriesId" element={<PipelineSeries />} />
          <Route path="pipeline/series/:seriesId/roadmap" element={<PipelineSeriesRoadmap />} />
          <Route path="pipeline/series/:seriesId/reverse-outline" element={<PipelineReverseOutline />} />
          <Route path="pipeline/series/:seriesId/continuity-bible" element={<PipelineContinuityBible />} />
          {/* Splat (not a :param route) so navigating between issues reuses the
              same component instance instead of remounting + refetching. */}
          <Route path="pipeline/series/:seriesId/manuscript/*" element={<PipelineManuscriptEditor />} />
          <Route path="pipeline/series/:seriesId/sync" element={<SyncView kind="series" param="seriesId" backPath="/pipeline" />} />
          <Route path="pipeline/issues/:issueId" element={<Navigate to="idea" replace />} />
          <Route path="pipeline/issues/:issueId/:stage" element={<PipelineIssue />} />
          <Route path="writers-room/works/:workId" element={<WritersRoom />} />
          <Route path="agents" element={<Agents />} />
          <Route path="agents/:agentId" element={<Agents />} />
          <Route path="agents/:agentId/:tab" element={<Agents />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
    </CatalogTypesProvider>
  );
}
