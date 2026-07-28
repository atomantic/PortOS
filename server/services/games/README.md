# Games

The Game studio binds a managed app to reusable Sprite and Music records, compiles immutable versioned asset manifests, and stores user-triggered AI review history.

| File | Purpose |
|---|---|
| `store.js` | PostgreSQL/collectionStore dispatcher plus per-Game write serialization and manifest directory paths. |
| `db.js` | PostgreSQL leaf I/O for `games` JSONB records. |
| `records.js` | Game CRUD, managed-app validation, and sprite/music bind/unbind operations. |
| `compile.js` | Deterministic, idempotent asset-manifest compiler with SHA-256 references. |
| `feedback.js` | Explicitly user-triggered provider/model/effort feedback and history persistence. |
| `index.js` | Public Game service barrel. |
