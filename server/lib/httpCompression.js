import compression from 'compression';
import { constants } from 'node:zlib';

const isStreamingType = (contentType = '') => /^(?:text\/event-stream|application\/x-ndjson|multipart\/x-mixed-replace)(?:\s*;|$)/i.test(contentType);

export const httpCompression = compression({
  threshold: 1024,
  brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
  level: 6,
  filter(req, res) {
    if (req.headers.range || res.getHeader('Content-Encoding')) return false;
    if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(res.getHeader('Cache-Control') || '')) return false;
    if (isStreamingType(res.getHeader('Content-Type'))) return false;
    return compression.filter(req, res);
  },
});
