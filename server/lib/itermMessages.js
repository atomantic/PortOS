// PortOS-authored message declarations for the subset of the iTerm2 scripting
// API the Shell page's iTerm2 view uses (#8114): list sessions, notification
// subscribe/unsubscribe, get buffer, send text and get variable.
//
// PROTOCOL REFERENCE: the iTerm2 API's documented wire protocol — protobuf
// frames (`ClientOriginatedMessage` out, `ServerOriginatedMessage` in) over a
// WebSocket on iTerm2's private Unix socket. Field NUMBERS below match that
// published protocol so the frames interoperate; the field NAMES, structure
// and every line of this file are PortOS's own.
//
// CLEAN-ROOM RULE: iTerm2 and its Python client are GPLv2 and PortOS is MIT.
// Do not vendor `api.proto`, paste its text, or port reference-client code into
// this module. Declare only the messages and fields PortOS actually reads or
// writes; anything else on the wire is skipped by lib/protobufWire.js.

import { decodeMessage, encodeMessage } from './protobufWire.js';

export const ITERM_NOTIFICATION = Object.freeze({
  SCREEN_UPDATE: 2,
  NEW_SESSION: 6,
  TERMINATE_SESSION: 7,
  LAYOUT_CHANGE: 8,
  VARIABLE_CHANGE: 13,
});

export const ITERM_VARIABLE_SCOPE = Object.freeze({ SESSION: 1 });

// The session variables the iTerm2 view shows next to each session.
export const ITERM_SESSION_VARIABLES = Object.freeze(['name', 'jobName', 'path']);

const m = (no, schema, extra = {}) => ({ no, type: 'message', schema, ...extra });

// --- shared geometry ---------------------------------------------------------

const COORD = { x: { no: 1, type: 'varint' }, y: { no: 2, type: 'varint' } };
const SIZE = { width: { no: 1, type: 'varint' }, height: { no: 2, type: 'varint' } };
const RANGE = { location: { no: 1, type: 'varint' }, length: { no: 2, type: 'varint' } };
const COORD_RANGE = { start: m(1, COORD), end: m(2, COORD) };
const WINDOWED_COORD_RANGE = { coordRange: m(1, COORD_RANGE), columns: m(2, RANGE) };

// --- list sessions / layout --------------------------------------------------

const SESSION_SUMMARY = {
  uniqueIdentifier: { no: 1, type: 'string' },
  gridSize: m(3, SIZE),
  title: { no: 4, type: 'string' },
};

// A tab's panes form a binary split tree; each link holds a pane or a subtree.
const SPLIT_TREE_NODE = {
  vertical: { no: 1, type: 'bool' },
  links: m(2, () => SPLIT_TREE_LINK, { repeated: true }),
};
const SPLIT_TREE_LINK = {
  session: m(1, SESSION_SUMMARY),
  node: m(2, SPLIT_TREE_NODE),
};

const LIST_TAB = {
  tabId: { no: 2, type: 'string' },
  root: m(3, SPLIT_TREE_NODE),
};
const LIST_WINDOW = {
  tabs: m(1, LIST_TAB, { repeated: true }),
  windowId: { no: 2, type: 'string' },
  number: { no: 4, type: 'varint' },
};
const LIST_SESSIONS_RESPONSE = {
  windows: m(1, LIST_WINDOW, { repeated: true }),
};

// --- get buffer ------------------------------------------------------------

const LINE_RANGE = {
  screenContentsOnly: { no: 1, type: 'bool' },
  trailingLines: { no: 2, type: 'varint' },
};
const GET_BUFFER_REQUEST = {
  session: { no: 1, type: 'string' },
  lineRange: m(2, LINE_RANGE),
  includeStyles: { no: 3, type: 'bool' },
};
const RGB = { red: { no: 1, type: 'varint' }, green: { no: 2, type: 'varint' }, blue: { no: 3, type: 'varint' } };
// fg/bg are each a oneof: an "alternate" semantic color (0 = default), a
// 24-bit color, or a 256-color palette index.
const CELL_STYLE = {
  fgAlternate: { no: 1, type: 'varint' },
  fgRgb: m(2, RGB),
  fgStandard: { no: 3, type: 'varint' },
  bgAlternate: { no: 5, type: 'varint' },
  bgRgb: m(6, RGB),
  bgStandard: { no: 7, type: 'varint' },
  bold: { no: 9, type: 'bool' },
  faint: { no: 10, type: 'bool' },
  italic: { no: 11, type: 'bool' },
  underline: { no: 13, type: 'bool' },
  strikethrough: { no: 14, type: 'bool' },
  invisible: { no: 15, type: 'bool' },
  inverse: { no: 16, type: 'bool' },
  repeats: { no: 20, type: 'varint' },
};
const CODE_POINTS_PER_CELL = {
  numCodePoints: { no: 1, type: 'varint' },
  repeats: { no: 2, type: 'varint' },
};
const LINE_CONTENTS = {
  text: { no: 1, type: 'string' },
  codePointsPerCell: m(2, CODE_POINTS_PER_CELL, { repeated: true }),
  style: m(4, CELL_STYLE, { repeated: true }),
};
const GET_BUFFER_RESPONSE = {
  status: { no: 1, type: 'varint' },
  range: m(2, RANGE),
  contents: m(3, LINE_CONTENTS, { repeated: true }),
  cursor: m(4, COORD),
  numLinesAboveScreen: { no: 5, type: 'varint' },
  windowedCoordRange: m(6, WINDOWED_COORD_RANGE),
};

