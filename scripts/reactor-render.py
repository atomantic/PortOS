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
from pathlib import Path

from reactor_sdk import Reactor


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
        "videoBuffers": [], "audioBuffers": [], "timestamps": [],
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
                    state["timestamps"].append(timestamp_us)
                    state["size"] = (width, height)
                    state["videoBuffers"].append(bytes(bgra))
                    state["frames"] += 1

            def on_audio(pcm, num_samples, sample_rate, num_channels):
                if state["active"]:
                    state["audio"] = (sample_rate, num_channels)
                    state["audioBuffers"].append(bytes(pcm))

            reactor.tracks.with_direction("recvonly").with_kind("video").one().on_raw_frame(on_video)
            reactor.tracks.with_direction("recvonly").with_kind("audio").one().on_raw_frame(on_audio)
            phase = "canvas"
            await reactor.send_command("set_canvas", {"aspect": "16:9"})
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
            expected = int(clip.get("frames", round(seconds * 24)))
            # WebRTC may skip decoded frames. Keep presentation time (and audio
            # sync) by holding the previous frame across timestamp gaps.
            if frames:
                timestamps = state["timestamps"]
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
        (scratch_path / "capture.json").write_text(json.dumps({"frames": state["frames"], "expected": expected, "size": state["size"], "audio": state["audio"], "clipId": clip["clip_id"]}))
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
        shutil.rmtree(scratch_path)
        emit("complete", clipId=clip["clip_id"], seconds=expected / 24)
    except Exception as error:
        emit("error", phase=phase, errorType=type(error).__name__)
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
