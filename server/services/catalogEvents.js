import { EventEmitter } from 'events';

// Stage-progress bus for the catalog's LLM extraction passes (character,
// place, object). Mirrors importerEvents.js — the extraction route runs each
// kind in parallel, can take 30+ seconds, and the client has no other way to
// see which kind is in flight. socket.js bridges `progress` frames here to
// `catalog:extract:progress` on Socket.IO; the Catalog Ingest page renders
// the live stage checklist.
//
// Single-user trust model: at most one extraction runs at a time, but each
// frame carries a `runId` so the client can ignore stragglers from a prior
// run if the user re-fired quickly.
export const catalogEvents = new EventEmitter();
