/** The existing fenced startup diagnostic, shared without importing a DB pool. */
export const DATABASE_MAINTENANCE_SCHEMA_CONTRACT = 'maintenance-target-v1';
export const DATABASE_MAINTENANCE_SCHEMA_SQL = `
      SELECT current_database() AS database, current_user AS "user",
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memories') AS has_memories,
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memory_links') AS has_links,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memories' AND column_name = 'sync_sequence') AS has_sync,
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'catalog_ingredients') AS has_catalog,
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'catalog_scraps') AS has_catalog_scraps
    `;

/** Presence only: this does not validate types, constraints, rows or all stores. */
export const databaseMaintenanceSchemaHealthy = health =>
  ['has_memories', 'has_links', 'has_sync', 'has_catalog', 'has_catalog_scraps'].every(key => health?.[key] === true);
