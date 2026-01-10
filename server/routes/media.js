import express from 'express';
import { z } from 'zod';
import mediaService from '../services/mediaService.js';

const router = express.Router();

// Validation schemas
const startMediaSchema = z.object({
  videoDeviceId: z.string().optional(),
  audioDeviceId: z.string().optional(),
  video: z.boolean().default(true),
  audio: z.boolean().default(true)
});

// List available media devices
router.get('/devices', async (req, res) => {
  const devices = await mediaService.listDevices();
  res.json(devices);
});

// Get current streaming status
router.get('/status', (req, res) => {
  res.json({
    video: mediaService.isVideoStreaming(),
    audio: mediaService.isAudioStreaming()
  });
});

// Start media streaming
router.post('/start', async (req, res) => {
  const { videoDeviceId = '0', audioDeviceId = '0', video = true, audio = true } = startMediaSchema.parse(req.body);

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
});

// Stop media streaming
router.post('/stop', (req, res) => {
  mediaService.stopAll();
  res.json({ success: true });
});

// Stream video
router.get('/video', (req, res) => {
  const videoStream = mediaService.getVideoStream();

  if (!videoStream) {
    return res.status(404).json({ error: 'Video stream not active' });
  }

  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let frameBuffer = Buffer.alloc(0);

  videoStream.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    // Look for JPEG markers
    let start = frameBuffer.indexOf(Buffer.from([0xFF, 0xD8])); // JPEG start
    let end = frameBuffer.indexOf(Buffer.from([0xFF, 0xD9]), start + 2); // JPEG end

    while (start !== -1 && end !== -1) {
      const frame = frameBuffer.slice(start, end + 2);
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');

      frameBuffer = frameBuffer.slice(end + 2);
      start = frameBuffer.indexOf(Buffer.from([0xFF, 0xD8]));
      end = frameBuffer.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
    }
  });

  videoStream.on('end', () => {
    res.end();
  });

  req.on('close', () => {
    console.log('📹 Video client disconnected');
  });
});

// Stream audio
router.get('/audio', (req, res) => {
  const audioStream = mediaService.getAudioStream();

  if (!audioStream) {
    return res.status(404).json({ error: 'Audio stream not active' });
  }

  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  audioStream.pipe(res);

  req.on('close', () => {
    console.log('🎤 Audio client disconnected');
  });
});

export default router;
