/**
 * Claude Code Changelog Service
 *
 * Fetches the Claude Code releases Atom feed from GitHub,
 * parses entries, and tracks which releases are new since last check.
 * Used by the daily briefing to alert the user of new Claude Code features.
 */

import { join } from 'path'
import { atomicWrite, readJSONFile, PATHS } from '../lib/fileUtils.js'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { decodeXmlEntities } from '../lib/xmlEntities.js'

const FEED_URL = 'https://github.com/anthropics/claude-code/releases.atom'
const STATE_FILE = join(PATHS.data, 'claude-changelog.json')
const MAX_ENTRIES = 10
const MAX_SUMMARY_LENGTH = 500
const STALE_MS = 60 * 60 * 1000 // 1 hour

const defaultState = () => ({
  lastCheck: null,
  lastSeenVersion: null,
  entries: []
})

// Entity decoding is the shared `server/lib/xmlEntities.js` single-pass decoder
// (named + numeric). It is double-decode-safe — a literal "&amp;lt;" decodes to
// "&lt;", not "<" — which preserves the guard this feed used to chain manually.

// Pull the first <tag>…</tag> text from an <entry> block. CDATA-wrapped
// content (GitHub wraps release notes in <![CDATA[…]]>) is returned verbatim;
// plain text is entity-decoded. Returns '' when the tag is absent.
function extractTag(entryXml, tag) {
  const m = entryXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  if (!m) return ''
  const inner = m[1]
  const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  if (cdata) return cdata[1]
  return decodeXmlEntities(inner.trim())
}

/**
 * Parse the GitHub releases Atom feed into flat entries. The feed is small
 * and flat (one level of <entry> under <feed>), so a focused extractor beats
 * pulling in a general XML parser — same dependency-free approach the streaming
 * Apple Health `<Record>` parser takes for the 500MB export path (issue #1167).
 */
function parseAtomFeed(xml) {
  const entries = []
  const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi
  let match
  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1]
    // <link href="…"/> — Atom links carry the URL in the href attribute.
    const linkMatch = block.match(/<link\b[^>]*\bhref="([^"]*)"/i)
    entries.push({
      title: extractTag(block, 'title'),
      link: linkMatch ? decodeXmlEntities(linkMatch[1]) : '',
      updated: extractTag(block, 'updated'),
      content: extractTag(block, 'content'),
    })
  }
  return entries
}

function extractVersion(title) {
  const match = title?.match(/v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/)
  return match ? match[1] : null
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fetch the Claude Code changelog, parse it, and return new entries since last check.
 * Returns cached data if checked within the last hour.
 */
export async function checkChangelog() {
  const state = await readJSONFile(STATE_FILE, defaultState())

  // Return cached data if fresh enough
  if (state.lastCheck && (Date.now() - new Date(state.lastCheck).getTime()) < STALE_MS) {
    const newEntries = state.lastSeenVersion
      ? state.entries.filter(e => new Date(e.date) > new Date(state.lastCheck))
      : []
    return { ...state, newEntries }
  }

  const response = await fetchWithTimeout(FEED_URL, {}, 15000)
  if (!response.ok) {
    console.error(`❌ Claude changelog fetch failed: ${response.status}`)
    return { ...state, newEntries: [] }
  }

  const xml = await response.text()
  const allEntries = parseAtomFeed(xml)

  const entries = allEntries.slice(0, MAX_ENTRIES).map(e => ({
    version: extractVersion(e.title),
    title: e.title,
    link: e.link,
    date: e.updated,
    summary: stripHtml(e.content.slice(0, MAX_SUMMARY_LENGTH * 4)).slice(0, MAX_SUMMARY_LENGTH)
  }))

  // Determine new entries since last check using date comparison
  const newEntries = state.lastCheck
    ? entries.filter(e => new Date(e.date) > new Date(state.lastCheck))
    : []

  const now = new Date().toISOString()
  const newState = {
    lastCheck: now,
    lastSeenVersion: entries[0]?.version || state.lastSeenVersion,
    entries
  }

  await atomicWrite(STATE_FILE, newState)

  console.log(`📋 Claude changelog: ${entries.length} entries, ${newEntries.length} new since ${state.lastCheck || 'first check'}`)

  return { ...newState, newEntries }
}

/**
 * Get cached changelog state without fetching.
 */
export async function getCachedChangelog() {
  return readJSONFile(STATE_FILE, defaultState())
}

// Exposed for unit tests — the Atom parse is the regex-extractor that replaced
// a general XML parser on this path (issue #1167).
export const __testing = { parseAtomFeed, stripHtml, extractVersion }
