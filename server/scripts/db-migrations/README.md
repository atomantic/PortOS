# DB Migrations (`server/scripts/db-migrations/`)

Ordered, versioned PostgreSQL schema-DELTA migrations (#1029). Run at boot by
`server/scripts/run-db-migrations.js` after `ensureSchema()` has created the base
schema.

## When to use this vs. `ensureSchema()`

| Change | Where it goes |
| --- | --- |
| New table / new column / new index (additive, fresh-install) | `ensureSchema()` in `server/lib/db.js` **and** `server/scripts/init-db.sql` (parity-locked by `db.catalogDdlParity.test.js`) |
| Column **rename**, **type change**, data **transform**, **embedding-dimension** change, dropping a column | A migration file here |

`ensureSchema()`'s `CREATE/ADD IF NOT EXISTS` gates can only express additive
fresh-install schema. Anything that has to *transform* an existing install —
something that isn't idempotent as a bare `IF NOT EXISTS` statement — belongs
here so it runs exactly once, in order, and is recorded.

## File format

Files are applied in **lexical filename order**, so prefix with a zero-padded
sequence: `001-`, `002-`, … Each filename is the migration **id** recorded in
the `schema_migrations` table — never rename or reuse an id once shipped.

Two formats are supported:

### `.sql`

Raw SQL, run verbatim against the transaction client. Use for pure DDL deltas.

```sql
-- 001-rename-foo-to-bar.sql
ALTER TABLE widgets RENAME COLUMN foo TO bar;
```

### `.js`

ESM module exporting `async function up(client)` (or a default object with an
`up` method). Receives the pg transaction client so you can query + mutate in
the same transaction — use this for data transforms, conditional logic, or
embedding-dimension changes.

```js
// 002-backfill-bar.js
export async function up(client) {
  const { rows } = await client.query('SELECT id, legacy FROM widgets WHERE bar IS NULL');
  for (const row of rows) {
    await client.query('UPDATE widgets SET bar = $1 WHERE id = $2', [derive(row.legacy), row.id]);
  }
}
```

## Guarantees

- **Atomic per migration.** Each migration's statements AND its
  `INSERT INTO schema_migrations` share one transaction. A failure rolls back
  both — the migration is **not** marked applied, boot aborts loudly, and the
  next boot retries it. Nothing half-applies.
- **Run once, in order.** Already-applied ids (tracked in `schema_migrations`)
  are skipped. Idempotent on re-run.
- **Naming.** `_`-prefixed files and `*.test.js` files are ignored (shared
  helpers / co-located tests).

## Conventions

- Migrations are forward-only (no `down()`). PortOS rolls forward.
- Keep each migration focused on one logical change.
- Prefer `.sql` for plain DDL; reach for `.js` only when you need to read rows,
  branch, or transform data.
