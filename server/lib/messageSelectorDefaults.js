// Shared DOM selector defaults for Messages list scraping and browser compose.

// Provider DOMs change without notice. Messages > Sync exposes the defaults and
// saves overrides in selectors.json. Compose controls only exist in certain views.
export const MESSAGE_SELECTOR_DEFAULTS = Object.freeze({
  outlook: Object.freeze({
    list: Object.freeze({ messageRow: "[role='listbox'] [role='option']" }),
    compose: Object.freeze({
      accountIdentity: '#O365_MainLink_Me, button[aria-label^="Account manager"]',
      newMail: 'button[aria-label="New mail"]',
      replyButton: 'button[aria-label="Reply"]',
      composeBody: '[role="textbox"][aria-label="Message body"]',
      composeSend: 'button[aria-label="Send"]',
      composeDiscard: 'button[aria-label="Discard"]',
      composeSubject: 'input[aria-label="Add a subject"]',
      toField: '[aria-label="To"]',
      ccField: '[aria-label="Cc"]',
      showCc: 'button[aria-label="Cc"]'
    })
  }),
  teams: Object.freeze({
    list: Object.freeze({ messageItem: "[role='listitem']" }),
    compose: Object.freeze({
      accountIdentity: 'button[aria-label^="Your profile"], [data-tid="me-control-avatar"]',
      newChat: 'button[aria-label="New chat"]',
      recipientInput: 'input[aria-label^="To"]',
      recipientSuggestion: '[role="option"]',
      composeBox: '[role="textbox"][aria-label^="Type a"]',
      composeSend: 'button[aria-label="Send"]',
      sentMessage: '[data-tid="chat-pane-message"]'
    })
  })
});

// Match fresh live-region text after submit. Teams uses the rendered chat message for acknowledgement.
export const MESSAGE_COMPOSE_PATTERN_DEFAULTS = Object.freeze({
  sendAckPattern: '(^|\\b)(message sent|your message (was|has been) sent|sent successfully)\\b',
  sendRefusalPattern: "couldn.?t send|could not send|failed to send|unable to send|didn.?t send|wasn.?t sent|not sent|try again"
});

export function isValidComposePattern(value) {
  try {
    new RegExp(value.trim(), 'i');
    return true;
  } catch {
    return false;
  }
}

export function resolveComposeSelectors(provider, stored) {
  return Object.fromEntries(Object.entries(MESSAGE_SELECTOR_DEFAULTS[provider].compose).map(([key, value]) => [
    key, (typeof stored?.[key] === 'string' && stored[key].trim()) || value
  ]));
}
