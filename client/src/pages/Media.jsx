import { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Mic, MicOff, Video, VideoOff, RefreshCw, Settings, Volume2 } from 'lucide-react';
import api from '../services/api';

const MEDIA_CONSTRAINTS_KEY = 'portos-media-constraints';

export default function Media() {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);

  const [streaming, setStreaming] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [devices, setDevices] = useState({ video: [], audio: [] });
  const [selectedVideo, setSelectedVideo] = useState('0');
  const [selectedAudio, setSelectedAudio] = useState('0');
  const [error, setError] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Load saved device preferences
  useEffect(() => {
    const saved = localStorage.getItem(MEDIA_CONSTRAINTS_KEY);
    if (saved) {
      const { videoDeviceId, audioDeviceId } = JSON.parse(saved);
      if (videoDeviceId) setSelectedVideo(videoDeviceId);
      if (audioDeviceId) setSelectedAudio(audioDeviceId);
    }
  }, []);

  // Save device preferences when they change
  useEffect(() => {
    if (selectedVideo || selectedAudio) {
      localStorage.setItem(MEDIA_CONSTRAINTS_KEY, JSON.stringify({
        videoDeviceId: selectedVideo,
        audioDeviceId: selectedAudio
      }));
    }
  }, [selectedVideo, selectedAudio]);

  // Fetch available devices from server
  const fetchDevices = useCallback(async () => {
    const response = await api.get('/media/devices');
    setDevices(response.data);

    // Set default selections if not already set
    if (!selectedVideo && response.data.video.length > 0) {
      setSelectedVideo(response.data.video[0].id);
    }
    if (!selectedAudio && response.data.audio.length > 0) {
      setSelectedAudio(response.data.audio[0].id);
    }
  }, [selectedVideo, selectedAudio]);

  // Set up audio level monitoring from audio element
  const setupAudioAnalyser = useCallback(async (audioElement) => {
    // Clean up existing audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Resume AudioContext if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaElementSource(audioElement);

    analyser.fftSize = 256;
    source.connect(analyser);
    source.connect(audioContext.destination); // Connect to speakers

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;

    // Use time-domain data for better audio level detection
    const dataArray = new Uint8Array(analyser.fftSize);

    const updateLevel = () => {
      analyser.getByteTimeDomainData(dataArray);
      // Calculate RMS (root mean square) for accurate audio level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      setAudioLevel(Math.min(rms * 3, 1)); // Scale up for visibility
      animationFrameRef.current = requestAnimationFrame(updateLevel);
    };

    updateLevel();
  }, []);

  // Start media stream from server
  const startMedia = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    // Start streaming on server
    await api.post('/media/start', {
      videoDeviceId: selectedVideo,
      audioDeviceId: selectedAudio,
      video: videoEnabled,
      audio: audioEnabled
    });

    setStreaming(true);
    setIsLoading(false);
  }, [videoEnabled, audioEnabled, selectedVideo, selectedAudio]);

  // Set up media sources when streaming starts
  useEffect(() => {
    if (!streaming) return;

    const timestamp = Date.now();

    // Set video source to server stream
    if (videoRef.current && videoEnabled) {
      videoRef.current.src = `http://${window.location.hostname}:5554/api/media/video?t=${timestamp}`;
    }

    // Set audio source to server stream and set up analyzer
    if (audioRef.current && audioEnabled) {
      audioRef.current.src = `http://${window.location.hostname}:5554/api/media/audio?t=${timestamp}`;
      audioRef.current.play().then(() => {
        setupAudioAnalyser(audioRef.current);
      }).catch(err => {
        console.error('Audio playback error:', err);
      });
    }
  }, [streaming, videoEnabled, audioEnabled, setupAudioAnalyser]);

  // Stop media stream
  const stopMedia = useCallback(async () => {
    // Stop streaming on server
    await api.post('/media/stop');

    if (videoRef.current) {
      videoRef.current.src = '';
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    setStreaming(false);
    setAudioLevel(0);
  }, []);

  // Toggle video
  const toggleVideo = useCallback(() => {
    const newValue = !videoEnabled;
    setVideoEnabled(newValue);

    if (streaming) {
      // Restart stream with new video setting
      startMedia();
    }
  }, [videoEnabled, streaming, startMedia]);

  // Toggle audio
  const toggleAudio = useCallback(() => {
    const newValue = !audioEnabled;
    setAudioEnabled(newValue);

    if (streaming) {
      // Restart stream with new audio setting
      startMedia();
    }
  }, [audioEnabled, streaming, startMedia]);

  // Fetch devices on mount
  useEffect(() => {
    fetchDevices().catch(err => {
      setError(`Failed to fetch devices: ${err.message}`);
    });
  }, [fetchDevices]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streaming) {
        stopMedia();
      }
    };
  }, [streaming, stopMedia]);

  // Handle device change
  const handleDeviceChange = useCallback(async (type, deviceId) => {
    if (type === 'video') {
      setSelectedVideo(deviceId);
    } else {
      setSelectedAudio(deviceId);
    }

    // Restart stream with new device if currently streaming
    if (streaming) {
      // Small delay to let state update
      setTimeout(() => startMedia(), 100);
    }
  }, [streaming, startMedia]);

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Server Media Devices</h2>
          <p className="text-gray-500">Access camera and microphone from the PortOS server</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(s => !s)}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              showSettings
                ? 'bg-port-accent text-white'
                : 'bg-port-card border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50'
            }`}
          >
            <Settings size={16} />
            <span className="hidden sm:inline">Settings</span>
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-6 p-4 bg-port-error/10 border border-port-error/30 rounded-lg text-port-error">
          {error}
        </div>
      )}

      {/* Settings panel */}
      {showSettings && (
        <div className="mb-6 p-4 bg-port-card border border-port-border rounded-xl">
          <h3 className="text-lg font-semibold text-white mb-4">Device Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Video device selector */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">
                <Camera size={14} className="inline mr-2" />
                Camera
              </label>
              <select
                value={selectedVideo}
                onChange={(e) => handleDeviceChange('video', e.target.value)}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
              >
                {devices.video.length === 0 ? (
                  <option value="">No cameras found</option>
                ) : (
                  devices.video.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* Audio device selector */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">
                <Mic size={14} className="inline mr-2" />
                Microphone
              </label>
              <select
                value={selectedAudio}
                onChange={(e) => handleDeviceChange('audio', e.target.value)}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
              >
                {devices.audio.length === 0 ? (
                  <option value="">No microphones found</option>
                ) : (
                  devices.audio.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Video preview */}
        <div className="lg:col-span-2">
          <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
            <div className="aspect-video bg-black relative">
              {streaming && videoEnabled ? (
                <img
                  ref={videoRef}
                  alt="Server camera stream"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500">
                  <VideoOff size={48} className="mb-4" />
                  <p className="text-sm">
                    {!streaming ? 'Camera not started' : 'Camera disabled'}
                  </p>
                </div>
              )}
              {/* Hidden audio element for playback */}
              <audio ref={audioRef} crossOrigin="anonymous" style={{ display: 'none' }} />

              {/* Loading overlay */}
              {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <RefreshCw size={32} className="text-white animate-spin" />
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="p-4 flex items-center justify-center gap-4">
              <button
                onClick={toggleVideo}
                disabled={!streaming}
                className={`p-3 rounded-full transition-colors ${
                  videoEnabled
                    ? 'bg-port-card border border-port-border text-white hover:bg-port-border'
                    : 'bg-port-error/20 text-port-error'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                title={videoEnabled ? 'Disable camera' : 'Enable camera'}
              >
                {videoEnabled ? <Video size={20} /> : <VideoOff size={20} />}
              </button>

              <button
                onClick={toggleAudio}
                disabled={!streaming}
                className={`p-3 rounded-full transition-colors ${
                  audioEnabled
                    ? 'bg-port-card border border-port-border text-white hover:bg-port-border'
                    : 'bg-port-error/20 text-port-error'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                title={audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
              >
                {audioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
              </button>

              {!streaming ? (
                <button
                  onClick={startMedia}
                  disabled={isLoading}
                  className="px-6 py-3 bg-port-accent text-white rounded-full font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? 'Starting...' : 'Start Media'}
                </button>
              ) : (
                <button
                  onClick={stopMedia}
                  className="px-6 py-3 bg-port-error text-white rounded-full font-medium hover:bg-port-error/80 transition-colors"
                >
                  Stop Media
                </button>
              )}

              <button
                onClick={fetchDevices}
                disabled={isLoading}
                className="p-3 rounded-full bg-port-card border border-port-border text-gray-400 hover:text-white hover:bg-port-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Refresh devices"
              >
                <RefreshCw size={20} className={isLoading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
        </div>

        {/* Audio level and status */}
        <div className="space-y-4">
          {/* Audio level meter */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <Volume2 size={20} className="text-port-accent" />
              <h3 className="font-semibold text-white">Audio Level</h3>
            </div>

            <div className="space-y-3">
              {/* Visual meter */}
              <div className="h-4 bg-port-bg rounded-full overflow-hidden">
                <div
                  className="h-full transition-all duration-75 rounded-full"
                  style={{
                    width: `${audioLevel * 100}%`,
                    backgroundColor: audioLevel > 0.7
                      ? '#ef4444'
                      : audioLevel > 0.4
                        ? '#f59e0b'
                        : '#22c55e'
                  }}
                />
              </div>

              {/* Level bars */}
              <div className="flex gap-1">
                {[...Array(20)].map((_, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-8 rounded transition-colors ${
                      i / 20 < audioLevel
                        ? i < 12
                          ? 'bg-port-success'
                          : i < 16
                            ? 'bg-port-warning'
                            : 'bg-port-error'
                        : 'bg-port-border'
                    }`}
                  />
                ))}
              </div>

              <p className="text-sm text-gray-500 text-center">
                {!streaming
                  ? 'Start media to see audio levels'
                  : !audioEnabled
                    ? 'Microphone disabled'
                    : audioLevel > 0.1
                      ? 'Receiving audio'
                      : 'No audio detected'}
              </p>
            </div>
          </div>

          {/* Status info */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <h3 className="font-semibold text-white mb-4">Status</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Stream</span>
                <span className={`text-sm font-medium ${streaming ? 'text-port-success' : 'text-gray-500'}`}>
                  {streaming ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-400">Camera</span>
                <span className={`text-sm font-medium ${
                  streaming && videoEnabled ? 'text-port-success' : 'text-gray-500'
                }`}>
                  {streaming ? (videoEnabled ? 'On' : 'Off') : '-'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-400">Microphone</span>
                <span className={`text-sm font-medium ${
                  streaming && audioEnabled ? 'text-port-success' : 'text-gray-500'
                }`}>
                  {streaming ? (audioEnabled ? 'On' : 'Off') : '-'}
                </span>
              </div>
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <h3 className="font-semibold text-white mb-3">Instructions</h3>
            <ul className="space-y-2 text-sm text-gray-400">
              <li>1. Click &quot;Start Media&quot; to stream from server</li>
              <li>2. Video and audio stream from the PortOS server</li>
              <li>3. Use controls to toggle camera/mic</li>
              <li>4. Select different devices in Settings</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
