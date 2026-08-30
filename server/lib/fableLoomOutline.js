/**
 * FableLoom episode beat outlines — the story-first contract between a
 * series plan and a fully written teleplay.
 *
 * An outline is deliberately smaller than a scene graph: one short log-line
 * per camera-cut beat, the intended audience contract, and the paths between
 * beats. This module stays pure so the same deterministic checks can run
 * before an outline is expanded and whenever an author edits it by hand.
 */

import { trimTo } from './storyBible.js';
import { LOOM_LIMITS } from './fableLoomLimits.js';
import { FABLELOOM_PROTAGONIST_PRESENCE } from './fableLoomPlayback.js';

const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value && typeof value === 'object';
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

export const OUTLINE_ISSUE_CODES = Object.freeze({
  NO_SCENES: 'NO_SCENES',
  MISSING_START: 'MISSING_START',
  START_NOT_FOUND: 'START_NOT_FOUND',
  NO_ENDINGS: 'NO_ENDINGS',
  UNREACHABLE_SCENE: 'UNREACHABLE_SCENE',
  DEAD_END: 'DEAD_END',
  DANGLING_TRANSITION: 'DANGLING_TRANSITION',
  SELF_LOOP: 'SELF_LOOP',
  ENDING_WITH_TRANSITIONS: 'ENDING_WITH_TRANSITIONS',
  EMPTY_SUMMARY: 'EMPTY_SUMMARY',
  EMPTY_INTENT: 'EMPTY_INTENT',
  DUPLICATE_INTENT: 'DUPLICATE_INTENT',
  CUT_TRANSITION_COUNT: 'CUT_TRANSITION_COUNT',
  DECISION_TRANSITION_COUNT: 'DECISION_TRANSITION_COUNT',
  DISCONNECTED_DECISION: 'DISCONNECTED_DECISION',
  NO_AUDIENCE_CONNECTION: 'NO_AUDIENCE_CONNECTION',
  LATE_AUDIENCE_CONNECTION: 'LATE_AUDIENCE_CONNECTION',
  MISSING_EPISODE_OUTLINE: 'MISSING_EPISODE_OUTLINE',
  EPISODE_OUTLINE_NOT_VALIDATED: 'EPISODE_OUTLINE_NOT_VALIDATED',
  TELEPLAY_SCENE_MEMBERSHIP_MISMATCH: 'TELEPLAY_SCENE_MEMBERSHIP_MISMATCH',
  TELEPLAY_START_MISMATCH: 'TELEPLAY_START_MISMATCH',
  TELEPLAY_SCENE_CONTRACT_MISMATCH: 'TELEPLAY_SCENE_CONTRACT_MISMATCH',
  MISSING_OVERNIGHT_VOICEMAIL: 'MISSING_OVERNIGHT_VOICEMAIL',
  EMPTY_OVERNIGHT_VOICEMAIL: 'EMPTY_OVERNIGHT_VOICEMAIL',
  MISSING_NEXT_SEASON_TEASER: 'MISSING_NEXT_SEASON_TEASER',
});

const OUTLINE_STATUSES = new Set(['draft', 'valid', 'invalid']);

const uniqueKey = (candidate, index, seen) => {
  const base = isText(candidate)
    ? candidate.trim().slice(0, LOOM_LIMITS.OUTLINE_KEY_MAX)
    : `s${index + 1}`;
  let key = base || `s${index + 1}`;
  let suffix = 2;
  while (seen.has(key)) {
    const stem = base.slice(0, Math.max(1, LOOM_LIMITS.OUTLINE_KEY_MAX - String(suffix).length - 1));
    key = `${stem}-${suffix}`;
    suffix += 1;
  }
  seen.add(key);
  return key;
};

