/**
 * Dismiss Review Hub alerts that were filed for browser-extension errors.
 *
 * Background:
 *   Extensions (crypto wallets, password managers, ad blockers) inject content
 *   scripts into the page's realm, so anything they throw surfaced through the
 *   app's own `unhandledrejection` handler and was filed as an actionable
 *   `client-error` alert — e.g. "Unhandled rejection: Failed to connect to
 *   MetaMask". Nothing in PortOS can fix those, so the capture path now drops
 *   them (`server/lib/extensionErrors.js`).
 *
 *   That fix is prospective only: alerts already filed stay pending forever,
 *   which is exactly the noise the filter exists to remove. This migration
 *   applies the *same* predicate retroactively so existing installs converge on
 *   the new behavior instead of carrying stale alerts indefinitely.
 *
 * Approach:
 *   - Reuses `isExtensionError` rather than re-encoding "what is an extension
 *     error" here — a second definition would drift from the runtime filter.
 *   - Reconstructs the detection payload from what `recordClientError` stored:
 *     `metadata.source` plus the stack that `buildDescription` appended after
 *     the header block. The header's own `URL:` line (the *page* location) is
 *     deliberately excluded — it is ours even when an extension throws on top
 *     of it, and feeding it to the matcher could misclassify a real error.
 *   - Flips `status` to 'dismissed' rather than deleting: the record keeps its
 *     id and stays auditable, matching how the Review Hub itself clears items.
 *   - Only touches `status: 'pending'` items in `category: 'client-error'`.
 *     Anything the user already triaged is left alone.
 *
 *   No-op by construction on installs with no such alerts (the overwhelmingly
 *   common case) — the file is only rewritten when something actually matched.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { isExtensionError } from '../../server/lib/extensionErrors.js';

const ITEMS_REL = 'data/review/items.json';

// `buildDescription` emits a header block (URL/Source/UA/Type), then a blank
// line, then the stack. Take only what follows the blank line so the page URL
// in the header can never reach the matcher.
function stackFromDescription(description) {
  if (typeof description !== 'string') return '';
  const idx = description.indexOf('\n\n');
  return idx === -1 ? '' : description.slice(idx + 2);
}

// Rebuild the shape `isExtensionError` expects from the stored alert.
// `buildTitle` prefixed the message with "Unhandled rejection: " / "Client
// error: "; strip it so the message matches what was originally reported.
function payloadFromItem(item) {
  const title = typeof item?.title === 'string' ? item.title : '';
  return {
    type: item?.metadata?.kind,
    message: title.replace(/^(?:Unhandled rejection|Client error):\s*/, ''),
    source: item?.metadata?.source,
    stack: stackFromDescription(item?.description),
  };
}

export default {
  async up({ rootDir }) {
    const path = join(rootDir, ITEMS_REL);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log('✅ Review alerts: no items file — nothing to dismiss');
      return { dismissed: 0, reason: 'no-file' };
    }

    let items;
    try {
      items = JSON.parse(raw);
    } catch {
      // A corrupt items file is not this migration's problem to fix, and
      // rewriting it would risk destroying recoverable data.
      console.warn('⚠️ Review alerts: items file is not valid JSON — skipping');
      return { dismissed: 0, reason: 'unparseable' };
    }
    if (!Array.isArray(items)) {
      console.warn('⚠️ Review alerts: items file is not an array — skipping');
      return { dismissed: 0, reason: 'unexpected-shape' };
    }

    const now = new Date().toISOString();
    let dismissed = 0;
    const next = items.map((item) => {
      if (item?.status !== 'pending') return item;
      if (item?.metadata?.category !== 'client-error') return item;
      if (!isExtensionError(payloadFromItem(item))) return item;
      dismissed++;
      return { ...item, status: 'dismissed', updatedAt: now };
    });

    if (dismissed === 0) {
      console.log('✅ Review alerts: no pending browser-extension alerts — no changes');
      return { dismissed: 0 };
    }

    await writeFile(path, JSON.stringify(next, null, 2) + '\n');
    console.log(`🧹 Review alerts: dismissed ${dismissed} browser-extension alert(s)`);
    return { dismissed };
  },
};
