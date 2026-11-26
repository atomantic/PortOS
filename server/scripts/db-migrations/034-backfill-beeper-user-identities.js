/**
 * Promote legacy cached participant links (#96) to durable claims once.
 * An existing Beeper claim indicates the original backfill or a user link
 * already exists. Migration history keeps the promotion from running again
 * if those claims are later removed.
 */
export async function up(client) {
  await client.query(
    `INSERT INTO tribe_identities (person_id, kind, network, handle, source, linked_at)
     SELECT DISTINCT ON (c.account_id, p.source_user_id)
            p.tribe_person_id, 'beeper-user', c.account_id, p.source_user_id, 'backfill', NOW()
     FROM beeper_participants p
     JOIN beeper_conversations c ON c.id = p.conversation_id
     JOIN tribe_people tp ON tp.id = p.tribe_person_id AND tp.deleted = FALSE
     WHERE p.tribe_person_id IS NOT NULL AND c.account_id <> ''
       AND NOT EXISTS (SELECT 1 FROM tribe_identities WHERE kind = 'beeper-user')
     ORDER BY c.account_id, p.source_user_id, p.updated_at DESC
     ON CONFLICT (kind, network, handle) DO NOTHING`,
  );
}
