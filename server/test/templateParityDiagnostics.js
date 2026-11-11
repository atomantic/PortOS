// Fixture-only observations: do not wait for events, seek media, or repaint a surface.
// Track detached engine videos as well as the native player's DOM media.
export function installTemplateParityDiagnostics() {
  const videos = new Map(), canvases = new Map();
  const mediaState = video => {
    const quality = video.getVideoPlaybackQuality?.();
    return {
      src: video.getAttribute('src'), connected: video.isConnected,
      scene: video.dataset.documentScene, ready: video.dataset.ready, pausedFrame: video.dataset.pausedFrame,
      currentTime: video.currentTime, readyState: video.readyState, networkState: video.networkState,
      seeking: video.seeking, paused: video.paused, width: video.videoWidth, height: video.videoHeight,
      error: video.error?.code ?? null,
      quality: quality ? { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames, corruptedVideoFrames: quality.corruptedVideoFrames } : null,
    };
  };
  const observe = video => {
    if (videos.has(video)) return;
    const record = { events: [], presented: null };
    videos.set(video, record);
    for (const type of ['loadedmetadata', 'loadeddata', 'seeking', 'seeked', 'canplay', 'error', 'emptied']) {
      video.addEventListener(type, () => {
        record.events.push({ type, at: performance.now(), ...mediaState(video) });
        if (record.events.length > 20) record.events.shift();
      });
    }
    // Keep the most recent compositor report; null explicitly means no callback
    // was observed (common for the engine's detached videos), not frame zero.
    if (video.requestVideoFrameCallback) {
      const presented = (now, metadata) => {
        record.presented = { at: now, ...metadata };
        video.requestVideoFrameCallback(presented);
      };
      video.requestVideoFrameCallback(presented);
    }
  };
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (...args) {
    const element = Reflect.apply(createElement, this, args);
    if (element instanceof HTMLVideoElement) observe(element);
    return element;
  };
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
    const result = Reflect.apply(drawImage, this, [source, ...args]);
    let record = canvases.get(this.canvas);
    if (!record) { record = { count: 0, sources: [] }; canvases.set(this.canvas, record); }
    record.count++;
    record.sources.push({ at: performance.now(), tag: source.tagName || source.constructor.name,
      ...(source instanceof HTMLVideoElement ? mediaState(source) : { src: source.getAttribute?.('src') ?? null }) });
    if (record.sources.length > 8) record.sources.shift();
    return result;
  };
  window.templateParityState = () => {
    // Include parser-created elements too, although the two renderers currently
    // create their videos through document.createElement.
    for (const video of document.querySelectorAll('video')) observe(video);
    const audio = document.querySelector('audio');
    return {
      at: performance.now(), userAgent: navigator.userAgent,
      clock: audio ? { currentTime: audio.currentTime, seeking: audio.seeking, paused: audio.paused, readyState: audio.readyState } : null,
      font: document.fonts.check('900 40px "MV Stencil"'),
      videos: [...videos].map(([video, record]) => ({ ...mediaState(video), ...record })),
      canvases: [...canvases].map(([canvas, record]) => ({ id: canvas.id, testId: canvas.dataset.testid,
        connected: canvas.isConnected, width: canvas.width, height: canvas.height, songFrame: canvas.dataset.songFrame, ...record })),
    };
  };
}
