import { describe, expect, it } from 'vitest';
import { findUnsupportedHiggsfieldFamilies, parseHiggsfieldCatalog } from './higgsfieldCatalogScan.js';

// Shape of the server-rendered docs page: `$R[n]=` tags on every object and array.
const mode = (n, slug, title, type, extra = '') => `$R[${n}]={slug:"${slug}",model_slug:"m",title:"${title}",output_type:"${type}",resolutions:$R[${n + 1}]=["720p","1080p"],durations_seconds:$R[${n + 2}]=[3,30],pricing:$R[${n + 3}]={primary:$R[${n + 4}]={amount:"0.1257",qualifier:"from"}}${extra}}`;
const PAGE = [
  mode(10, 'kling-video/v4.0/text-to-video', 'Kling 4.0', 'video'),
  mode(20, 'kling-video/v4.0/video-edit', 'Kling 4.0', 'video'),
  mode(30, 'kling-video/v3.0/pro/text-to-video', 'Kling 3.0', 'video'),
  mode(40, 'soul/text-to-image', 'Soul', 'image'),
  mode(10, 'kling-video/v4.0/text-to-video', 'Kling 4.0', 'video'),
].join(',');

describe('Higgsfield catalog scan', () => {
  it('reads video endpoints once each and skips images', () => {
    const entries = parseHiggsfieldCatalog(PAGE);
    expect(entries.map((e) => e.slug)).toEqual(['kling-video/v4.0/text-to-video', 'kling-video/v4.0/video-edit', 'kling-video/v3.0/pro/text-to-video']);
    expect(entries[0]).toMatchObject({ title: 'Kling 4.0', resolutions: ['720p', '1080p'], minSec: 3, maxSec: 30, pricePerSec: 0.1257 });
  });

  it('groups only the endpoints PortOS does not offer, so a missing route of a known family still shows', () => {
    const unsupported = findUnsupportedHiggsfieldFamilies(parseHiggsfieldCatalog(PAGE), ['kling-video/v4.0/text-to-video', 'kling-video/v3.0/pro/text-to-video']);
    expect(unsupported).toEqual([{ family: 'kling-video/v4.0', title: 'Kling 4.0', routes: ['video-edit'], resolutions: ['720p', '1080p'], minSec: 3, maxSec: 30, pricePerSec: 0.1257 }]);
  });

  it('returns nothing for a page it cannot read', () => {
    expect(parseHiggsfieldCatalog('<html>redesigned</html>')).toEqual([]);
    expect(parseHiggsfieldCatalog(null)).toEqual([]);
  });
});