const sanitizeValidation = (raw) => {
  if (!isObject(raw)) return { status: 'draft', issues: [] };
  const status = OUTLINE_STATUSES.has(raw.status) ? raw.status : 'draft';
  const issues = asArray(raw.issues)
    .filter(isObject)
    .slice(0, LOOM_LIMITS.OUTLINE_ISSUES_MAX)
    .map((issue) => ({
      code: trimTo(issue.code, 80),
      severity: issue.severity === 'warning' ? 'warning' : 'error',
      message: trimTo(issue.message, LOOM_LIMITS.OUTLINE_ISSUE_MESSAGE_MAX),
      ...(isText(issue.sceneKey) ? { sceneKey: issue.sceneKey.slice(0, LOOM_LIMITS.OUTLINE_KEY_MAX) } : {}),
      ...(Number.isInteger(issue.transitionIndex) && issue.transitionIndex >= 0
        ? { transitionIndex: issue.transitionIndex }
        : {}),
    }))
    .filter((issue) => issue.message);
  return {
    status,
    issues,
    ...(isText(raw.validatedAt) ? { validatedAt: raw.validatedAt.slice(0, 80) } : {}),
  };
};

/**
 * Normalize an AI- or author-provided outline into the bounded persisted
 * shape. Unknown target keys are intentionally retained so validation can
 * explain the broken edge instead of silently changing the author's arc.
 */
export function sanitizeStoryOutline(raw, { participationMode = 'protagonist' } = {}) {
  if (!isObject(raw)) return null;
  const rawScenes = asArray(raw.scenes).slice(0, LOOM_LIMITS.OUTLINE_SCENES_MAX);
  const seen = new Set();
  const keyByRawKey = new Map();
  const scenes = rawScenes.map((scene, index) => {
    const key = uniqueKey(scene?.key, index, seen);
    if (isText(scene?.key) && !keyByRawKey.has(scene.key.trim())) keyByRawKey.set(scene.key.trim(), key);
    const transitions = asArray(scene?.transitions)
      .slice(0, LOOM_LIMITS.OUTLINE_TRANSITIONS_MAX)
      .filter(isObject)
      .map((transition) => ({
        targetKey: isText(transition.targetKey)
          ? transition.targetKey.trim().slice(0, LOOM_LIMITS.OUTLINE_KEY_MAX)
          : '',
        intent: trimTo(transition.intent, LOOM_LIMITS.INTENT_MAX),
      }));
    return {
      key,
      title: trimTo(scene?.title, LOOM_LIMITS.NODE_TITLE_MAX),
      summary: trimTo(scene?.summary, LOOM_LIMITS.OUTLINE_SUMMARY_MAX),
      playbackMode: scene?.playbackMode === 'cut' ? 'cut' : 'decision',
      audienceConnection: scene?.audienceConnection === 'connected' ? 'connected' : 'disconnected',
      protagonistPresence: FABLELOOM_PROTAGONIST_PRESENCE.includes(scene?.protagonistPresence)
        ? scene.protagonistPresence
        : participationMode === 'helper'
          && scene?.audienceConnection === 'connected'
          && scene?.playbackMode !== 'cut'
          ? 'offscreen'
          : 'onscreen',
      isEnding: scene?.isEnding === true,
      endingLabel: trimTo(scene?.endingLabel, LOOM_LIMITS.ENDING_LABEL_MAX),
      transitions,
    };
  });
  const rawStart = isText(raw.startKey) ? raw.startKey.trim() : '';
  const startKey = keyByRawKey.get(rawStart) || rawStart.slice(0, LOOM_LIMITS.OUTLINE_KEY_MAX) || scenes[0]?.key || null;
  return {
    version: 1,
    startKey,
    scenes,
    validation: sanitizeValidation(raw.validation),
  };
}

const outlineIssue = (issues, code, severity, message, extra = {}) => {
  issues.push({ code, severity, message, ...extra });
};