// --- notifications -----------------------------------------------------------

const VARIABLE_MONITOR_REQUEST = {
  name: { no: 1, type: 'string' },
  scope: { no: 2, type: 'varint' },
  identifier: { no: 3, type: 'string' },
};
const NOTIFICATION_REQUEST = {
  session: { no: 1, type: 'string' },
  subscribe: { no: 2, type: 'bool' },
  notificationType: { no: 3, type: 'varint' },
  variableMonitorRequest: m(6, VARIABLE_MONITOR_REQUEST),
};
const STATUS_ONLY = { status: { no: 1, type: 'varint' } };
const SESSION_REF = { session: { no: 1, type: 'string' } };
const SESSION_ID_REF = { sessionId: { no: 1, type: 'string' } };
const LAYOUT_CHANGED = { listSessionsResponse: m(1, LIST_SESSIONS_RESPONSE) };
const VARIABLE_CHANGED = {
  scope: { no: 1, type: 'varint' },
  identifier: { no: 2, type: 'string' },
  name: { no: 3, type: 'string' },
  jsonNewValue: { no: 4, type: 'string' },
};
const NOTIFICATION = {
  screenUpdateNotification: m(2, SESSION_REF),
  newSessionNotification: m(6, SESSION_ID_REF),
  terminateSessionNotification: m(7, SESSION_ID_REF),
  layoutChangedNotification: m(8, LAYOUT_CHANGED),
  variableChangedNotification: m(13, VARIABLE_CHANGED),
};

// --- send text / variables ---------------------------------------------------

const SEND_TEXT_REQUEST = {
  session: { no: 1, type: 'string' },
  text: { no: 2, type: 'string' },
};
const VARIABLE_REQUEST = {
  sessionId: { no: 1, type: 'string' },
  get: { no: 5, type: 'string', repeated: true },
};
const VARIABLE_RESPONSE = {
  status: { no: 1, type: 'varint' },
  values: { no: 2, type: 'string', repeated: true },
};

// --- envelopes ---------------------------------------------------------------

export const CLIENT_MESSAGE_SCHEMA = Object.freeze({
  id: { no: 1, type: 'varint' },
  getBufferRequest: m(100, GET_BUFFER_REQUEST),
  notificationRequest: m(103, NOTIFICATION_REQUEST),
  listSessionsRequest: m(106, {}),
  sendTextRequest: m(107, SEND_TEXT_REQUEST),
  variableRequest: m(115, VARIABLE_REQUEST),
});

export const SERVER_MESSAGE_SCHEMA = Object.freeze({
  id: { no: 1, type: 'varint' },
  error: { no: 2, type: 'string' },
  getBufferResponse: m(100, GET_BUFFER_RESPONSE),
  notificationResponse: m(103, STATUS_ONLY),
  listSessionsResponse: m(106, LIST_SESSIONS_RESPONSE),
  sendTextResponse: m(107, STATUS_ONLY),
  variableResponse: m(115, VARIABLE_RESPONSE),
  notification: m(1000, NOTIFICATION),
});

export const encodeItermClientMessage = (msg) => encodeMessage(CLIENT_MESSAGE_SCHEMA, msg);
export const decodeItermClientMessage = (buf) => decodeMessage(CLIENT_MESSAGE_SCHEMA, buf);
export const encodeItermServerMessage = (msg) => encodeMessage(SERVER_MESSAGE_SCHEMA, msg);
export const decodeItermServerMessage = (buf) => decodeMessage(SERVER_MESSAGE_SCHEMA, buf);

// Depth-first pane order of one tab's split tree.
const collectPanes = (node, out = []) => {
  for (const link of node?.links ?? []) {
    if (link.session?.uniqueIdentifier) out.push(link.session);
    else if (link.node) collectPanes(link.node, out);
  }
  return out;
};

/**
 * Flatten a decoded list-sessions (or layout-changed) response into panes in
 * iTerm's own window → tab → pane order. Indexes are 1-based for display.
 */
export const flattenItermLayout = (listSessionsResponse) => {
  const panes = [];
  (listSessionsResponse?.windows ?? []).forEach((window, windowIdx) => {
    (window.tabs ?? []).forEach((tab, tabIdx) => {
      const tabPanes = collectPanes(tab.root);
      tabPanes.forEach((summary, paneIdx) => {
        panes.push({
          uuid: summary.uniqueIdentifier,
          windowId: window.windowId ?? null,
          tabId: tab.tabId ?? null,
          windowIndex: windowIdx + 1,
          tabIndex: tabIdx + 1,
          paneIndex: paneIdx + 1,
          paneCount: tabPanes.length,
          title: summary.title ?? '',
          cols: summary.gridSize?.width ?? 0,
          rows: summary.gridSize?.height ?? 0,
        });
      });
    });
  });
  return panes;
};
