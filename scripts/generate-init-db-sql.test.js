import { describe, it, expect } from 'vitest';
import { renderInitDbSql, SCHEMA_MODULES_MARKER } from './generate-init-db-sql.js';

// The staleness check against the committed file lives in
// server/lib/db.ddlParity.test.js; this pins the rendering contract psql and
// node-postgres rely on when they run the file as one batch.
describe('renderInitDbSql', () => {
  const base = `-- about the base file\n\nCREATE TABLE IF NOT EXISTS memories (id INT);\n${SCHEMA_MODULES_MARKER}\nCREATE TRIGGER t AFTER UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION f();\n`;

  it('splices the module statements at the marker, each terminated by exactly one semicolon', () => {
    const sql = renderInitDbSql({ base, upgradeDdl: ['  CREATE TABLE a (id INT)  '], catalogDdl: ['CREATE TABLE b (id INT);\n'] });
    const body = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS memories'));
    expect(body).toBe('CREATE TABLE IF NOT EXISTS memories (id INT);\nCREATE TABLE a (id INT);\n\nCREATE TABLE b (id INT);\n'
      + 'CREATE TRIGGER t AFTER UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION f();\n');
    expect(sql).not.toContain('about the base file');
  });

  it('refuses a base without exactly one marker and a non-string statement', () => {
    expect(() => renderInitDbSql({ base: 'CREATE TABLE x (id INT);\n', upgradeDdl: [], catalogDdl: [] })).toThrow(/marker/);
    expect(() => renderInitDbSql({ base: `${base}${SCHEMA_MODULES_MARKER}\n`, upgradeDdl: [], catalogDdl: [] })).toThrow(/marker/);
    expect(() => renderInitDbSql({ base, upgradeDdl: [undefined], catalogDdl: [] })).toThrow(/non-empty SQL string/);
  });
});
