/**
 * Claude Code Changelog Service
 *
 * Fetches the Claude Code releases Atom feed from GitHub,
 * parses entries, and tracks which releases are new since last check.
 * Used by the daily briefing to alert the user of new Claude Code features.
 */

import { join } from 'path'
import sax from 'sax'
import { atomicWrite, readJSONFile, PATHS } from '../lib/fileUtils.js'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'

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

function parseAtomFeed(xml) {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true })
    const entries = []
    let current = null
    let tag = null
    let inFeed = false
    let settled = false

    parser.onopentag = (node) => {
      tag = node.name
      if (tag === 'feed') inFeed = true
      if (tag === 'entry' && inFeed) {
        current = { title: '', link: '', updated: '', content: '' }
      }
      if (current && tag === 'link' && node.attributes.href) {
        current.link = node.attributes.href
      }
    }

    parser.ontext = (text) => {
      if (!current || !tag) return
      if (tag === 'title') current.title += text
      if (tag === 'updated') current.updated += text
      if (tag === 'content') current.content += text
    }

    parser.oncdata = (cdata) => {
      if (!current || !tag) return
      if (tag === 'content') current.content += cdata
    }

    parser.onclosetag = (name) => {
      if (name === 'entry' && current) {
        entries.push(current)
        current = null
      }
      tag = null
    }

    parser.onerror = (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    }

    parser.onend = () => {
      if (!settled) {
        settled = true
        resolve(entries)
      }
    }

    parser.write(xml).close()
  })
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
  const allEntries = await parseAtomFeed(xml)

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
