import { spawn } from 'child_process';
import { PassThrough } from 'stream';

class MediaService {
  constructor() {
    this.videoProcess = null;
    this.audioProcess = null;
    this.videoStream = null;
    this.audioStream = null;
    this.devices = {
      video: [],
      audio: []
    };
  }

  async listDevices() {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-f', 'avfoundation',
        '-list_devices', 'true',
        '-i', ''
      ]);

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

        this.devices = { video: videoDevices, audio: audioDevices };
        resolve(this.devices);
      });

      ffmpeg.on('error', reject);
    });
  }

  startVideoStream(deviceId = '0') {
    if (this.videoProcess) {
      this.stopVideoStream();
    }

    this.videoStream = new PassThrough();

    // Use MJPEG format for compatibility and low latency
    this.videoProcess = spawn('ffmpeg', [
      '-f', 'avfoundation',
      '-video_size', '1280x720',
      '-framerate', '30',
      '-i', `${deviceId}:none`,
      '-f', 'mjpeg',
      '-q:v', '5',
      '-'
    ]);

    this.videoProcess.stdout.pipe(this.videoStream);

    this.videoProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!msg.includes('frame=') && !msg.includes('fps=')) {
        console.log(`📹 FFmpeg video: ${msg.trim()}`);
      }
    });

    this.videoProcess.on('error', (err) => {
      console.error(`❌ Video stream error: ${err.message}`);
    });

    this.videoProcess.on('close', () => {
      console.log('📹 Video stream stopped');
      this.videoStream = null;
    });

    return this.videoStream;
  }

  startAudioStream(deviceId = '0') {
    if (this.audioProcess) {
      this.stopAudioStream();
    }

    this.audioStream = new PassThrough();

    // Use WebM format with Opus codec for web compatibility
    this.audioProcess = spawn('ffmpeg', [
      '-f', 'avfoundation',
      '-i', `:${deviceId}`,
      '-f', 'webm',
      '-acodec', 'libopus',
      '-ac', '1',
      '-ar', '48000',
      '-b:a', '128k',
      '-'
    ]);

    this.audioProcess.stdout.pipe(this.audioStream);

    this.audioProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!msg.includes('frame=') && !msg.includes('size=')) {
        console.log(`🎤 FFmpeg audio: ${msg.trim()}`);
      }
    });

    this.audioProcess.on('error', (err) => {
      console.error(`❌ Audio stream error: ${err.message}`);
    });

    this.audioProcess.on('close', () => {
      console.log('🎤 Audio stream stopped');
      this.audioStream = null;
    });

    return this.audioStream;
  }

  stopVideoStream() {
    if (this.videoProcess) {
      this.videoProcess.kill('SIGTERM');
      this.videoProcess = null;
      this.videoStream = null;
    }
  }

  stopAudioStream() {
    if (this.audioProcess) {
      this.audioProcess.kill('SIGTERM');
      this.audioProcess = null;
      this.audioStream = null;
    }
  }

  stopAll() {
    this.stopVideoStream();
    this.stopAudioStream();
  }

  isVideoStreaming() {
    return this.videoProcess !== null && this.videoStream !== null;
  }

  isAudioStreaming() {
    return this.audioProcess !== null && this.audioStream !== null;
  }

  getVideoStream() {
    return this.videoStream;
  }

  getAudioStream() {
    return this.audioStream;
  }
}

export default new MediaService();
