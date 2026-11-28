"""PortOS realtime voice sidecar: a full-duplex speech-to-speech session on Apple silicon with a tool hand-off.

The voice is a locally installed Sophon-Realtime Mac build (MLX). It listens, takes turns, can be interrupted and speaks. When a
request needs a lookup or an action it says a short lead-in and calls one tool, `delegate(task)`. This sidecar cuts that call out
of the spoken reply, sends it to PortOS, and when PortOS answers with the result (from its own tool-calling text model) the voice
speaks it as a follow-up turn. This is the Mac-side counterpart of Sophon's GPU "Live mode" tool bridge, which the Mac engine lacks.

The Sophon engine is imported from its install folder (--app), not vendored. `_speak` adapts `Brain.reply` from that engine
(Apache-2.0, adventists-ai/sophon-realtime mac/engine.py) so a reply can follow a tool result instead of new user speech.

Wire protocol (one WebSocket, loopback only, `?token=` must match --token):
  in  binary   PCM16 mono at --rate (microphone, after the browser's own echo cancellation)
  in  text     {"type": "tool_result", "call_id": str, "output": str}   result of a delegated task, spoken as the next reply
               {"type": "interrupt"}                                    stop talking now
  out binary   PCM16 mono at 24 kHz (reply audio, sent as soon as it is generated)
  out text     {"type": "ready"} | {"type": "interrupt"} (drop buffered audio: the user barged in)
               {"type": "delegate", "call_id": str, "task": str} | {"type": "reply", "text": str, "cancelled": bool}
               {"type": "event", ...engine event...}

    python portos_sophon.py --app ~/.portos/sophon-mac/app --models ~/.portos/sophon-mac/models --port 5569 --token T
"""
import argparse, asyncio, json, os, re, sys, threading, time, uuid
from urllib.parse import parse_qs, urlparse

ap = argparse.ArgumentParser()
ap.add_argument("--app", required=True, help="the Sophon Mac install's app folder (engine.py)")
ap.add_argument("--models", required=True, help="the Sophon Mac model folder")
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--token", required=True)
ap.add_argument("--rate", type=int, default=16000, help="sample rate of the incoming PCM16")
ap.add_argument("--lang", default="en")
ap.add_argument("--voice", default="chelsie")
ap.add_argument("--persona", default="", help="extra system prompt text (name, style)")
a = ap.parse_args()
sys.path.insert(0, a.app)

import numpy as np  # noqa: E402
import mlx.core as mx  # noqa: E402
import websockets  # noqa: E402
import engine  # noqa: E402
from engine import Brain, Session, SR  # noqa: E402

OUT_RATE = 24000
TC_OPEN, TC_CLOSE = "<tool_call>", "</tool_call>"
TOOL_RE = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|$)", re.S)

DELEGATE = {"type": "function", "function": {
    "name": "delegate",
    "description": "Hand the user's request to the assistant's back office, which can read the clock and date, the weather, the user's "
                   "calendar, goals, daily log, notes and brain inbox, the server and app status, and can make changes in the PortOS app. "
                   "It cannot hear the call: write everything it needs in task.",
    "parameters": {"type": "object", "properties": {"task": {"type": "string", "description":
        "The user's full request in their own words, with every detail they said (names, numbers, dates, the exact text to save)."}},
        "required": ["task"]}}}

# The wording the Flash engine's tool prompt uses (sophon_realtime/tools.py SYS_TOOL), which the model follows; the last sentence
# stops the voice claiming an action or a fact it never got from a tool.
TOOL_RULES = ("You can call the tools listed above. When you need one: first say one very short spoken phrase about what you're doing "
              "(e.g. \"Let me check that\"), then immediately output the tool call in the required format; the tool name, arguments and "
              "format are never spoken, so don't repeat them out loud. When the tool result comes back, tell the user the result in one or "
              "two natural spoken sentences. For chit-chat or anything you can answer yourself, don't call a tool. Never claim you did "
              "something, and never state the time, date, a calendar entry, a log entry or a status, unless a tool result told you.")


def cut_tool(text, final=False):
    """What may be spoken: everything before the first <tool_call>; while streaming, a trailing prefix of the tag is held back."""
    i = text.find(TC_OPEN)
    if i >= 0: return text[:i]
    if not final:
        for k in range(len(TC_OPEN) - 1, 0, -1):
            if text.endswith(TC_OPEN[:k]): return text[:-k]
    return text


