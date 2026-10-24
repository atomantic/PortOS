/**
 * Pure plan for repairing Grok usage that was recorded without Imagine units
 * or the 200k price doubling.
 *
 * The plan never rewrites base token counts. Cache-rate corrections need no
 * plan at all: cost is computed at read time. A long-context turn already in
 * the ledger contributes only its extra 1× (`long*` is a subset). Turns with
 * no interactive-scan watermark, or a timestamp after that watermark, are
 * skipped — the scan has not billed them yet, or never ran, and adding the
 * premium alone would invent a charge whose base may be absent.
 *
 * Media recovered from the gallery and video history is the whole charge.
 * Session tool calls inside a PortOS `portos-grok-` scratch directory are
 * omitted so a gallery job is not billed twice.
 */

import { parseJsonLines } from '../lib/providerTranscriptUsage.js';
import { grokVideoBillableUnits } from '../lib/grokVideoClip.js';
import {
  GROK_IMAGINE_IMAGE_MODEL,
  GROK_IMAGINE_VIDEO_MODEL,
  GROK_LONG_CONTEXT_PROMPT_TOKENS,
} from '../lib/modelPricing.js';

const IMAGINE_IMAGE_TOOLS = new Set(['image_gen', 'image_edit']);
const IMAGINE_VIDEO_TOOLS = new Set(['image_to_video']);

export function grokTurnRepairId(sessionId, key) {
  return `turn:${sessionId || 'unknown'}:${key}`;
}

function isPortosGrokScratch(cwd) {
  return String(cwd || '').includes('portos-grok-');
}

