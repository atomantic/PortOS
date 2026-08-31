/** Searchable projection of the source-derived Socket.IO event inventory. */

import { socketEventContract } from './socketEventContracts.js';
import { getSocketEventInventory } from './socketEventInventory.js';

const titleCase = (value) => value
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

export const socketDomainForEvent = (event) => event.split(':', 1)[0] || 'socket';

export const buildSocketEventCatalog = async ({ inventory = getSocketEventInventory() } = {}) => {
  const resolvedInventory = await inventory;
  const events = resolvedInventory.events.map((event) => {
    const domain = socketDomainForEvent(event.event);
    const contracts = Object.fromEntries(event.directions.flatMap((direction) => {
      const contract = socketEventContract(event.event, direction);
      return contract ? [[direction, contract]] : [];
    }));
    const modeledDirections = Object.keys(contracts);
    return {
      ...event,
      domain,
      domainLabel: titleCase(domain),
      summary: Object.values(contracts)[0]?.summary || `${titleCase(event.event)} Socket.IO event`,
      contractStatus: modeledDirections.length ? 'modeled' : 'generated',
      modeledDirections,
      payloadSchemas: Object.fromEntries(Object.entries(contracts).map(([direction, contract]) => [direction, contract.payloadSchema])),
    };
  });
  const domains = [...new Set(events.map((event) => event.domain))]
    .map((id) => ({ id, label: titleCase(id), events: events.filter((event) => event.domain === id).length }));
  const modeled = events.filter((event) => event.contractStatus === 'modeled').length;
  return {
    schemaVersion: 2,
    derivedFrom: resolvedInventory.derivedFrom,
    stats: { ...resolvedInventory.stats, domains: domains.length, modeled, generated: events.length - modeled },
    domains,
    events,
  };
};
