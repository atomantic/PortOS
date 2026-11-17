import { Database, Brain, Timer, Target, Sword, Fingerprint, HeartPulse, Sparkles, Film, Images, Library, BookOpen, FilePen, Music, Music2, Disc3, Clapperboard, Palette, BookText, FolderTree, Video, Waypoints, Gauge, Spade } from 'lucide-react';

// Sync category metadata for UI display
export const SYNC_CATEGORY_META = [
  { key: 'brain', label: 'Brain', icon: Brain, description: 'People, projects, ideas, admin, memories, links' },
  { key: 'memory', label: 'Memory', icon: Database, description: 'CoS agent memories (PostgreSQL)' },
  { key: 'goals', label: 'Goals', icon: Target, description: 'Life goals, milestones, progress tracking' },
  { key: 'character', label: 'Character', icon: Sword, description: 'XP, HP, level, events, character sheet' },
  { key: 'digitalTwin', label: 'Digital Twin', icon: Fingerprint, description: 'Identity, taste, documents, autobiography, social accounts, personality traits, chronotype, longevity, feedback' },
  { key: 'meatspace', label: 'Meatspace', icon: HeartPulse, description: 'Daily logs, blood tests, body metrics, eyes' },
  { key: 'universe', label: 'Universe', icon: Sparkles, description: 'Universe Builder canon: characters, places, objects' },
  { key: 'pipeline', label: 'Pipeline', icon: Film, description: 'Series + issues record state (no image/video blobs)' },
  { key: 'mediaCollections', label: 'Media Collections', icon: Images, description: 'Per-universe/series image + video buckets, including the video metadata they need to render' },
  { key: 'storyBuilder', label: 'Story Builder', icon: BookOpen, description: 'Resumable Story Builder sessions you marked for cross-machine sync' },
  { key: 'usage', label: 'AI Usage Metrics', icon: Gauge, description: 'On by default. Aggregate AI usage counters — providers, models, token counts, estimated spend — so the Usage page totals your whole federation. No prompts, transcripts, or record contents. Turning it off stops PULLING this peer\u2019s usage; disable the peer to stop every direction.' },
  { key: 'fableLoom', label: 'FableLoom', icon: Waypoints, description: 'Branching stories, series plans, episode graphs, and rendered scene references' },
  { key: 'authors', label: 'Authors', icon: FilePen, description: 'Author personas + headshots used as series bylines (PostgreSQL)' },
  { key: 'artists', label: 'Artists', icon: Music, description: 'Music artist personas + portraits (PostgreSQL)' },
  { key: 'albums', label: 'Albums', icon: Disc3, description: 'Music albums + cover art and ordered track lists (PostgreSQL)' },
  { key: 'tracks', label: 'Tracks', icon: Music2, description: 'Music tracks + attached audio files (PostgreSQL)' },
  { key: 'creativeDirectorProjects', label: 'Creative Director', icon: Clapperboard, description: 'Creative Director projects: treatment, scenes, runs (PostgreSQL)' },
  { key: 'moodBoards', label: 'Mood Boards', icon: Palette, description: 'Mood boards: pinned image + text references (PostgreSQL)' },
  { key: 'writersRoomWorks', label: 'Writers Room', icon: BookText, description: 'Writers Room works: manuscripts + draft versions + prose bodies (PostgreSQL)' },
  { key: 'writersRoomFolders', label: 'Writers Room Folders', icon: FolderTree, description: 'Writers Room library folders: names + nesting (PostgreSQL)' },
  { key: 'writersRoomExercises', label: 'Writers Room Sprints', icon: Timer, description: 'Writers Room writing-sprint sessions + appended prose (PostgreSQL)' },
  { key: 'musicVideoProjects', label: 'Music Video', icon: Video, description: 'Music Video projects: director board + beat-aligned scenes (PostgreSQL)' },
  { key: 'creativeCommissions', label: 'Commissions', icon: Target, description: 'Creative Commission briefs (name + intent + genre + generation settings) — the schedule + run history stay machine-local (PostgreSQL)' },
  { key: 'commissionFeedback', label: 'Commission Feedback', icon: Target, description: 'Creative Commission taste reactions that steer the next run — the schedule stays machine-local (PostgreSQL)' },
  { key: 'decks', label: 'Decks', icon: Spade, description: 'Card decks: style guide, samples, per-card prompts + rendered card art — the image/LLM pins stay machine-local (PostgreSQL)' },
  { key: 'storyboards', label: 'Storyboards', icon: Clapperboard, description: 'Storyboards: beats, panels, panel-maker recipes and gallery-image art — sketch drawings and in-flight renders stay machine-local (PostgreSQL)' },
  { key: 'catalog', label: 'Catalog', icon: Library, description: 'Creative ingredients catalog: orphan ingredients + ref links (PostgreSQL)' }
];

// Snapshot categories — exclude the per-record / delta-based categories that
// have no 60s snapshot checksum: brain + memory (delta), catalog, and creative
// record kinds handled by the per-record peer-push pipeline.
const NON_SNAPSHOT_KEYS = new Set(['brain', 'memory', 'catalog', 'authors', 'artists', 'albums', 'tracks', 'creativeDirectorProjects', 'moodBoards', 'fableLoom', 'writersRoomWorks', 'writersRoomFolders', 'writersRoomExercises', 'musicVideoProjects', 'commissionFeedback', 'creativeCommissions', 'decks', 'storyboards']);
export const SNAPSHOT_CATEGORIES = SYNC_CATEGORY_META.filter(m => !NON_SNAPSHOT_KEYS.has(m.key));

// Video-history rows have no toggle of their own: they are the metadata half of
// Media Collections, so that one switch drives both keys (server-side
// `mediaCollections` already implies `videoHistory`; a legacy peer with only
// `videoHistory` on reads as on here, and turning the row off clears both).
export const MEDIA_COLLECTION_KEYS = ['mediaCollections', 'videoHistory'];
export const isCategoryOn = (categories, key) => (key === 'mediaCollections'
  ? MEDIA_COLLECTION_KEYS.some(k => categories[k])
  : Boolean(categories[key]));

// How bytes for a synced Media Collection reach this machine. Mirrors the
// server's MEDIA_SYNC_MODES (services/instances.js).
export const MEDIA_SYNC_MODE_OPTIONS = [
  { value: 'copy', label: 'Copy', description: 'Download every image/video onto this machine (uses local disk, works offline)' },
  { value: 'host', label: 'Host on peer', description: 'Keep references only and stream files from the peer on demand (no local copy)' },
];
