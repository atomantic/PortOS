-- 030 — drop the native-usage tables retired by #15277 (#15363).
-- v2.113.0 created them; the restore preflight refuses any public table the
-- current DDL does not declare, so leftovers blocked every database restore.
DROP TABLE IF EXISTS native_usage_snapshots, native_usage_sources RESTRICT;
