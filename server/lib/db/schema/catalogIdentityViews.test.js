import { describe, it, expect } from 'vitest';
import { buildCatalogIdentityViewsDdl, buildCatalogIdentityViewsPreludeDdl } from './catalogIdentityViews.js';
import { buildCatalogDdl } from './index.js';

// Regression for the #12762 boot crash: adding catalog_ingredient_media.library
// shifted the `(r).*` column list of catalog_identity_read_media and CREATE OR
// REPLACE VIEW refused ("cannot change name of view column").
describe('catalog identity view drift prelude', () => {
  it('guards every identity read view with a conditional drop', () => {
    const views = buildCatalogIdentityViewsDdl().map((sql) => /^CREATE OR REPLACE VIEW ([a-z_]+)/.exec(sql)[1]);
    const prelude = buildCatalogIdentityViewsPreludeDdl();
    expect(prelude).toHaveLength(views.length);
    views.forEach((view, i) => {
      expect(prelude[i]).toContain(`to_regclass('${view}')`);
      expect(prelude[i]).toContain(`DROP VIEW ${view};`);
      expect(prelude[i]).toContain('EXCEPT');
    });
    expect(prelude.find((sql) => sql.includes('catalog_identity_read_media'))).toContain("table_name = 'catalog_ingredient_media'");
  });

  it('runs the prelude before the views in ensureSchema', () => {
    const ddl = buildCatalogDdl();
    const dropAt = ddl.findIndex((sql) => sql.includes('DROP VIEW catalog_identity_read_media;'));
    const createAt = ddl.findIndex((sql) => sql.startsWith('CREATE OR REPLACE VIEW catalog_identity_read_media'));
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeLessThan(createAt);
  });
});
