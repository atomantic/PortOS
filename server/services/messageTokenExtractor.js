/**
 * Token Extractor - extracts bearer tokens from Outlook/Teams browser sessions via CDP
 *
 * Strategy per provider:
 * - Outlook: intercepts network requests (OWA makes frequent API calls with bearer tokens)
 * - Teams: reads MSAL tokens from localStorage (Teams v2 uses service worker, no visible network)
 *
 * Tokens are cached with proactive refresh before expiry.
 */

import { getPages, evaluateOnPage } from './messagePlaywrightSync.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';

const TOKEN_VALIDATION_TIMEOUT_MS = 15000;

// Per-provider token cache: { token, decoded, cachedAt }
const tokenCache = new Map();

// Refresh tokens 5 minutes before actual JWT expiry
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Provider configs
const PROVIDERS = {
  outlook: {
    tabPattern: 'outlook.office.com',
    extractMethod: 'network',
    // OWA sends requests to multiple domains — match broadly
    networkPatterns: ['outlook.office.com', 'outlook.office365.com', 'substrate.office.com'],
    triggerScript: `(async function() {
      const listbox = document.querySelector("[role='listbox']");
      if (listbox) {
        const container = listbox.closest('[role="region"]') || listbox.parentElement;
        if (container) { container.scrollBy(0, 300); await new Promise(r => setTimeout(r, 500)); container.scrollBy(0, -300); }
      }
      const inboxLink = document.querySelector('div[title="Inbox"]') || document.querySelector('[data-folderid]');
      if (inboxLink) { inboxLink.click(); }
      return true;
    })()`
  },
  teams: {
    tabPattern: 'teams.microsoft.com',
    extractMethod: 'localStorage',
    // MSAL stores tokens keyed by resource; prefer Graph API token for broadest access
    localStorageResource: 'graph.microsoft.com'
  }
};

/**
 * Connect to a tab's CDP WebSocket and intercept bearer tokens from network requests.
 * Used for Outlook where OWA makes frequent API calls.
 */
async function extractTokenFromNetwork(page, networkPatterns, timeoutMs = 20000) {
  const wsUrl = page.webSocketDebuggerUrl;
  if (!wsUrl) return null;

  const { default: WebSocket } = await import('ws');

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const timer = setTimeout(() => {
      ws.close();
      resolve(null);
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: msgId++, method: 'Network.enable', params: {} }));
    });

    ws.on('message', (data) => {
      const msg = safeJSONParse(data.toString(), null, { context: 'cdp-token-ws' });
      if (!msg) return;

      if (msg.method === 'Network.requestWillBeSent') {
        const request = msg.params?.request;
        if (!request) return;

        const url = request.url || '';
        const authHeader = request.headers?.Authorization || request.headers?.authorization || '';

        if (authHeader.startsWith('Bearer ') && networkPatterns.some(p => url.includes(p))) {
          const token = authHeader.slice(7);
          clearTimeout(timer);
          ws.send(JSON.stringify({ id: msgId++, method: 'Network.disable', params: {} }));
          setTimeout(() => ws.close(), 200);
          resolve(token);
        }
      }
    });

    ws.on('error', () => {
      clearTimeout(timer);
      ws.close();
      resolve(null);
    });
  });
}

const TRIGGER_TIMEOUT_MS = 5000;

/**
 * Trigger network activity on a tab so the web app makes an API call we can intercept.
 * The result is ignored — we only care that the script ran.
 */
async function triggerPageRequest(page, script) {
  await evaluateOnPage(page, script, { timeout: TRIGGER_TIMEOUT_MS });
}

/**
 * Extract a token from localStorage MSAL cache (Teams v2 stores tokens here).
 * Finds the best valid token for the given resource.
 */
async function extractTokenFromLocalStorage(page, resource) {
  const script = `(function() {
    const resource = ${JSON.stringify(resource)};
    let best = null;
    let bestExp = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.includes('accesstoken') || !key.includes('login.windows.net')) continue;
      if (!key.toLowerCase().includes(resource.toLowerCase())) continue;
      try {
        const val = JSON.parse(localStorage.getItem(key));
        if (!val.secret) continue;
        const exp = parseInt(val.expiresOn || '0');
        if (exp * 1000 < Date.now()) continue; // skip expired
        if (exp > bestExp) {
          bestExp = exp;
          best = val.secret;
        }
      } catch(e) { console.warn('📧 localStorage parse error', e.message); }
    }
    return best;
  })()`;

  return evaluateOnPage(page, script);
}

/**
 * Decode a JWT payload (no signature verification — just need expiry/scopes).
 */
function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return safeJSONParse(payload, null, { context: 'jwt-decode' });
}

/**
 * Check if a cached token is still valid (not expired, with buffer).
 */
function isTokenValid(entry) {
  if (!entry?.token) return false;
  const decoded = entry.decoded || decodeJwt(entry.token);
  const exp = decoded?.exp ? decoded.exp * 1000 : 0;
  return exp > (Date.now() + EXPIRY_BUFFER_MS);
}

/**
 * Get a bearer token for the given provider ('outlook' or 'teams').
 * Returns { token, decoded, fresh, provider } or { error, message, provider }.
 */
