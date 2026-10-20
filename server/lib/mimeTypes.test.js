import { describe, it, expect } from 'vitest';
import { detectMediaManifest } from './mimeTypes.js';

// A minimal ID3v2.4 tag (syncsafe size in bytes 6-9) followed by `body`.
const withId3 = (body, padding = 32) => Buffer.concat([
  Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, (padding >> 21) & 0x7f, (padding >> 14) & 0x7f, (padding >> 7) & 0x7f, padding & 0x7f]),
  Buffer.alloc(padding), Buffer.from(body),
]);

const PLAYLIST = '#EXTM3U\n#EXTINF:2.0,\n../private/clip.mp4\n#EXT-X-ENDLIST\n';

describe('detectMediaManifest', () => {
  it.each([
    ['an HLS playlist', Buffer.from(PLAYLIST), 'hls'],
    ['an HLS playlist after a UTF-8 BOM and blank lines', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`\n\n${PLAYLIST}`)]), 'hls'],
    ['an HLS playlist behind an ID3v2 tag (ffmpeg strips it before probing)', withId3(PLAYLIST), 'hls'],
    ['an HLS playlist behind an ID3v2 tag longer than the probe window', withId3(PLAYLIST, 2 * 1024 * 1024), 'hls'],
    ['a concat script', Buffer.from('ffconcat version 1.0\nfile clip.mp4\n'), 'concat'],
    ['a DASH manifest', Buffer.from('<?xml version="1.0"?><MPD profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">'), 'dash'],
    ['an IMF composition', Buffer.from('<?xml version="1.0"?><CompositionPlaylist><ContentTitle>x</ContentTitle>'), 'imf'],
    ['an SDP session', Buffer.from('v=0\r\no=- 0 0 IN IP4 192.0.2.10\r\nc=IN IP4 192.0.2.10\r\nm=audio 5004 RTP/AVP 0\r\n'), 'sdp'],
  ])('names %s', (_label, bytes, expected) => {
    expect(detectMediaManifest(bytes)).toBe(expected);
  });

  it.each([
    ['an MP3 with an ID3v2 tag', withId3(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]))],
    ['a WAV header', Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt ')])],
    ['a FLAC header', Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(8)])],
    ['an Ogg page', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(8)])],
    // Real binary media hits a NUL long before any text; ffmpeg's string probes stop there too.
    ['an MP4 whose later bytes carry playlist text', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from(`${PLAYLIST}<MPD dash:profile`)])],
    ['an MPD mention without a DASH profile', Buffer.from('notes about <MPD> files')],
    ['plain text', Buffer.from('hello uploads')],
  ])('leaves %s alone', (_label, bytes) => {
    expect(detectMediaManifest(bytes)).toBeNull();
  });

  it('returns null for a non-buffer', () => {
    expect(detectMediaManifest('#EXTM3U')).toBeNull();
  });
});
