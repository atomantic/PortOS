/**
 * `read_transport` was added with a `'browser'` default so a fresh account works
 * without an API key (#3318). Applied blindly that would flip every EXISTING
 * account — all of which necessarily have a stored key, because nothing else
 * worked before — onto browser reads, breaking any scheduled sync whose pinned
 * Chrome is not signed in to Stacker News.
 *
 * Pin only the accounts that already hold a credential to the transport they
 * were actually using. Runs exactly once, so an account the user later switches
 * to browser reads stays switched.
 */
export async function up(client) {
  await client.query(
    `UPDATE stacker_news_accounts a
     SET read_transport='api',updated_at=NOW()
     WHERE a.read_transport='browser'
       AND EXISTS (SELECT 1 FROM stacker_news_credentials c WHERE c.account_id=a.id)`,
  );
}