/** Deterministic validation for the log-line graph, independent of an LLM. */
export function analyzeStoryOutline(outline, {
  participationMode = 'protagonist', requireAudienceIntroduction = false,
} = {}) {
  const scenes = asArray(outline?.scenes);
  const byKey = new Map(scenes.map((scene) => [scene.key, scene]));
  const issues = [];
  const push = (code, severity, message, extra = {}) => outlineIssue(issues, code, severity, message, extra);

  if (!scenes.length) {
    push(OUTLINE_ISSUE_CODES.NO_SCENES, 'error', 'The story outline has no scene beats yet.');
  }
  const startKey = outline?.startKey;
  if (!isText(startKey)) {
    if (scenes.length) push(OUTLINE_ISSUE_CODES.MISSING_START, 'error', 'The story outline has no opening beat.');
  } else if (scenes.length && !byKey.has(startKey)) {
    push(OUTLINE_ISSUE_CODES.START_NOT_FOUND, 'error', 'The opening beat points at a key that does not exist.');
  }

  const reachable = new Set();
  const depthByKey = new Map();
  if (byKey.has(startKey)) {
    const queue = [startKey];
    depthByKey.set(startKey, 0);
    let cursor = 0;
    while (cursor < queue.length) {
      const key = queue[cursor];
      cursor += 1;
      if (reachable.has(key)) continue;
      reachable.add(key);
      for (const transition of asArray(byKey.get(key)?.transitions)) {
        if (byKey.has(transition.targetKey) && !depthByKey.has(transition.targetKey)) {
          depthByKey.set(transition.targetKey, depthByKey.get(key) + 1);
          queue.push(transition.targetKey);
        }
      }
    }
  }

  const endings = scenes.filter((scene) => scene.isEnding);
  if (scenes.length && !endings.length) {
    push(OUTLINE_ISSUE_CODES.NO_ENDINGS, 'error', 'The story outline has no ending beat.');
  }
  const reachableEndings = endings.filter((scene) => reachable.has(scene.key));
  if (endings.length && !reachableEndings.length) {
    push(OUTLINE_ISSUE_CODES.NO_ENDINGS, 'error', 'No ending beat is reachable from the opening.');
  }

  if (participationMode === 'helper' && requireAudienceIntroduction && scenes.length) {
    const connected = scenes.filter((scene) => scene.audienceConnection === 'connected' && reachable.has(scene.key));
    if (!connected.length) {
      push(
        OUTLINE_ISSUE_CODES.NO_AUDIENCE_CONNECTION,
        'error',
        'The outline never activates the audience communication channel.',
      );
    } else {
      const firstDepth = Math.min(...connected.map((scene) => depthByKey.get(scene.key)));
      if (firstDepth > 3) {
        push(
          OUTLINE_ISSUE_CODES.LATE_AUDIENCE_CONNECTION,
          'warning',
          'The audience communication channel is not activated until late in the opening sequence.',
          { sceneKey: connected.find((scene) => depthByKey.get(scene.key) === firstDepth)?.key },
        );
      }
    }
  }

  for (const scene of scenes) {
    const transitions = asArray(scene.transitions);
    const label = scene.title || scene.key || 'Untitled beat';
    if (!isText(scene.summary)) {
      push(OUTLINE_ISSUE_CODES.EMPTY_SUMMARY, 'error', `"${label}" has no scene log-line.`, { sceneKey: scene.key });
    }
    if (!reachable.has(scene.key)) {
      push(OUTLINE_ISSUE_CODES.UNREACHABLE_SCENE, 'error', `"${label}" cannot be reached from the opening beat.`, { sceneKey: scene.key });
    }
    if (!scene.isEnding && !transitions.length) {
      push(OUTLINE_ISSUE_CODES.DEAD_END, 'error', `"${label}" has no path to a later beat.`, { sceneKey: scene.key });
    }
    if (scene.isEnding && transitions.length) {
      push(OUTLINE_ISSUE_CODES.ENDING_WITH_TRANSITIONS, 'error', `Ending "${label}" must not have outgoing paths.`, { sceneKey: scene.key });
    }
    if (!scene.isEnding && scene.playbackMode === 'cut' && transitions.length !== 1) {
      push(
        OUTLINE_ISSUE_CODES.CUT_TRANSITION_COUNT,
        'error',
        `Automatic beat "${label}" must have exactly one next beat.`,
        { sceneKey: scene.key },
      );
    }
    if (!scene.isEnding && scene.playbackMode !== 'cut'
      && (transitions.length < 2 || transitions.length > 4)) {
      push(
        OUTLINE_ISSUE_CODES.DECISION_TRANSITION_COUNT,
        'error',
        `Decision beat "${label}" needs 2–4 distinct viewer paths.`,
        { sceneKey: scene.key },
      );
    }
    if (participationMode === 'helper' && !scene.isEnding
      && scene.audienceConnection !== 'connected' && scene.playbackMode !== 'cut') {
      push(
        OUTLINE_ISSUE_CODES.DISCONNECTED_DECISION,
        'error',
        `"${label}" asks for viewer input while the communication channel is disconnected.`,
        { sceneKey: scene.key },
      );
    }

    const seenIntents = new Set();
    transitions.forEach((transition, transitionIndex) => {
      const intent = isText(transition.intent) ? transition.intent.trim().toLowerCase() : '';
      if (!intent) {
        push(
          OUTLINE_ISSUE_CODES.EMPTY_INTENT,
          'error',
          `A path out of "${label}" has no choice label.`,
          { sceneKey: scene.key, transitionIndex },
        );
      } else if (seenIntents.has(intent)) {
        push(
          OUTLINE_ISSUE_CODES.DUPLICATE_INTENT,
          'warning',
          `"${label}" repeats the choice label "${transition.intent}".`,
          { sceneKey: scene.key, transitionIndex },
        );
      } else {
        seenIntents.add(intent);
      }
      if (!byKey.has(transition.targetKey)) {
        push(
          OUTLINE_ISSUE_CODES.DANGLING_TRANSITION,
          'error',
          `A path out of "${label}" points at a missing beat.`,
          { sceneKey: scene.key, transitionIndex },
        );
      } else if (transition.targetKey === scene.key) {
        push(
          OUTLINE_ISSUE_CODES.SELF_LOOP,
          'warning',
          `"${label}" loops straight back to itself.`,
          { sceneKey: scene.key, transitionIndex },
        );
      }
    });
  }

  const stats = {
    sceneCount: scenes.length,
    automaticCutCount: scenes.filter((scene) => !scene.isEnding && scene.playbackMode === 'cut').length,
    decisionCount: scenes.filter((scene) => !scene.isEnding && scene.playbackMode !== 'cut').length,
    endingCount: endings.length,
    reachableCount: reachable.size,
    reachableEndingCount: reachableEndings.length,
    maxDepth: depthByKey.size ? Math.max(...depthByKey.values()) : 0,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
  };
  return { issues, stats };
}

