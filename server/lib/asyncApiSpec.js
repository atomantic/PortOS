/** AsyncAPI 3 document for PortOS's source-derived Socket.IO event catalog. */

import { buildSocketEventCatalog } from './socketEventCatalog.js';

const hash = (value) => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
};

const identifier = (value) => `${value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)}_${hash(value)}`;

const serverDefinition = (baseUrl) => {
  const parsed = URL.canParse(baseUrl || '') ? new URL(baseUrl) : new URL('http://localhost:5555');
  return {
    host: parsed.host,
    protocol: 'socket.io',
    pathname: '/socket.io',
    description: 'PortOS Socket.IO server. Authentication follows the instance auth setting.',
  };
};

const channelParameters = (address) => Object.fromEntries(
  [...address.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)].map((match) => [
    match[1],
    { description: `Dynamic ${match[1]} segment in this Socket.IO event address.` },
  ]),
);

export const buildAsyncApiSpec = async ({ baseUrl, version = '0.0.0' } = {}) => {
  const catalog = await buildSocketEventCatalog();
  const channels = {};
  const operations = {};
  const messages = {};

  for (const event of catalog.events) {
    const channelId = identifier(`channel_${event.event}`);
    const channelMessages = {};
    for (const direction of event.directions) {
      const messageId = identifier(`message_${direction}_${event.event}`);
      const schema = event.payloadSchemas[direction] || {};
      messages[messageId] = {
        name: event.event,
        title: event.summary,
        summary: `${direction} payload for ${event.event}.`,
        payload: schema,
        'x-portos-contract-status': event.modeledDirections.includes(direction) ? 'modeled' : 'generated',
      };
      channelMessages[messageId] = { $ref: `#/components/messages/${messageId}` };
      const operationId = identifier(`${direction}_${event.event}`);
      operations[operationId] = {
        action: direction === 'server-to-client' ? 'send' : 'receive',
        summary: `${direction === 'server-to-client' ? 'Publish' : 'Handle'} ${event.event}`,
        channel: { $ref: `#/channels/${channelId}` },
        messages: [{ $ref: `#/channels/${channelId}/messages/${messageId}` }],
        tags: [{ name: event.domain }],
      };
    }
    const parameters = channelParameters(event.event);
    channels[channelId] = {
      address: event.event,
      title: event.summary,
      messages: channelMessages,
      ...(Object.keys(parameters).length ? { parameters } : {}),
      'x-portos-directions': event.directions,
    };
  }

  return {
    asyncapi: '3.0.0',
    info: {
      title: 'PortOS Socket.IO API',
      version,
      description: 'Source-derived event inventory for the PortOS Socket.IO transport. Inferred payloads remain explicitly marked until backed by a runtime schema.',
    },
    defaultContentType: 'application/json',
    servers: { local: serverDefinition(baseUrl) },
    channels,
    operations,
    components: { messages },
  };
};