function dayFromIso(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function dayFromMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function callName(call) {
  return String(call?.name || call?.toolName || call?.function?.name || call?.tool_name || '').toLowerCase();
}

function callArgs(call) {
  const raw = call?.arguments ?? call?.args ?? call?.function?.arguments ?? call?.input;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toolCallsFrom(entry) {
  const calls = [];
  for (const list of [entry?.tool_calls, entry?.toolCalls, entry?.message?.tool_calls]) {
    if (Array.isArray(list)) calls.push(...list);
  }
  if (entry?.type === 'tool_call' || entry?.type === 'function_call') calls.push(entry);
  const update = entry?.params?.update;
  if (update && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) calls.push(update);
  return calls;
}

function inputImageCount(args) {
  const images = args.image || args.images || args.input_images || args.reference_images;
  if (Array.isArray(images)) return images.length;
  if (typeof images === 'string' && images) return 1;
  if (args.image_path || args.init_image) return 1;
  return 0;
}

function eventsFromToolText(text, { sessionId, day }) {
  const events = [];
  let index = 0;
  for (const entry of parseJsonLines(text)) {
    for (const call of toolCallsFrom(entry)) {
      const name = callName(call);
      if (!IMAGINE_IMAGE_TOOLS.has(name) && !IMAGINE_VIDEO_TOOLS.has(name)) continue;
      const args = callArgs(call);
      const idBase = `${sessionId || 'unknown'}:${index}`;
      index += 1;
      if (IMAGINE_VIDEO_TOOLS.has(name)) {
        const requested = args.duration ?? args.seconds ?? args.length;
        const hasDuration = requested != null && Number.isFinite(Number(requested));
        const units = grokVideoBillableUnits({
          requestedSeconds: requested,
          deliveredSeconds: null,
          // The still this call animates is either a prior image_gen in the
          // same session or a file the user already had. It is an input, not
          // a second generated image.
          hasSourceImage: true,
        });
        events.push({
          id: `session-video:${idBase}`,
          day,
          model: GROK_IMAGINE_VIDEO_MODEL,
          images: 0,
          videoSeconds: units.videoSeconds,
          inputImages: units.inputImages,
          source: hasDuration ? 'measured' : 'estimate',
        });
      } else {
        events.push({
          id: `session-image:${idBase}`,
          day,
          model: GROK_IMAGINE_IMAGE_MODEL,
          images: 1,
          inputImages: inputImageCount(args),
          videoSeconds: 0,
          source: 'measured',
        });
      }
    }
  }
  return events;
}

/**
 * Imagine tool calls from one Grok CLI session. `chat_history.jsonl` has no
 * per-call timestamps, so every call shares `day` (summary time, else file
 * mtime). Updates are read only when the chat history names no Imagine call,
 * so the same invocation is not billed from both files. A PortOS scratch
 * cwd is skipped entirely.
 */
export function imagineEventsFromGrokSession({
  chatText = '', updatesText = '', sessionId, cwd, day,
} = {}) {
  if (!day || isPortosGrokScratch(cwd)) return [];
  const fromChat = eventsFromToolText(chatText, { sessionId, day });
  if (fromChat.length) return fromChat;
  return eventsFromToolText(updatesText, { sessionId, day });
}

export function galleryImageUsageEvent(meta) {
  if (!meta || meta.mode !== 'grok' || !meta.id) return null;
  const day = dayFromIso(meta.createdAt);
  if (!day) return null;
  const refs = Array.isArray(meta.referenceImageFilenames) ? meta.referenceImageFilenames.length : 0;
  return {
    id: `gallery:${meta.id}`,
    day,
    model: GROK_IMAGINE_IMAGE_MODEL,
    images: 1,
    inputImages: (meta.initImageFilename ? 1 : 0) + refs,
    videoSeconds: 0,
    source: 'measured',
  };
}

export function videoHistoryUsageEvents(entry) {
  if (!entry || entry.modelId !== 'grok' || !entry.id) return [];
  const day = dayFromIso(entry.createdAt);
  if (!day) return [];
  const units = grokVideoBillableUnits({
    requestedSeconds: entry.duration,
    deliveredSeconds: Number.isFinite(Number(entry.deliveredSec)) ? Number(entry.deliveredSec) : null,
    hasSourceImage: entry.mode === 'image',
  });
  const events = [{
    id: `video:${entry.id}`,
    day,
    model: GROK_IMAGINE_VIDEO_MODEL,
    images: 0,
    videoSeconds: units.videoSeconds,
    inputImages: units.inputImages,
    source: Number.isFinite(Number(entry.deliveredSec)) ? 'measured' : 'estimate',
  }];
  if (units.images > 0) {
    events.push({
      id: `video-base:${entry.id}`,
      day,
      model: GROK_IMAGINE_IMAGE_MODEL,
      images: 1,
      inputImages: 0,
      videoSeconds: 0,
      source: 'measured',
    });
  }
  return events;
}

/**
 * @param {{ turns?: object[], media?: object[], repairIds?: string[], watermarkMs?: number|null, providerId?: string }} input
 * @returns {{ additions: object[], notes: string[] }}
 */
export function planGrokUsageRepair({
  turns = [], media = [], repairIds = [], watermarkMs = null, providerId = 'grok',
} = {}) {
  const known = new Set(repairIds.filter((id) => typeof id === 'string' && id));
  const additions = [];
  const notes = [];
  if (watermarkMs == null) {
    notes.push('Long-context premiums were not added because no Grok usage scan has run yet. The next scan records those turns with the premium included.');
  }
  for (const turn of turns) {
    const promptTokens = turn?.promptTokens ?? ((turn?.tokensIn || 0) + (turn?.cacheReadTokens || 0));
    if (promptTokens < GROK_LONG_CONTEXT_PROMPT_TOKENS) continue;
    const id = grokTurnRepairId(turn.sessionId, turn.key);
    if (known.has(id)) continue;
    if (watermarkMs == null || turn.ms == null || turn.ms > watermarkMs) continue;
    const day = dayFromMs(turn.ms);
    if (!day) continue;
    known.add(id);
    additions.push({
      repairId: id,
      day,
      record: {
        providerId,
        model: turn.model || null,
        messages: 0,
        longTokensIn: turn.tokensIn || 0,
        longTokensOut: turn.tokensOut || 0,
        longCacheReadTokens: turn.cacheReadTokens || 0,
        longCacheWriteTokens: turn.cacheWriteTokens || 0,
        source: 'measured',
      },
    });
  }
  for (const item of media) {
    if (!item?.id || !item.day || known.has(item.id)) continue;
    known.add(item.id);
    additions.push({
      repairId: item.id,
      day: item.day,
      record: {
        providerId,
        model: item.model,
        messages: 0,
        images: item.images || 0,
        videoSeconds: item.videoSeconds || 0,
        inputImages: item.inputImages || 0,
        source: item.source || 'measured',
      },
    });
  }
  return { additions, notes };
}

/** Counts for the reconcile status line. A text-to-video base still counts as an image. */
export function summarizeGrokRepairAdditions(additions = []) {
  const summary = { added: 0, turns: 0, images: 0, videos: 0 };
  for (const item of additions) {
    summary.added += 1;
    if (String(item?.repairId || '').startsWith('turn:')) summary.turns += 1;
    else if (item?.record?.videoSeconds) summary.videos += 1;
    else summary.images += 1;
  }
  return summary;
}
