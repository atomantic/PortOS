/** Searchable projection of the generated Socket.IO call-site inventory. */

import { readFileSync } from 'node:fs';
import { socketEventContract } from './socketEventContracts.js';

const manifest = JSON.parse(readFileSync(
  new URL('./socketEventCatalog.generated.json', import.meta.url),
  'utf8',
));

const titleCase = (value) => value
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

export const socketDomainForEvent = (event) => event.split(':', 1)[0] || 'socket';

export const buildSocketEventCatalog = () => {
  const events = manifest.events.map((event) => {
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
    schemaVersion: 1,
    generatedFrom: manifest.generatedFrom,
    regenerateCommand: 'node scripts/generate-socket-event-catalog.js',
    stats: { ...manifest.stats, domains: domains.length, modeled, generated: events.length - modeled },
    domains,
    events,
  };
};
