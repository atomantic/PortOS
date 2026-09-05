"""Render one FastH3 clip through Reactor's SDK; JSON input/output over stdio.

Credentials arrive only over stdin. No session opens before an explicit render.
The SDK's decoded video/audio tracks are captured while the clip plays, then
muxed locally. See https://www.reactor.inc/models/fast-h3/api.
"""
import asyncio
import json
import math
import signal
import sys
import shutil
import time
from pathlib import Path

from reactor_sdk import Reactor

# The canvases fast-h3 renders, mirroring server/lib/reactorVideoClip.js. Every
# one holds a 768px short edge, so `set_canvas`'s aspect string is the whole
# choice. Pinning "16:9" for every render is what squeezed a portrait starting
# frame into a landscape session and returned a clip with audio and no picture.
CANVASES = {"16:9": (1344, 768), "4:3": (1024, 768), "1:1": (768, 768), "9:16": (768, 1344)}
DEFAULT_ASPECT = "16:9"


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}), flush=True)


def payload(reply):
    return reply.get("data", reply) if isinstance(reply, dict) else {}


async def render(params):
    prompt = params.get("prompt", "").strip()
    seconds = float(params.get("seconds", 8))
    if not prompt or len(prompt) > 800 or not math.isfinite(seconds) or not 5.167 <= seconds <= 14.375:
        raise ValueError("A prompt of 1–800 characters and duration of 5.167–14.375 seconds are required")
    if not params.get("jwt") or not params.get("outputPath"):
        raise ValueError("Session token and output path are required")
    aspect = params.get("aspect") or DEFAULT_ASPECT
    if aspect not in CANVASES:
        raise ValueError(f"Canvas aspect must be one of {', '.join(CANVASES)}")
    source = params.get("sourceImagePath")
    continue_from = (params.get("continueFromClipId") or "").strip()
    if source and continue_from:
        raise ValueError("A clip continuation and a starting frame are mutually exclusive")
    if source and not Path(source).is_file():
        raise ValueError("Starting frame is missing")
    output = Path(params["outputPath"])
    output.parent.mkdir(parents=True, exist_ok=True)
    reactor = Reactor("reactor/fast-h3", jwt=params["jwt"])
    generated = asyncio.Event()
    finished = asyncio.Event()
    state = {
        "active": False, "frames": 0, "error": None, "size": None, "audio": None,
        "videoBuffers": [], "audioBuffers": [], "timestamps": [], "sizes": [], "arrivals": [],
    }

    def on_message(message):
        kind = message.get("type")
        if kind in ("command_error", "clip_failed"):
            state["error"] = "Reactor rejected the clip or command"
            generated.set()
            finished.set()
        elif kind == "clip_generated":
            generated.set()
        elif kind == "clip_started":
            state["active"] = True
        elif kind in ("clip_finished", "clip_stopped"):
            finished.set()

    reactor.on("message", on_message)
    phase = "connecting"
    try:
        emit("status", message="Connecting to Reactor")
        await asyncio.wait_for(reactor.connect(), 60)
        scratch_path = Path(str(output) + ".capture")
        scratch_path.mkdir(parents=True, exist_ok=True)
        raw_video = scratch_path / "video.bgra"
        raw_audio = scratch_path / "audio.pcm"
        with raw_video.open("wb") as video, raw_audio.open("wb") as audio:
            def on_video(bgra, width, height, frame_id, timestamp_us, user_data):
                if state["active"] and len(state["videoBuffers"]) < 370:
                    # memoryview rejects integer pointers instead of bytes(int)'s
                    # silent allocation of that many zero bytes.
                    try:
                        frame = memoryview(bgra).tobytes()
                    except (TypeError, ValueError):
                        frame = b""
                    if width <= 0 or height <= 0 or len(frame) != width * height * 4:
                        state["error"] = "Invalid Reactor video frame buffer"
                        return
                    state["arrivals"].append(time.monotonic_ns() // 1000)
                    state["timestamps"].append(timestamp_us)
                    state["sizes"].append((width, height))
                    state["videoBuffers"].append(frame)

            def on_audio(pcm, num_samples, sample_rate, num_channels):
                if state["active"]:
                    state["audio"] = (sample_rate, num_channels)
                    state["audioBuffers"].append(bytes(pcm))

            reactor.tracks.with_direction("recvonly").with_kind("video").one().on_raw_frame(on_video)
            reactor.tracks.with_direction("recvonly").with_kind("audio").one().on_raw_frame(on_audio)
            phase = "canvas"
            await reactor.send_command("set_canvas", {"aspect": aspect})
            request = {"prompt": prompt, "seconds": seconds}
            if params.get("seed") is not None:
                request["seed"] = int(params["seed"])
            if continue_from:
                # Frame-accurate continuation of a clip fast-h3 already
                # rendered (its id is stamped on the PortOS history record).
                # Reactor owns clip retention, so an id it no longer holds
                # fails here in "enqueue" rather than rendering a fresh shot.
                request["continue_from_clip_id"] = continue_from
            if source:
                phase = "uploading"
                request["starting_frame"] = await reactor.upload_file(source)
            phase = "enqueue"
            reply = payload(await reactor.send_command("enqueue", request))
            clip = reply.get("clip")
            if not clip or not clip.get("clip_id"):
                raise RuntimeError("Reactor did not acknowledge the clip")
            emit("status", message="Rendering clip", seconds=clip.get("seconds"))
            phase = "generating"
            await asyncio.wait_for(generated.wait(), 180)
            if state["error"]:
                raise RuntimeError(state["error"])
            phase = "playing"
            state["active"] = True
            await reactor.send_command("play", {"clip_id": clip["clip_id"]})
            await asyncio.wait_for(finished.wait(), seconds + 30)
            await asyncio.sleep(0.5)
            state["active"] = False
            frames = state.pop("videoBuffers")
            sizes = state.pop("sizes")
            expected = int(clip.get("frames", round(seconds * 24)))
            # A WebRTC track may renegotiate its resolution mid-stream. Every
            # BGRA buffer is then a different length while ffmpeg is told ONE
            # -video_size, so a single odd-sized frame shifts the stride for
            # everything after it and the muxed clip decodes as noise or black
            # while its audio plays fine. Keep only the resolution that carried
            # the most frames; the hold-across-gaps loop below covers the rest.
            if frames:
                # Ties resolve to the larger frame, so the choice is stable
                # rather than set-iteration order.
                dominant = max(set(sizes), key=lambda wh: (sizes.count(wh), wh[0] * wh[1]))
                keep = [index for index, wh in enumerate(sizes) if wh == dominant]
                state["size"] = dominant
                state["frames"] = len(keep)
                timestamps = [state["timestamps"][index] for index in keep]
                # SDK timestamp_us=0 means no metadata, not presentation time.
                # Resampling equal timestamps selects the final (often black)
                # frame for the entire clip. Use receive time in that case.
                if any(t <= 0 for t in timestamps) or any(b <= a for a, b in zip(timestamps, timestamps[1:])):
                    timestamps = [state["arrivals"][index] for index in keep]
                # Rebinding frees the discarded buffers here rather than at the
                # `del` below, which the 370-frame ceiling makes worth doing.
                frames = [frames[index] for index in keep]
            if frames:
                first = timestamps[0]
                cursor = 0
                for index in range(expected):
                    target = first + index * 1_000_000 / 24
                    while cursor + 1 < len(frames) and timestamps[cursor + 1] <= target:
                        cursor += 1
                    video.write(frames[cursor])
            del frames
            audio.writelines(state.pop("audioBuffers"))

            if state["error"]:
                raise RuntimeError(state["error"])
        phase = "capture"
        expected = clip.get("frames", round(seconds * 24))
        (scratch_path / "capture.json").write_text(json.dumps({"frames": state["frames"], "expected": expected, "size": state["size"], "audio": state["audio"], "clipId": clip["clip_id"], "timestampUnique": len(set(state["timestamps"]))}))
        emit("status", message=f"Captured {state['frames']} of {expected} frames; audio={bool(state['audio'])}")
        if state["frames"] < expected * 0.8 or not state["audio"]:
            raise RuntimeError(f"Incomplete stream capture: {state['frames']} of {expected} video frames")
        width, height = state["size"]
        sample_rate, channels = state["audio"]
        command = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pixel_format", "bgra",
                   "-video_size", f"{width}x{height}", "-framerate", "24", "-i", str(raw_video),
                   "-f", "s16le", "-ar", str(sample_rate), "-ac", str(channels), "-i", str(raw_audio),
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-af", "apad", "-t", str(expected / 24),
                   "-movflags", "+faststart", str(output)]
        phase = "encoding"
        encoder = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(encoder.wait(), 60)
        finally:
            if encoder.returncode is None:
                encoder.terminate()
                try:
                    await asyncio.wait_for(encoder.wait(), 2)
                except asyncio.TimeoutError:
                    encoder.kill()
                    await encoder.wait()
        if encoder.returncode or not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError("Could not encode the captured Reactor clip")
        emit("status", message="Capture timestamp diagnostic", unique=len(set(state["timestamps"])))
        shutil.rmtree(scratch_path)
        emit("complete", clipId=clip["clip_id"], seconds=expected / 24, frames=state["frames"])
    except Exception as error:
        emit("error", phase=phase, errorType=type(error).__name__,
             **({"code": "INVALID_FRAME_BUFFER"} if state["error"] == "Invalid Reactor video frame buffer" else {}))
        raise
    finally:
        try:
            await asyncio.wait_for(reactor.disconnect(), 10)
        except Exception:
            emit("status", message="Session cleanup did not acknowledge disconnect")


async def main():
    params = json.loads(sys.stdin.readline())
    task = asyncio.create_task(render(params))
    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        loop.add_signal_handler(signal.SIGTERM, task.cancel)
    await task


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (Exception, asyncio.CancelledError) as error:
        # SDK exceptions may carry remote response internals; never print credentials.
        emit("error", message="Reactor render failed", errorType=type(error).__name__)
        sys.exit(1)