const sortedTransitionContract = (transitions, targetKey) => asArray(transitions)
  .map((transition) => `${transition?.[targetKey] || ''}\u0000${transition?.intent || ''}`)
  .sort();

/** Validate that a persisted beat outline still mirrors an expanded teleplay. */
export function analyzeStoryOutlineTeleplaySync(episode, outline, {
  participationMode = 'protagonist',
} = {}) {
  const nodes = asArray(episode?.nodes);
  if (!nodes.length) return { issues: [], stats: { errorCount: 0, matches: true } };
  const scenes = asArray(outline?.scenes);
  const byKey = new Map(scenes.map((scene) => [scene.key, scene]));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const issues = [];
  const push = (code, message, extra = {}) => outlineIssue(issues, code, 'error', message, extra);

  if (scenes.length !== nodes.length
    || byKey.size !== nodes.length
    || scenes.some((scene) => !nodeIds.has(scene.key))) {
    push(
      OUTLINE_ISSUE_CODES.TELEPLAY_SCENE_MEMBERSHIP_MISMATCH,
      'The beat outline does not cover every expanded teleplay scene exactly once.',
    );
  }
  if (outline?.startKey !== episode?.startNodeId) {
    push(
      OUTLINE_ISSUE_CODES.TELEPLAY_START_MISMATCH,
      'The beat outline opening does not match the expanded teleplay opening scene.',
      { sceneKey: outline?.startKey || undefined },
    );
  }
  for (const node of nodes) {
    const scene = byKey.get(node.id);
    if (!scene) continue;
    const expectedProtagonistPresence = node.protagonistPresence
      || (participationMode === 'helper'
        && node.audienceConnection === 'connected'
        && node.playbackMode !== 'cut'
        ? 'offscreen'
        : 'onscreen');
    const semanticFieldsMatch = scene.title === node.title
      && scene.playbackMode === node.playbackMode
      && scene.audienceConnection === node.audienceConnection
      && scene.protagonistPresence === expectedProtagonistPresence
      && scene.isEnding === node.isEnding
      && (scene.endingLabel || '') === (node.endingLabel || '');
    const outlineTransitions = sortedTransitionContract(scene.transitions, 'targetKey');
    const nodeTransitions = sortedTransitionContract(node.transitions, 'targetNodeId');
    if (!semanticFieldsMatch || JSON.stringify(outlineTransitions) !== JSON.stringify(nodeTransitions)) {
      push(
        OUTLINE_ISSUE_CODES.TELEPLAY_SCENE_CONTRACT_MISMATCH,
        `Beat "${scene.title || scene.key}" no longer matches its expanded teleplay scene contract.`,
        { sceneKey: node.id },
      );
    }
  }

  return {
    issues,
    stats: { errorCount: issues.length, matches: issues.length === 0 },
  };
}