def parse_calls(text):
    calls = []
    for m in TOOL_RE.finditer(text or ""):
        try: obj = json.loads(m.group(1))
        except ValueError: continue
        if isinstance(obj, dict) and isinstance(obj.get("name"), str):
            args = obj.get("arguments")
            if isinstance(args, str):
                try: args = json.loads(args)
                except ValueError: args = {"task": args}
            calls.append({"id": uuid.uuid4().hex[:12], "name": obj["name"], "arguments": args if isinstance(args, dict) else {}})
    return calls


_tag_clean = engine.tag_clean
engine.tag_clean = lambda s, final: _tag_clean(cut_tool(s, final), final)     # Brain.reply speaks tag_clean(raw): never the call itself

_stream_generate = engine.stream_generate


class ToolBrain(Brain):
    """The Sophon brain with the delegate tool in its prompt and history entries that can carry tool calls and results."""

    def __init__(self, *args, persona="", **kw):
        super().__init__(*args, **kw)
        self.SYS = "\n\n".join(x for x in (self.SYS, persona.strip(), TOOL_RULES) if x)
        self.last_raw = ""
        brain = self

        def recording_generate(*g, **k):                      # keep the raw thinker text (tool call included) for the caller
            brain.last_raw = ""
            for r in _stream_generate(*g, **k):
                brain.last_raw += r.text; yield r
        engine.stream_generate = recording_generate

    def _layout(self, msgs, audios):
        s = self.tok.apply_chat_template(msgs, tools=[DELEGATE], add_generation_prompt=True, tokenize=False, enable_thinking=False)
        parts = s.split("<|audio|>"); ids, sig, embs = [], [], []
        for i, p in enumerate(parts):
            t = self.tok.encode(p, add_special_tokens=False)
            if t: ids += t; sig += t; embs.append(self.lm.model.embed_tokens(mx.array(t)))
            if i < len(audios):
                k, au = audios[i]; e = self.embed(k, au).astype(mx.bfloat16)
                ids += [engine.AUD] * e.shape[0]; sig += [(k, j) for j in range(e.shape[0])]; embs.append(e)
        return ids, mx.concatenate(embs), sig

    def _conv(self, history):
        msgs = [{"role": "system", "content": self.SYS}]; audios = []
        for h in history:
            if h.get("user") is not None:
                msgs.append({"role": "user", "content": "<|audio|>"}); audios.append((h["ukey"], h["user"]))
            calls = h.get("calls")
            if calls:
                msgs.append({"role": "assistant", "content": (h.get("a_text") or "").strip(), "tool_calls": [
                    {"type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}} for c in calls]})
                for c in calls:
                    if c.get("output") is not None: msgs.append({"role": "tool", "content": c["output"]})
            elif h.get("a_audio") is not None:
                msgs.append({"role": "assistant", "content": "<|audio|>"}); audios.append((h["akey"], h["a_audio"]))
            elif h.get("a_text"):
                msgs.append({"role": "assistant", "content": h["a_text"]})
        return msgs, audios

    def followup(self, history, emit, cancelled):
        """Speak the reply that follows a tool result: the same streaming as Brain.reply, from the history alone (no new user audio)."""
        msgs, audios = self._conv(history)
        return self._speak(msgs, audios, emit, cancelled)

    def _speak(self, msgs, audios, emit, cancelled, max_tok=engine.MAX_REPLY_TOK):
        # Adapted from Sophon's Brain.reply: the thinker writes, the talker speaks the stable tokens while it writes.
        from mlx_lm.sample_utils import make_sampler
        ids, E, sig = self._layout(msgs, audios)
        self._prefill(ids, E, sig, len(ids) - 1)
        gen = engine.stream_generate(self.lm, self.tok, mx.array(ids[-1:]), input_embeddings=E[-1:], prompt_cache=self.cache,
                                     max_tokens=max_tok, sampler=make_sampler(temp=0.7, top_p=0.9))
        st = {"raw": "", "sent": 0, "buf": [], "done": False, "ntok": 0, "calls": 0, "clean": ""}
        brain = self

        def pull():
            fin = False
            try:
                r = next(gen); st["raw"] += r.text; st["ntok"] += 1
            except StopIteration:
                fin = True
            txt = engine.tag_clean(st["raw"], fin).lstrip(); tid = brain.tok.encode(txt, add_special_tokens=False) if txt else []
            stable = tid if fin else tid[:-1]
            if len(stable) > st["sent"]:
                st["buf"] += [brain.te([t]) for t in stable[st["sent"]:]]; st["sent"] = len(stable)
            if fin: st["buf"].append(brain.eos); st["done"] = True
            st["clean"] = txt

        while not st["done"] and len(st["buf"]) < engine.LEAD:
            if cancelled(): break
            pull()
        out = []
        if st["buf"] and not cancelled():
            first = st["buf"].pop(0)

            class Trail:
                @property
                def shape(s):
                    st["calls"] += 1
                    if cancelled(): raise KeyboardInterrupt
                    if not st["done"] and st["calls"] % 2 == 0: pull()
                    while not st["done"] and len(st["buf"]) <= st.get("used", 0):
                        if cancelled(): raise KeyboardInterrupt
                        pull()
                    return (1, len(st["buf"]), brain.pad.shape[-1])

                def __getitem__(s, k):
                    st["used"] = k[1].start + 1; return st["buf"][k[1].start]

            pre = mx.concatenate([self.role, mx.concatenate([mx.broadcast_to(self.pad, (1, 5, self.pad.shape[-1])), self.bos], 1) + self.codec[:, :-1],
                                  first + self.codec[:, -1:]], 1)
            self.tts._prepare_generation_inputs = lambda *x, **k: (pre, Trail(), self.pad)
            try:
                for r in self.tts.generate(text="x", lang_code="chinese", stream=True, streaming_interval=engine.STREAM_S, temperature=0.7, max_tokens=4000):
                    if cancelled(): break
                    au = np.array(r.audio, dtype=np.float32); out.append(au); emit(au)
            except KeyboardInterrupt:
                pass
        while not st["done"] and not cancelled(): pull()
        self.sig += [("gen", i) for i in range(st["ntok"])]
        return st["clean"] or cut_tool(st["raw"], True), (np.concatenate(out) if out else None)


class ToolSession(Session):
    """Sophon's session (VAD, turn-taking, barge-in) plus the delegate hand-off and follow-up replies."""

    def __init__(self, *args, on_delegate=None, **kw):
        self.on_delegate = on_delegate
        super().__init__(*args, **kw)

    def _run_resume(self, r):
        # Follow-up replies ride the base worker's "resume" job, so they queue behind turn checks and replies on the one GPU thread.
        if r.get("followup"): return self._run_followup(r)
        if r["resume"].get("followup"): return            # a cut follow-up has no user audio to continue from
        return super()._run_resume(r)

    def _run_reply(self, r):
        super()._run_reply(r)
        calls = parse_calls(self.b.last_raw)
        with self.lock:
            e = r.get("entry")
            if e is not None: e["a_text"] = cut_tool(e.get("a_text") or "", True).strip()   # history keeps the spoken part only
            self.last_said = cut_tool(self.last_said or "", True).strip()
            if not calls or r.get("cancel") or e is None: return
            e["calls"] = calls; e["a_audio"] = None                  # the turn is text + tool calls now, as the chat template expects
        for c in calls:
            task = (c["arguments"] or {}).get("task") if c["name"] == "delegate" else json.dumps({"name": c["name"], "arguments": c["arguments"]})
            self.ev("delegate", call_id=c["id"], task=task)
            if self.on_delegate: self.on_delegate(c["id"], task or "")

    def tool_result(self, call_id, output):
        with self.lock:
            for h in reversed(self.history):
                for c in h.get("calls") or ():
                    if c["id"] == call_id and c.get("output") is None:
                        c["output"] = str(output)[:4000]
                        r = {"user": None, "ukey": None, "cancel": False, "done": False, "gen_s": 0.0, "t_sil": time.time(), "t_out": None,
                             "sgen": self.sgen, "followup": True}
                        self.reply = r; self.prev_user = None; self.t_reply = time.time()
                        self.jobs.put(("resume", r)); return True
        return False

    def _run_followup(self, r):
        t0 = time.time(); r["started"] = True
        while self.speech_ms > 0 and not r["cancel"] and time.time() - t0 < 8: time.sleep(0.05)   # let the user finish first

        def emit(au):
            if r["cancel"]: return
            if r["t_out"] is None:
                r["t_out"] = time.time(); self.ev("first_audio", followup=True, since_result=round(r["t_out"] - t0, 3))
            r["gen_s"] += len(au) / OUT_RATE; self.play(au)

        if r["cancel"]: return
        text, a24 = self.b.followup(list(self.history), emit, lambda: r["cancel"])
        r["text"] = text; r["done"] = True
        with self.lock:
            if not r["cancel"] and text:
                e = {"user": None, "ukey": None, "a_audio": None, "akey": uuid.uuid4().hex, "a_text": text}
                r["entry"] = e; self.history.append(e); self.last_said = text
        self.ev("reply_done", text=text, followup=True, cancelled=r["cancel"], sec=round(time.time() - t0, 2))

    def _commit(self, r, a16, text):
        e = {"user": r["user"], "ukey": r["ukey"], "a_audio": a16, "akey": uuid.uuid4().hex, "a_text": text}
        r["entry"] = e; self.history.append(e)
        size = lambda h: (len(h["user"]) if h.get("user") is not None else 0) + (len(h["a_audio"]) if h.get("a_audio") is not None else 0)
        while len(self.history) > engine.HIST_TURNS or sum(size(h) for h in self.history) / SR > engine.HIST_SEC:
            self.history.pop(0)


async def main():
    print("Loading the model...", flush=True)
    brain = ToolBrain(a.models, lang=a.lang, voice=a.voice, sys_prompt=os.path.join(a.app, "system_prompt.json"), persona=a.persona)
    brain.warmup()
    busy = {"on": False}

    async def handle(ws):
        path = getattr(getattr(ws, "request", None), "path", None) or getattr(ws, "path", "")
        if parse_qs(urlparse(path).query).get("token", [""])[0] != a.token:
            await ws.close(4401, "bad token"); return
        if busy["on"]:
            await ws.close(1013, "one conversation at a time"); return
        busy["on"] = True
        loop = asyncio.get_running_loop(); outq = asyncio.Queue()

        def send_soon(item): loop.call_soon_threadsafe(outq.put_nowait, item)

        def play(x):
            if x is None: send_soon(json.dumps({"type": "interrupt"})); return
            send_soon((np.clip(np.asarray(x, np.float32), -1, 1) * 32767).astype("<i2").tobytes())

        def log(line):
            try: ev = json.loads(line)
            except ValueError: return
            if "text" in ev: ev["text"] = cut_tool(str(ev["text"]), True).strip()
            if ev.get("ev") == "reply_done": send_soon(json.dumps({"type": "reply", "text": ev["text"], "cancelled": ev.get("cancelled", False)}))
            send_soon(json.dumps({"type": "event", **ev}))

        sess = ToolSession(brain, play, log=log, on_delegate=lambda cid, task: send_soon(json.dumps({"type": "delegate", "call_id": cid, "task": task})))

        async def sender():
            while True:
                item = await outq.get(); await ws.send(item)

        tx = asyncio.ensure_future(sender()); buf = np.zeros(0, np.float32); FR = 320
        await ws.send(json.dumps({"type": "ready"}))
        try:
            async for m in ws:
                if isinstance(m, str):
                    try: o = json.loads(m)
                    except ValueError: continue
                    if o.get("type") == "tool_result": sess.tool_result(str(o.get("call_id", "")), str(o.get("output", "")))
                    elif o.get("type") == "interrupt":
                        with sess.lock: sess._onset()
                    continue
                x = np.frombuffer(m[: len(m) // 2 * 2], "<i2").astype(np.float32) / 32768.0
                if a.rate != SR: x = engine.resample(x, a.rate, SR).astype(np.float32)
                buf = np.concatenate([buf, x])
                while len(buf) >= FR:
                    f, buf = buf[:FR], buf[FR:]; sess.feed(f)
        except websockets.ConnectionClosed:
            pass
        finally:
            with sess.lock:
                if sess.reply is not None: sess.reply["cancel"] = True
            tx.cancel(); busy["on"] = False

    async with websockets.serve(handle, "127.0.0.1", a.port, max_size=1 << 22):
        print(json.dumps({"ready": True, "port": a.port}), flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: os._exit(0)
