"""Microphone framing for the PortOS realtime voice sidecar: cuts the incoming PCM16 into the 20 ms frames Sophon's
Session.feed takes, with the browser's playback reference for each frame when it sends one (#20512).

With a reference, one binary message is the microphone bytes followed by the same number of reference bytes: what the
speaker played over the same span, after the output volume, timed to the microphone capture by the browser. Sophon raises
its speech threshold with the loudness of the last 200 ms of that reference, so what is left of the reply's echo after the
browser's echo canceller does not read as the user talking over the reply, while louder near-end speech still does. The
browser's echo canceller stays the one echo-cancellation stage; nothing here subtracts the reference from the microphone.

Without a reference (the compatibility path) frames are fed with far=None, as the engine expects for browser-only capture.
After a reference has been seen in the session, a frame without one is fed silence instead, so the engine's playback history
drains rather than keeping a stale level that would leave the threshold raised.
"""
import numpy as np

FRAME = 320  # 20 ms at 16 kHz


def pcm16(data):
    """Little-endian PCM16 bytes to float32 samples in [-1, 1); a trailing odd byte is dropped."""
    return np.frombuffer(data[: len(data) // 2 * 2], "<i2").astype(np.float32) / 32768.0


class FrameFeeder:
    """Buffers incoming audio and calls feed(frame) or feed(frame, far) once per complete 20 ms frame."""

    def __init__(self, feed, rate=16000, sr=16000, resample=None, frame=FRAME):
        self.feed = feed; self.rate = rate; self.sr = sr; self.frame = frame
        self.resample = resample if (resample is not None and rate != sr) else None
        self.reference = False; self.seen_reference = False
        self.mic = np.zeros(0, np.float32); self.far = np.zeros(0, np.float32)

    def set_reference(self, on):
        """The next binary messages carry a reference (on) or are microphone only (off)."""
        self.reference = bool(on)
        if self.reference and not self.seen_reference:
            self.seen_reference = True; self.far = np.zeros(len(self.mic), np.float32)   # audio already buffered had no playback reference

    def _rs(self, x):
        return self.resample(x, self.rate, self.sr).astype(np.float32) if self.resample is not None else x

    def push(self, data):
        if self.reference:
            half = len(data) // 2
            mic, far = self._rs(pcm16(data[:half])), self._rs(pcm16(data[half:]))
            n = min(len(mic), len(far)); mic, far = mic[:n], far[:n]
        else:
            mic = self._rs(pcm16(data))
            far = np.zeros(len(mic), np.float32) if self.seen_reference else None
        self.mic = np.concatenate([self.mic, mic])
        # Keep the reference buffer in step with the microphone buffer whenever a reference has been seen.
        if far is not None: self.far = np.concatenate([self.far, far])
        while len(self.mic) >= self.frame:
            f, self.mic = self.mic[: self.frame], self.mic[self.frame:]
            if self.seen_reference:
                r, self.far = self.far[: self.frame], self.far[self.frame:]
                self.feed(f, r)
            else:
                self.feed(f)