/**
 * Validate outline coverage for the complete series. This is the hard gate
 * used by teleplay expansion: authors can draft episodes in order, but no
 * episode is expanded until the whole series has a validated beat arc and its
 * optional delivery handoffs are authored.
 */
export function analyzeSeriesStoryOutlines(loom) {
  const episodes = asArray(loom?.episodes);
  const issues = [];
  const readyEpisodeIds = new Set();
  const push = (code, severity, message, extra = {}) => outlineIssue(issues, code, severity, message, extra);
  const validVoicemails = new Map(asArray(loom?.seriesPlan?.interEpisodeVoicemails)
    .filter((item) => item?.fromEpisodeId && item?.toEpisodeId)
    .map((item) => [`${item.fromEpisodeId}::${item.toEpisodeId}`, item]));

  episodes.forEach((episode, index) => {
    if (!episode?.storyOutline) {
      push(
        OUTLINE_ISSUE_CODES.MISSING_EPISODE_OUTLINE,
        'error',
        `Episode ${episode?.number || index + 1} has no beat outline yet.`,
        { episodeId: episode?.id },
      );
      return;
    }
    const validation = analyzeStoryOutline(episode.storyOutline, {
      participationMode: loom?.participationMode,
      requireAudienceIntroduction: index === 0,
    });
    validation.issues.forEach((issue) => {
      push(issue.code, issue.severity, `Episode ${episode.number || index + 1}: ${issue.message}`, {
        episodeId: episode.id,
        ...(issue.sceneKey ? { sceneKey: issue.sceneKey } : {}),
        ...(Number.isInteger(issue.transitionIndex) ? { transitionIndex: issue.transitionIndex } : {}),
      });
    });
    const teleplaySync = analyzeStoryOutlineTeleplaySync(episode, episode.storyOutline, {
      participationMode: loom?.participationMode,
    });
    teleplaySync.issues.forEach((issue) => {
      push(
        issue.code,
        issue.severity,
        `Episode ${episode.number || index + 1}: ${issue.message}`,
        {
          episodeId: episode.id,
          ...(issue.sceneKey ? { sceneKey: issue.sceneKey } : {}),
        },
      );
    });
    if (episode.storyOutline.validation?.status !== 'valid') {
      push(
        OUTLINE_ISSUE_CODES.EPISODE_OUTLINE_NOT_VALIDATED,
        'error',
        `Episode ${episode.number || index + 1}'s beat outline must be validated before teleplay expansion.`,
        { episodeId: episode.id },
      );
    } else if (validation.stats.errorCount === 0 && teleplaySync.stats.matches) {
      readyEpisodeIds.add(episode.id);
    }
  });

  const delivery = loom?.seriesPlan?.deliveryOptions || {};
  if (delivery.overnightVoicemails === true) {
    episodes.slice(0, -1).forEach((fromEpisode, index) => {
      const toEpisode = episodes[index + 1];
      const key = `${fromEpisode.id}::${toEpisode.id}`;
      const voicemail = validVoicemails.get(key);
      if (!voicemail) {
        push(
          OUTLINE_ISSUE_CODES.MISSING_OVERNIGHT_VOICEMAIL,
          'error',
          `The handoff from Episode ${fromEpisode.number} to Episode ${toEpisode.number} needs an overnight voicemail.`,
          { episodeId: fromEpisode.id },
        );
      } else if (!isText(voicemail.transcript)) {
        push(
          OUTLINE_ISSUE_CODES.EMPTY_OVERNIGHT_VOICEMAIL,
          'error',
          `The overnight voicemail from Episode ${fromEpisode.number} to Episode ${toEpisode.number} has no transcript.`,
          { episodeId: fromEpisode.id },
        );
      }
    });
  }
  if (delivery.nextSeasonTeaser === true && !isText(loom?.seriesPlan?.nextSeasonTeaser?.transcript)) {
    push(
      OUTLINE_ISSUE_CODES.MISSING_NEXT_SEASON_TEASER,
      'error',
      'The final episode needs a next-season teaser or cliffhanger transcript.',
      { episodeId: episodes.at(-1)?.id },
    );
  }

  const readyEpisodeCount = readyEpisodeIds.size;
  return {
    issues,
    stats: {
      episodeCount: episodes.length,
      readyEpisodeCount,
      errorCount: issues.filter((issue) => issue.severity === 'error').length,
      warningCount: issues.filter((issue) => issue.severity === 'warning').length,
      ready: episodes.length > 0 && issues.every((issue) => issue.severity !== 'error'),
    },
  };
}

