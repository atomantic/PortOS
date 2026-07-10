import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { safeChildProcessEnv } from '../lib/processEnv.js';

let videoProcess = null;
let audioProcess = null;
let videoStream = null;
let audioStream = null;
let devices = { video: [], audio: [] };

async function listDevices() {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'avfoundation',
      '-list_devices', 'true',
      '-i', ''
    ], { env: safeChildProcessEnv() });

    let output = '';

    ffmpeg.stderr.on('data', (data) => {
      output += data.toString();
    });

    ffmpeg.on('close', () => {
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

    ffmpeg.on('error', reject);
  });
}

function startVideoStream(deviceId = '0') {
  if (!/^\d+$/.test(deviceId)) throw new Error('Invalid device ID');
  if (videoProcess) {
    stopVideoStream();
  }

  const stream = new PassThrough();

  // Use MJPEG format for compatibility and low latency
  const process = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-video_size', '1280x720',
    '-framerate', '30',
    '-i', `${deviceId}:none`,
    '-f', 'mjpeg',
    '-q:v', '5',
    '-'
  ], { env: safeChildProcessEnv() });
  videoProcess = process;
  videoStream = stream;

  process.stdout.pipe(stream);

  process.stderr.on('data', (data) => {
    const msg = data.toString();
    if (!msg.includes('frame=') && !msg.includes('fps=')) {
      console.log(`📹 FFmpeg video: ${msg.trim()}`);
    }
  });

  process.on('error', (err) => {
    console.error(`❌ Video stream error: ${err.message}`);
  });

  process.on('close', () => {
    console.log('📹 Video stream stopped');
    if (videoProcess === process) videoProcess = null;
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
  const process = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-i', `:${deviceId}`,
    '-f', 'webm',
    '-acodec', 'libopus',
    '-ac', '1',
    '-ar', '48000',
    '-b:a', '128k',
    '-'
  ], { env: safeChildProcessEnv() });
  audioProcess = process;
  audioStream = stream;

  process.stdout.pipe(stream);

  process.stderr.on('data', (data) => {
    const msg = data.toString();
    if (!msg.includes('frame=') && !msg.includes('size=')) {
      console.log(`🎤 FFmpeg audio: ${msg.trim()}`);
    }
  });

  process.on('error', (err) => {
    console.error(`❌ Audio stream error: ${err.message}`);
  });

  process.on('close', () => {
    console.log('🎤 Audio stream stopped');
    if (audioProcess === process) audioProcess = null;
    if (audioStream === stream) audioStream = null;
  });

  return stream;
}

function stopVideoStream() {
  if (videoProcess) {
    videoProcess.kill('SIGTERM');
    videoProcess = null;
    videoStream = null;
  }
}

function stopAudioStream() {
  if (audioProcess) {
    audioProcess.kill('SIGTERM');
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
