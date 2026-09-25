// Fixed content and ordering make separate fixture runs comparable.
export const CARDINALITIES = Object.freeze({
  images: 2400, videos: 1200, hiddenImages: 240, hiddenVideos: 120,
  accounts: 2, messages: 4000, detailCharacters: 8192,
});
export const ACCOUNT_IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const date = index => new Date(Date.UTC(2025, 0, 1) + index * 60000).toISOString();
const detail = 'Synthetic collection audit detail. '.repeat(256).slice(0, CARDINALITIES.detailCharacters);

export function mediaFixture(kind, index) {
  const id = 'synthetic-' + kind + '-' + String(index).padStart(5, '0');
  const filename = id + (kind === 'image' ? '.png' : '.mp4');
  return { id, filename, path: '/data/' + (kind === 'image' ? 'images/' : 'videos/') + filename,
    thumbnail: kind === 'video' ? id + '.png' : undefined,
    createdAt: date(index * (kind === 'video' ? 4 : 2) + (kind === 'video' ? 1 : 0)), hidden: index % 10 === 0, width: 640, height: 360,
    prompt: id + ' ' + detail, model: 'synthetic-fixture', status: 'completed',
    ...(kind === 'video' ? { duration: 1, fps: 1 } : {}),
  };
}

export function messageFixture(accountId, index) {
  return { id: 'synthetic-message-' + index, externalId: 'synthetic-external-' + index,
    accountId, threadId: 'synthetic-thread-' + Math.floor(index / 2), subject: 'Synthetic message ' + index,
    from: { name: 'Example Sender', email: 'sender@example.com' }, to: ['recipient@example.com'],
    date: date(index), source: 'gmail', isRead: index % 3 === 0, isUnread: index % 3 !== 0,
    bodyText: detail, bodyHtml: '<p>' + detail + '</p>',
    evaluation: { action: 'review', priority: 'normal', reasoning: detail },
  };
}
