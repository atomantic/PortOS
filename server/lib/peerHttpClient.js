// Federation HTTP/Socket.IO client — TLS validation off (Tailnet is the trust boundary).
import https from 'node:https';
import { insecureFetch } from './httpClient.js';

const peerHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpsFetch = insecureFetch(peerHttpsAgent);

export const peerSocketOptions = {
  rejectUnauthorized: false,
  transports: ['websocket', 'polling']
};

export function peerFetch(url, options = {}) {
  return url.startsWith('https://') ? httpsFetch(url, options) : fetch(url, options);
}
