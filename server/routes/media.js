import express from 'express';
import { z } from 'zod';
import mediaService from '../services/mediaService.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';

const router = express.Router();
const MAX_JPEG_FRAME_BYTES = 8 * 1024 * 1024;
const JPEG_START = Buffer.from([0xFF, 0xD8]);
const JPEG_END = Buffer.from([0xFF, 0xD9]);

// Validation schemas
const startMediaSchema = z.object({
  videoDeviceId: z.string().optional(),
  audioDeviceId: z.string().optional(),
  video: z.boolean().default(true),
  audio: z.boolean().default(true)
});

// List available media devices
router.get('/devices', asyncHandler(async (req, res) => {
  const devices = await mediaService.listDevices();
  res.json(devices);
}));

// Get current streaming status
router.get('/status', (req, res) => {
  res.json({
    video: mediaService.isVideoStreaming(),
    audio: mediaService.isAudioStreaming()
  });
});

// Start media streaming
router.post('/start', asyncHandler(async (req, res) => {
  const { videoDeviceId = '0', audioDeviceId = '0', video = true, audio = true } = validateRequest(startMediaSchema, req.body);

  if (video) {
    mediaService.startVideoStream(videoDeviceId);
  }

  if (audio) {
    mediaService.startAudioStream(audioDeviceId);
  }

  res.json({
    success: true,
    video: mediaService.isVideoStreaming(),
    audio: mediaService.isAudioStreaming()
  });
}));

// Stop media streaming
router.post('/stop', (req, res) => {
  mediaService.stopAll();
  res.json({ success: true });
});

// Stream video
router.get('/video', (req, res) => {
  const videoStream = mediaService.getVideoStream();

  if (!videoStream) {
    throw new ServerError('Video stream not active', { status: 404 });
  }

  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let frameBuffer = Buffer.alloc(0);

  const cleanup = () => {
    videoStream.off('data', onData);
    videoStream.off('end', onEnd);
    res.off('close', onClose);
  };

  const onData = (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    while (frameBuffer.length) {
      const start = frameBuffer.indexOf(JPEG_START);
      if (start === -1) {
        // A marker can straddle chunks; retain only its possible first byte.
        frameBuffer = frameBuffer.at(-1) === 0xFF ? Buffer.from([0xFF]) : Buffer.alloc(0);
        break;
      }
      frameBuffer = frameBuffer.subarray(start);
      const end = frameBuffer.indexOf(JPEG_END, 2);
      const nextStart = frameBuffer.indexOf(JPEG_START, 2);
      if (nextStart !== -1 && (end === -1 || nextStart < end)) {
        frameBuffer = frameBuffer.subarray(nextStart);
        continue;
      }
      if (end === -1) {
        if (frameBuffer.length > MAX_JPEG_FRAME_BYTES) {
          frameBuffer = frameBuffer.at(-1) === 0xFF ? Buffer.from([0xFF]) : Buffer.alloc(0);
        }
        break;
      }
      if (end + 2 <= MAX_JPEG_FRAME_BYTES) {
        const frame = frameBuffer.subarray(0, end + 2);
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write('\r\n');
      }
      frameBuffer = frameBuffer.subarray(end + 2);
    }
  };

  const onEnd = () => {
    cleanup();
    res.end();
  };

  const onClose = () => {
    cleanup();
    console.log('📹 Video client disconnected');
  };

  videoStream.on('data', onData);
  videoStream.on('end', onEnd);
  res.once('close', onClose);
});

// Stream audio
router.get('/audio', (req, res) => {
  const audioStream = mediaService.getAudioStream();

  if (!audioStream) {
    throw new ServerError('Audio stream not active', { status: 404 });
  }

  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  audioStream.pipe(res);

  res.once('close', () => {
    audioStream.unpipe(res);
    console.log('🎤 Audio client disconnected');
  });
});

export default router;
