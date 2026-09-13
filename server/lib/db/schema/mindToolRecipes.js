// Machine-local authored definitions only; never execution outputs or federation data.
export const mindToolRecipesDdl = [
  `CREATE TABLE IF NOT EXISTS mind_tool_recipes (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active_revision INTEGER NOT NULL CHECK (active_revision > 0),
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS mind_tool_recipe_versions (
    recipe_id UUID NOT NULL REFERENCES mind_tool_recipes (id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    definition JSONB NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('user', 'mind')),
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (recipe_id, revision)
  )`,
];
