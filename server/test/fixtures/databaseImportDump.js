// Synthetic SQL intentionally includes filter-shaped bytes in stored data.
export function databaseImportFixture() {
  const version = '\\restrict example\r\nSET transaction_timeout = 0;\r\n';
  const metadata = "DROP EXTENSION IF EXISTS vector;COMMENT ON EXTENSION vector IS 'legacy';";
  const preserved = `-- ordinary comment\r
DROP TABLE IF EXISTS example_record;\r
CREATE TABLE example_record (body text);\r
COPY example_record (body) FROM stdin;\r
DROP EXTENSION IF EXISTS vector;\r
COMMENT ON EXTENSION vector IS 'copy row';\r
SET transaction_timeout = 0;\r
\\restrict stored-data\r
${'x'.repeat(140000)}\r
\\.\r
SELECT 'multiline\r
DROP EXTENSION IF EXISTS vector;\r
SET transaction_timeout = 0;\r
';\r
CREATE FUNCTION example_sql() RETURNS text AS $body$\r
COMMENT ON EXTENSION vector IS 'function body';\r
$body$ LANGUAGE sql;\r
/* ordinary block comment: DROP EXTENSION IF EXISTS vector; */\r
DROP EXTENSION IF EXISTS other_extension CASCADE;\r
DROP EXTENSION another_extension;\r
SELECT `;
  const raw = Buffer.from([0xe9, 0x0d, 0x0a]);
  const trailer = Buffer.from('--\r\n-- PostgreSQL database dump complete\r\n--\r\n');
  const replay = Buffer.concat([Buffer.from(preserved, 'latin1'), raw, trailer]);
  const original = Buffer.concat([Buffer.from(version + metadata, 'latin1'), replay]);
  return { original, replay };
}
