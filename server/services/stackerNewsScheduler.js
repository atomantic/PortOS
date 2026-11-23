import { cancel, schedule } from './eventScheduler.js';
import { getAccount, listAccounts, listTerritories, syncAccount } from './stackerNews.js';

const PREFIX = 'stacker-news-sync:';
const registered = new Set();

const hasEffectiveMonitoring = (account, territories) => account.enabled
  && territories.some((territory) => territory.monitoringEnabled ?? account.monitoringEnabled);

export async function reconcileStackerNewsSchedulers() {
  for (const id of registered) cancel(id);
  registered.clear();
  const accounts = await listAccounts();
  for (const account of accounts) {
    const territories = await listTerritories(account.id);
    if (!hasEffectiveMonitoring(account, territories)) continue;
    const id = `${PREFIX}${account.id}`;
    schedule({
      id,
      type: 'interval',
      intervalMs: account.monitoringIntervalMinutes * 60_000,
      handler: async () => {
        const current = await getAccount(account.id);
        if (!current || !hasEffectiveMonitoring(current, await listTerritories(account.id))) return;
        const { getIo } = await import('./socketIo.js');
        try {
          await syncAccount(account.id);
        } finally {
          // A failed sync can still persist territory, item, or account changes.
          getIo()?.emit('stacker-news:changed', { accountId: account.id });
        }
      },
      metadata: { source: 'stackerNewsScheduler', accountId: account.id },
    });
    registered.add(id);
  }
  console.log(`📰 Stacker News scheduler: armed ${registered.size} opted-in account(s)`);
  return registered.size;
}

export function stopStackerNewsSchedulers() {
  for (const id of registered) cancel(id);
  registered.clear();
}
