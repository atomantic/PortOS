// Bounded, machine-local review metadata on the existing memory record.
export async function up(client) {
  await client.query('ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_review JSONB');
  await client.query('ALTER TABLE memories ADD COLUMN IF NOT EXISTS review_origin JSONB');
}