export async function getToken(provider) {
  const config = PROVIDERS[provider];
  if (!config) return { error: 'unknown-provider', message: `Unknown provider: ${provider}`, provider };

  // Return cached token if still valid
  const cached = tokenCache.get(provider);
  if (cached && isTokenValid(cached)) {
    return { token: cached.token, decoded: cached.decoded, fresh: false, provider };
  }

  // Find the provider's tab in the browser
  const pages = await getPages().catch(() => []);
  const page = pages.find(p => p.url?.includes(config.tabPattern));

  if (!page) {
    return { error: 'no-tab', message: `No ${provider} tab found in CDP browser. Open ${provider} first.`, provider };
  }
  if (!page.webSocketDebuggerUrl) {
    return { error: 'no-ws', message: `${provider} tab found but no WebSocket debugger URL available.`, provider };
  }

  console.log(`📧 Extracting ${provider} bearer token via ${config.extractMethod}...`);

  let token = null;

  if (config.extractMethod === 'localStorage') {
    // Teams v2: read from MSAL localStorage cache
    token = await extractTokenFromLocalStorage(page, config.localStorageResource);
  } else {
    // Outlook: intercept from network requests
    await triggerPageRequest(page, config.triggerScript);
    token = await extractTokenFromNetwork(page, config.networkPatterns);
  }

  if (!token) {
    return { error: 'no-token', message: `Could not capture ${provider} bearer token.`, provider };
  }

  const decoded = decodeJwt(token);
  const exp = decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : 'unknown';
  console.log(`📧 ${provider} token captured (length: ${token.length}, expires: ${exp})`);

  tokenCache.set(provider, { token, decoded, cachedAt: Date.now() });
  return { token, decoded, fresh: true, provider };
}

// Convenience aliases
export const getOutlookToken = () => getToken('outlook');
export const getTeamsToken = () => getToken('teams');

/**
 * Get token info without the raw token value (for status/debug display).
 */
export function getTokenStatus(provider) {
  const cached = tokenCache.get(provider);
  if (!cached) return { provider, cached: false };
  const decoded = cached.decoded || {};
  const exp = decoded.exp ? decoded.exp * 1000 : 0;
  return {
    provider,
    cached: true,
    valid: isTokenValid(cached),
    expires: exp ? new Date(exp).toISOString() : 'unknown',
    expiresIn: exp ? Math.max(0, Math.round((exp - Date.now()) / 1000)) : 0,
    audience: decoded.aud || 'unknown',
    cachedAt: new Date(cached.cachedAt).toISOString()
  };
}

/**
 * Test a token against the provider's API.
 */
export async function testApi(provider, token, top = 5) {
  const urls = {
    outlook: `https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages?$top=${top}&$select=subject,from,receivedDateTime,isRead,bodyPreview,body,flag,categories,conversationId,importance,toRecipients,ccRecipients`,
    // Graph token from Teams has Mail.Read — test with /me to verify token works
    teams: `https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName`
  };

  const url = urls[provider];
  if (!url) return { success: false, error: `No API URL for provider: ${provider}` };

  const response = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` }
  }, TOKEN_VALIDATION_TIMEOUT_MS);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { success: false, status: response.status, error: text.slice(0, 500) };
  }

  const data = await response.json();

  if (provider === 'outlook') {
    return {
      success: true,
      count: data.value?.length || 0,
      messages: (data.value || []).map(m => ({
        id: m.Id,
        conversationId: m.ConversationId,
        subject: m.Subject,
        from: m.From?.EmailAddress?.Name || '',
        fromEmail: m.From?.EmailAddress?.Address || '',
        to: (m.ToRecipients || []).map(r => ({ name: r.EmailAddress?.Name, email: r.EmailAddress?.Address })),
        cc: (m.CcRecipients || []).map(r => ({ name: r.EmailAddress?.Name, email: r.EmailAddress?.Address })),
        receivedDateTime: m.ReceivedDateTime,
        isRead: m.IsRead,
        bodyPreview: m.BodyPreview || '',
        bodyType: m.Body?.ContentType || '',
        bodyContent: m.Body?.Content || '',
        importance: m.Importance || 'Normal',
        flag: m.Flag?.FlagStatus || 'NotFlagged',
        categories: m.Categories || []
      }))
    };
  }

  // Teams Graph API — the token from localStorage may lack Chat.Read scope,
  // but has Mail.Read and other useful scopes. Return whatever we get.
  return {
    success: true,
    count: data.value?.length || 0,
    items: (data.value || []).slice(0, 5).map(item => {
      // Generic shape — works for chats, messages, etc.
      const keys = Object.keys(item);
      return { id: item.id, type: item.chatType || item['@odata.type'] || 'unknown', keys };
    }),
    note: 'Teams Graph token may lack Chat.Read scope. Token is cached for future use when API access improves.'
  };
}

/**
 * Clear cached token for a provider (or all).
 */
export function clearTokenCache(provider) {
  if (provider) {
    tokenCache.delete(provider);
  } else {
    tokenCache.clear();
  }
}