export const outlineValidationStatus = (validation) => {
  if (!validation?.stats) return 'draft';
  return validation.stats.errorCount ? 'invalid' : 'valid';
};

/** Compact outline rendering for the outline-review and expansion prompts. */
export function describeStoryOutlineForPrompt(outline) {
  const scenes = asArray(outline?.scenes);
  const byKey = new Map(scenes.map((scene) => [scene.key, scene]));
  return scenes.map((scene, index) => {
    const flags = [
      scene.key === outline?.startKey ? 'START' : null,
      scene.isEnding ? `ENDING${scene.endingLabel ? `: ${scene.endingLabel}` : ''}` : null,
      scene.isEnding ? null : scene.playbackMode === 'cut' ? 'AUTO CUT' : 'DECISION',
      scene.audienceConnection === 'connected' ? 'AUDIENCE CONNECTED' : 'AUDIENCE DISCONNECTED',
      scene.protagonistPresence === 'offscreen' ? 'PROTAGONIST OFF-SCREEN' : 'PROTAGONIST ON-SCREEN',
    ].filter(Boolean);
    const paths = asArray(scene.transitions).map((transition) => {
      const target = byKey.get(transition.targetKey);
      return `-> [${transition.targetKey || '?'}] ${transition.intent || '(unlabeled)'}${target?.title ? ` (${target.title})` : ''}`;
    });
    return [
      `${index + 1}. [${scene.key}] ${scene.title || 'Untitled beat'}${flags.length ? ` (${flags.join(') (')})` : ''}`,
      scene.summary || '(no log-line)',
      ...paths,
    ].join('\n');
  }).join('\n\n');
}
