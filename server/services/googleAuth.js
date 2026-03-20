import { google } from 'googleapis';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const AUTH_DIR = join(PATHS.calendar, 'google-auth');
const CREDENTIALS_FILE = join(AUTH_DIR, 'credentials.json');
const TOKENS_FILE = join(AUTH_DIR, 'tokens.json');
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify'
];
export const OAUTH_REDIRECT_URI = `http://${process.env.PUBLIC_HOST || 'localhost'}:${process.env.PORT || 5555}/api/calendar/google/oauth/callback`;

let oAuth2Client = null;

async function ensureAuthDir() {
  await ensureDir(AUTH_DIR);
}

export async function getCredentials() {
  await ensureAuthDir();
  const raw = await readFile(CREDENTIALS_FILE, 'utf-8').catch(() => null);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function saveCredentials({ clientId, clientSecret }) {
  await ensureAuthDir();
  const credentials = { clientId, clientSecret, redirectUri: OAUTH_REDIRECT_URI };
  await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
  oAuth2Client = null; // Reset client
  console.log('📅 Google OAuth credentials saved');
  return credentials;
}

export async function getTokens() {
  await ensureAuthDir();
  const raw = await readFile(TOKENS_FILE, 'utf-8').catch(() => null);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveTokens(tokens) {
  await ensureAuthDir();
  await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  console.log('📅 Google OAuth tokens saved');
}

export async function clearAuth() {
  await ensureAuthDir();
  await writeFile(TOKENS_FILE, '{}').catch(() => {});
  oAuth2Client = null;
  console.log('📅 Google OAuth tokens cleared');
}

function createOAuth2Client(credentials) {
  return new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    credentials.redirectUri || OAUTH_REDIRECT_URI
  );
}

export async function getAuthUrl() {
  const credentials = await getCredentials();
  if (!credentials) return { error: 'No Google OAuth credentials configured' };

  const client = createOAuth2Client(credentials);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
  return { url };
}

export async function handleCallback(code) {
  const credentials = await getCredentials();
  if (!credentials) return { error: 'No credentials configured' };

  const client = createOAuth2Client(credentials);
  const { tokens } = await client.getToken(code);
  await saveTokens(tokens);
  oAuth2Client = client;
  oAuth2Client.setCredentials(tokens);

  // Attach refresh listener so refreshed tokens are persisted
  oAuth2Client.on('tokens', async (newTokens) => {
    const existing = (await getTokens()) || {};
    await saveTokens({ ...existing, ...newTokens });
    console.log('📅 Google OAuth tokens refreshed');
  });

  console.log('📅 Google OAuth callback processed, tokens stored');
  return { success: true };
}

export async function getAuthenticatedClient() {
  const credentials = await getCredentials();
  if (!credentials?.clientId) return null;

  const tokens = await getTokens();
  if (!tokens?.access_token) return null;

  if (!oAuth2Client) {
    oAuth2Client = createOAuth2Client(credentials);
    oAuth2Client.setCredentials(tokens);

    // Listen for token refresh
    oAuth2Client.on('tokens', async (newTokens) => {
      const existing = (await getTokens()) || {};
      await saveTokens({ ...existing, ...newTokens });
      console.log('📅 Google OAuth tokens refreshed');
    });
  }

  return oAuth2Client;
}

export function needsScopeUpgrade(tokens) {
  if (!tokens?.scope) return true;
  const scopes = tokens.scope.split(' ');
  // Check all required scopes are present
  return !SCOPES.every(s => scopes.includes(s));
}

export async function getAuthStatus() {
  const credentials = await getCredentials();
  const tokens = await getTokens();
  return {
    hasCredentials: !!credentials?.clientId,
    hasTokens: !!tokens?.access_token,
    expiryDate: tokens?.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    needsScopeUpgrade: needsScopeUpgrade(tokens)
  };
}
