import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  AGENT_CONTEXT_PROTOCOL_VERSION,
  AGENT_CONTEXT_SUPPORTED_PROTOCOL_VERSIONS,
  agentContextInitializeParamsSchema,
  agentContextMcpInboundSchema,
  agentContextMcpNotificationSchema,
  agentContextMcpResponseSchema,
  agentContextToolCallParamsSchema,
  agentContextToolsListParamsSchema,
} from '../lib/agentContextValidation.js';
import { callAgentContextTool, getAgentContextManifest } from '../services/agentContextMcp.js';

const router = Router();

const stripAddressDecorations = (address) => String(address ?? '')
  .replace(/^\[|\]$/g, '')
  .split('%', 1)[0]
  .toLowerCase();

export function isLoopbackAddress(address) {
  const normalized = stripAddressDecorations(address);
  if (normalized === '::1' || normalized === 'localhost') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  const octets = ipv4.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export function isAllowedAgentContextOrigin(origin) {
  if (!origin) return true;
  return URL.canParse(origin) && isLoopbackAddress(new URL(origin).hostname);
}

const requireLocalRequest = (req, _res, next) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    throw new ServerError('Agent context accepts loopback connections only', {
      status: 403,
      code: 'AGENT_CONTEXT_LOCAL_ONLY',
    });
  }
  if (!isAllowedAgentContextOrigin(req.get('origin'))) {
    throw new ServerError('Agent context rejected a non-loopback Origin', {
      status: 403,
      code: 'AGENT_CONTEXT_ORIGIN_REJECTED',
    });
  }
  next();
};

const requireEnabled = asyncHandler(async (req, _res, next) => {
  const manifest = await getAgentContextManifest();
  if (!manifest.enabled || !manifest.configurationValid) {
    throw new ServerError('Agent context is disabled', {
      status: 403,
      code: 'AGENT_CONTEXT_DISABLED',
    });
  }
  req.agentContextManifest = manifest;
  next();
});

const jsonRpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const jsonRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

const requireMcpAccept = (req, res) => {
  const accept = String(req.get('accept') ?? '').toLowerCase();
  if (accept.includes('application/json') && accept.includes('text/event-stream')) return true;
  res.status(406).json(jsonRpcError(null, -32600, 'Accept must include application/json and text/event-stream'));
  return false;
};

const protocolHeaderIsSupported = (req) => {
  const version = req.get('mcp-protocol-version');
  return !version || AGENT_CONTEXT_SUPPORTED_PROTOCOL_VERSIONS.includes(version);
};

router.use(requireLocalRequest);

router.get('/manifest', asyncHandler(async (_req, res) => {
  res.json(await getAgentContextManifest());
}));

router.use('/mcp', requireEnabled);

router.get('/mcp', (_req, res) => {
  res.set('Allow', 'POST').status(405).end();
});

router.delete('/mcp', (_req, res) => {
  res.set('Allow', 'POST').status(405).end();
});

router.post('/mcp', asyncHandler(async (req, res) => {
  if (!requireMcpAccept(req, res)) return;
  if (!protocolHeaderIsSupported(req)) {
    res.status(400).json(jsonRpcError(null, -32600, 'Unsupported MCP-Protocol-Version'));
    return;
  }

  const parsed = agentContextMcpInboundSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(jsonRpcError(null, -32600, 'Invalid JSON-RPC message'));
    return;
  }

  const message = parsed.data;
  if (agentContextMcpNotificationSchema.safeParse(message).success
      || agentContextMcpResponseSchema.safeParse(message).success) {
    res.status(202).end();
    return;
  }

  if (message.method === 'initialize') {
    const params = agentContextInitializeParamsSchema.safeParse(message.params);
    if (!params.success) {
      res.json(jsonRpcError(message.id, -32602, 'Invalid initialize params'));
      return;
    }
    const requested = params.data.protocolVersion;
    const protocolVersion = AGENT_CONTEXT_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : AGENT_CONTEXT_PROTOCOL_VERSION;
    res.json(jsonRpcResult(message.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'PortOS Agent Tools', version: '1' },
      instructions: 'Local-only MCP. Context tools remain read-only; semantic actions appear only when separately granted. Inspect context_profile before querying personal scopes.',
    }));
    return;
  }

  if (message.method === 'ping') {
    res.json(jsonRpcResult(message.id, {}));
    return;
  }

  if (message.method === 'tools/list') {
    const params = agentContextToolsListParamsSchema.safeParse(message.params ?? {});
    if (!params.success || params.data.cursor) {
      res.json(jsonRpcError(message.id, -32602, 'Invalid tools/list params'));
      return;
    }
    res.json(jsonRpcResult(message.id, { tools: req.agentContextManifest.tools }));
    return;
  }

  if (message.method === 'tools/call') {
    const params = agentContextToolCallParamsSchema.safeParse(message.params);
    if (!params.success) {
      res.json(jsonRpcError(message.id, -32602, 'Invalid tools/call params'));
      return;
    }
    const result = await callAgentContextTool(params.data.name, params.data.arguments, {
      agentContext: {
        enabled: true,
        profile: req.agentContextManifest.profile,
        scopes: req.agentContextManifest.scopes,
        actions: req.agentContextManifest.actions,
      },
    }, {
      requestId: `agent-mcp:${req.get('idempotency-key') || randomUUID()}`,
    });
    res.json(jsonRpcResult(message.id, result));
    return;
  }

  res.json(jsonRpcError(message.id, -32601, 'Method not found'));
}));

export default router;
