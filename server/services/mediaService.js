import { spawn } from '../lib/childProcess.js';
import { PassThrough } from 'stream';
import { safeChildProcessOptions } from '../lib/processEnv.js';

let videoProcess = null;
let audioProcess = null;
let videoStream = null;
let audioStream = null;
let devices = { video: [], audio: [] };
const DEVICE_PROBE_TIMEOUT_MS = 10_000;
const MAX_DEVICE_OUTPUT_BYTES = 1024 * 1024;

async function listDevices() {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'avfoundation',
      '-list_devices', 'true',
      '-i', ''
    ], { ...safeChildProcessOptions(), stdio: ['ignore', 'ignore', 'pipe'] });

    let output = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      ffmpeg.stderr.off('data', onData);
      if (err) reject(err);
      return true;
    };
    const onData = (data) => {
      if (Buffer.byteLength(output) + data.length > MAX_DEVICE_OUTPUT_BYTES) {
        finish(new Error('Media device probe output exceeded limit'));
        ffmpeg.kill('SIGKILL');
        return;
      }
      output += data.toString();
    };
    const timer = setTimeout(() => {
      finish(new Error('Media device probe timed out'));
      ffmpeg.kill('SIGKILL');
    }, DEVICE_PROBE_TIMEOUT_MS);
    ffmpeg.stderr.on('data', onData);

    ffmpeg.once('close', () => {
      if (!finish()) return;
      const videoDevices = [];
      const audioDevices = [];

      const lines = output.split('\n');
      let inVideoSection = false;
      let inAudioSection = false;

      for (const line of lines) {
        if (line.includes('AVFoundation video devices:')) {
          inVideoSection = true;
          inAudioSection = false;
          continue;
        }
        if (line.includes('AVFoundation audio devices:')) {
          inVideoSection = false;
          inAudioSection = true;
          continue;
        }

        const match = line.match(/\[(\d+)\] (.+)/);
        if (match) {
          const [, id, name] = match;
          if (inVideoSection && !name.includes('Capture screen')) {
            videoDevices.push({ id, name: name.trim() });
          } else if (inAudioSection) {
            audioDevices.push({ id, name: name.trim() });
          }
        }
      }

      devices = { video: videoDevices, audio: audioDevices };
      resolve(devices);
    });

    ffmpeg.once('error', err => finish(err));
  });
}

function startVideoStream(deviceId = '0') {
  if (!/^\d+$/.test(deviceId)) throw new Error('Invalid device ID');
  if (videoProcess) {
    stopVideoStream();
  }

  const stream = new PassThrough();

  // Use MJPEG format for compatibility and low latency
  const child = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-video_size', '1280x720',
    '-framerate', '30',
    '-i', `${deviceId}:none`,
    '-f', 'mjpeg',
    '-q:v', '5',
    '-'
  ], safeChildProcessOptions());
  videoProcess = child;
  videoStream = stream;

  child.stdout.pipe(stream);

  child.stderr.on('data', (data) => {
    const msg = data.toString();
    if (!msg.includes('frame=') && !msg.includes('fps=')) {
      console.log(`📹 FFmpeg video: ${msg.trim()}`);
    }
  });

  child.on('error', (err) => {
    console.error(`❌ Video stream error: ${err.message}`);
    stream.end();
    if (videoProcess === child) videoProcess = null;
    if (videoStream === stream) videoStream = null;
  });

  child.on('close', () => {
    console.log('📹 Video stream stopped');
    if (videoProcess === child) videoProcess = null;
    if (videoStream === stream) videoStream = null;
  });

  return stream;
}

function startAudioStream(deviceId = '0') {
  if (!/^\d+$/.test(deviceId)) throw new Error('Invalid device ID');
  if (audioProcess) {
    stopAudioStream();
  }

  const stream = new PassThrough();

  // Use WebM format with Opus codec for web compatibility
  const child = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-i', `:${deviceId}`,
    '-f', 'webm',
    '-acodec', 'libopus',
    '-ac', '1',
    '-ar', '48000',
    '-b:a', '128k',
    '-'
  ], safeChildProcessOptions());
  audioProcess = child;
  audioStream = stream;

  child.stdout.pipe(stream);

  child.stderr.on('data', (data) => {
    const msg = data.toString();
    if (!msg.includes('frame=') && !msg.includes('size=')) {
      console.log(`🎤 FFmpeg audio: ${msg.trim()}`);
    }
  });

  child.on('error', (err) => {
    console.error(`❌ Audio stream error: ${err.message}`);
    stream.end();
    if (audioProcess === child) audioProcess = null;
    if (audioStream === stream) audioStream = null;
  });

  child.on('close', () => {
    console.log('🎤 Audio stream stopped');
    if (audioProcess === child) audioProcess = null;
    if (audioStream === stream) audioStream = null;
  });

  return stream;
}

function stopVideoStream() {
  if (videoProcess) {
    videoProcess.kill('SIGTERM');
    videoStream?.end();
    videoProcess = null;
    videoStream = null;
  }
}

function stopAudioStream() {
  if (audioProcess) {
    audioProcess.kill('SIGTERM');
    audioStream?.end();
    audioProcess = null;
    audioStream = null;
  }
}

function stopAll() {
  stopVideoStream();
  stopAudioStream();
}

function isVideoStreaming() {
  return videoProcess !== null && videoStream !== null;
}

function isAudioStreaming() {
  return audioProcess !== null && audioStream !== null;
}

function getVideoStream() {
  return videoStream;
}

function getAudioStream() {
  return audioStream;
}

export default {
  listDevices,
  startVideoStream,
  startAudioStream,
  stopVideoStream,
  stopAudioStream,
  stopAll,
  isVideoStreaming,
  isAudioStreaming,
  getVideoStream,
  getAudioStream,
};
