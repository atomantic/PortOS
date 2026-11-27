-- The replacement indexes are present after ensureSchema(). Keep the index
-- drops in their own transaction so they never upgrade the backfill's row locks.
DROP INDEX IF EXISTS idx_creative_director_projects_live;
DROP INDEX IF EXISTS idx_music_video_projects_live;
DROP INDEX IF EXISTS idx_mood_boards_live;
DROP INDEX IF EXISTS idx_storyboards_live;
