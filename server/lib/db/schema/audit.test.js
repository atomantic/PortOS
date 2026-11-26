/**
 * Classification guard (#17470): every Postgres table created by the schema
 * modules must be either audited (record_audit deletion/tombstone trigger) or
 * explicitly listed here as unaudited with a reason. A new user-authored table
 * that is silently left out of `auditedTables` leaves wrongful deletes with no
 * recoverable row_snapshot, so adding a table forces a conscious choice.
 */
import { describe, it, expect } from 'vitest';
import { buildUpgradeDdl, buildCatalogDdl, auditedTables } from './index.js';

// Intentionally NOT audited. Grouped by why a plaintext row_snapshot is wrong
// or pointless. Privacy tables hold encrypted PII that must never be copied
// into record_audit.
const UNAUDITED_PRIVACY = [
  'privacy_subjects', 'privacy_vault_records', 'privacy_consents', 'privacy_orgs',
  'privacy_org_holdings', 'privacy_brokers', 'privacy_broker_cases', 'privacy_change_events',
];
const UNAUDITED_SYSTEM = [
  // Audit/sync/migration infrastructure
  'record_audit', 'sync_feed', 'memory_tombstones', 'schema_migrations', 'restore_receipts',
  'catalog_commit_receipts', 'catalog_pending_applies', 'catalog_identity_operations',
  'peer_execution_operations', 'peer_execution_generation_floors',
  // Derived links, versions, caches, cursors, ledgers
  'brain_memory_links', 'memory_versions', 'tribe_memory_links', 'app_quality_measurements',
  'usage_ledger_buckets', 'usage_ledger_markers', 'music_video_render_spend',
  'media_prompt_examinations', 'beeper_sync_cursors', 'beeper_reconcile_cursors',
  'github_notification_sync', 'github_notification_events', 'github_notification_audit_changes',
  'github_notification_audit_reports', 'catalog_ingredient_sources', 'catalog_ingredient_refs',
  'catalog_ingredient_relations', 'catalog_tags', 'catalog_ingredient_merges',
  'catalog_ingredient_revisions', 'catalog_ingredient_media',
  // Machine-local operational state, runs, renders and event streams
  'human_activity_events', 'post_runs', 'post_attempts', 'commission_feedback', 'user_action_events',
  'feature_usage_days',
  // Explicitly toggled local display preferences; unmute is intentional and re-creatable.
  'github_notification_mutes',
  'review_queue_triage', 'autonomous_job_notepads', 'cos_pending_agent_feedback',
  'cos_release_synchronizations', 'cos_tasks', 'cos_task_lists', 'cos_agents', 'cos_agent_store',
  'cos_branch_completion_policies', 'cos_branch_policy_archive', 'ai_connections',
  'ai_harness_bindings', 'ai_route_bindings', 'media_assets', 'code_animation_project_runs',
  'voice_profile_renders',
  // External mirrors (re-fetchable from the source service)
  'stacker_news_accounts', 'stacker_news_credentials', 'stacker_news_territories',
  'stacker_news_items', 'stacker_news_media', 'stacker_news_analyses', 'stacker_news_actions',
  'stacker_news_action_events', 'x_accounts', 'x_posts', 'x_drafts', 'beeper_accounts',
  'beeper_credentials', 'beeper_conversations', 'beeper_messages', 'beeper_participants',
  'beeper_attachments', 'beeper_outbox', 'github_notifications', 'github_notification_rules',
];
const UNAUDITED_TABLES = new Set([...UNAUDITED_PRIVACY, ...UNAUDITED_SYSTEM]);

const schemaTables = () => {
  const names = new Set();
  for (const stmt of [...buildUpgradeDdl(), ...buildCatalogDdl()]) {
    const m = /CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_0-9]+)/i.exec(stmt);
    if (m) names.add(m[1]);
  }
  return names;
};

describe('record_audit table classification (#17470)', () => {
  it('every schema table is audited or explicitly unaudited', () => {
    const unclassified = [...schemaTables()].filter(
      (t) => !auditedTables.includes(t) && !UNAUDITED_TABLES.has(t),
    );
    expect(unclassified, 'add to auditedTables (user-authored content) or UNAUDITED_TABLES with a reason').toEqual([]);
  });

  it('no table is both audited and unaudited, and no entry is stale', () => {
    const tables = schemaTables();
    expect(auditedTables.filter((t) => UNAUDITED_TABLES.has(t))).toEqual([]);
    expect([...UNAUDITED_TABLES].filter((t) => !tables.has(t))).toEqual([]);
    expect(auditedTables.filter((t) => !tables.has(t))).toEqual([]);
  });

  it('privacy tables are never audited (encrypted PII stays out of row_snapshot)', () => {
    expect(auditedTables.filter((t) => t.startsWith('privacy_'))).toEqual([]);
  });
});
