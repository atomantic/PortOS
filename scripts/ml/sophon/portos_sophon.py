"""PortOS realtime voice sidecar: a full-duplex speech-to-speech session on Apple silicon with a tool hand-off.

The voice is a locally installed Sophon-Realtime Mac build (MLX). It listens, takes turns, can be interrupted and speaks. When a
request needs a lookup or an action it says a short lead-in and calls one tool, `delegate(task)`. This sidecar cuts that call out
of the spoken reply, sends it to PortOS, and when PortOS answers with the result (from its own tool-calling text model) the voice
speaks it as a follow-up turn. This is the Mac-side counterpart of Sophon's GPU "Live mode" tool bridge, which the Mac engine lacks.

The Sophon engine is imported from its install folder (--app), not vendored. `_speak` adapts `Brain.reply` from that engine
(Apache-2.0, adventists-ai/sophon-realtime mac/engine.py) so a reply can follow a tool result instead of new user speech.

Wire protocol (one WebSocket, loopback only, `Authorization: Bearer <token>` must match PORTOS_REALTIME_TOKEN / --token, no browser Origin):
  in  binary   PCM16 mono at --rate (microphone, after the browser's own echo cancellation)
  in  text     {"type": "tool_result", "call_id": str, "output": str}   result of a delegated task, spoken as the next reply
               {"type": "interrupt", "reply_id"?: str, "played_s"?: float}  stop talking now (the browser already stopped
                                                                        reply_id after played_s seconds of it)
               {"type": "cut", "reply_id": str, "played_s": float}      the browser stopped reply_id after played_s seconds
  out binary   PCM16 mono at 24 kHz (reply audio, sent as soon as it is generated)
  out text     {"type": "ready"} | {"type": "reply_audio", "reply_id": str} (the binary audio that follows belongs to reply_id)
               {"type": "interrupt", "reply_id": str | null} (drop reply_id's buffered audio: the user barged in)
               {"type": "onset", "reply_id": str} (the user started speaking after reply_id finished generating; the
                                                   browser stops it if it is still playing there, then sends "cut")
               {"type": "delegate", "call_id": str, "task": str}
               {"type": "reply", "text": str, "cancelled": bool, "reply_id": str | null}
               {"type": "event", ...engine event...}

Playout clock: the engine decides whether a finished reply is still being heard from the wall time since its first chunk was
generated, but the browser schedules the audio itself (and may wait for the avatar before each segment), so it can still be
playing when the engine thinks it is over. The engine's own cut is kept for a reply it believes is still playing; for one it
believes is over, the browser decides from its own playout and reports how much was heard ("cut"), and the history is made to
match what the user actually heard.

    PORTOS_REALTIME_TOKEN=T python portos_sophon.py --app ~/.portos/sophon-mac/app --models ~/.portos/sophon-mac/models --port 5569
"""
import argparse, asyncio, collections, hmac, json, math, os, re, signal, sys, threading, time, uuid

ap = argparse.ArgumentParser()
ap.add_argument("--app", required=True, help="the Sophon Mac install's app folder (engine.py)")
ap.add_argument("--models", required=True, help="the Sophon Mac model folder")
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--token", default=None, help="auth token (defaults to PORTOS_REALTIME_TOKEN env var)")
ap.add_argument("--rate", type=int, default=16000, help="sample rate of the incoming PCM16")
ap.add_argument("--lang", default="en")
ap.add_argument("--voice", default="chelsie")
ap.add_argument("--persona", default=None, help="extra system prompt text (defaults to PORTOS_REALTIME_PERSONA env var)")
a = ap.parse_args()
# Remove the token from os.environ after reading it so child subprocesses do not inherit it.
env_token = os.environ.pop("PORTOS_REALTIME_TOKEN", "")
token = a.token if a.token is not None else env_token
if not token:
    ap.error("--token or PORTOS_REALTIME_TOKEN is required")
env_persona = os.environ.pop("PORTOS_REALTIME_PERSONA", "")
persona = a.persona if a.persona is not None else env_persona
sys.path.insert(0, a.app)

import numpy as np  # noqa: E402
import mlx.core as mx  # noqa: E402
import websockets  # noqa: E402
import engine  # noqa: E402
from engine import Brain, Session, SR  # noqa: E402

OUT_RATE = 24000
CUT_MARK = "……（被用户打断）"    # the engine's marker for a reply the user talked over ("interrupted by the user")
RECENT_REPLIES = 16               # replies the browser may still report playout for
TC_OPEN, TC_CLOSE = "<tool_call>", "</tool_call>"
TOOL_RE = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|$)", re.S)

DELEGATE = {"type": "function", "function": {
    "name": "delegate",
    "description": "Hand the user's request to the assistant's back office: a stronger model that reasons carefully, knows far more than "
                   "you, and can read the clock and date, the weather, the user's calendar, goals, daily log, notes and brain inbox, the "
                   "server and app status, and make changes in the PortOS app. It cannot hear the call: write everything it needs in task.",
    "parameters": {"type": "object", "properties": {"task": {"type": "string", "description":
        "The user's full request exactly as asked, with every detail they said (names, numbers, dates, the exact text to save)."}},
        "required": ["task"]}}}

# Built on the Flash engine's tool prompt (sophon_realtime/tools.py SYS_TOOL), which the model follows, widened the way Sophon's
# Live mode does with its "all" back-office scope: the voice is the front of the call and answers only small talk itself, because
# the back office (the user's Voice model with its tools) knows and reasons far better than the voice model does.
TOOL_RULES = ("You are the voice on the call; a back office does the thinking. You can call the tool listed above. Answer only small "
              "talk yourself: greetings, thanks, acknowledgements, and short social replies. For everything else (any question that needs "
              "a fact, knowledge, advice, reasoning, a recommendation, the time or date, the user's own data, or an action) first say one "
              "very short spoken lead-in (e.g. \"Let me check that\" or \"Let me think about that\"), then immediately call delegate "
              "with the user's full request; the tool name, arguments and format are never spoken, so don't repeat them out loud. When the "
              "tool result comes back, tell the user that result in one or two natural spoken sentences, keeping its facts exactly. Never "
              "claim you did something, and never answer a factual question from your own knowledge.")


TRANSCRIBE_ASK = "Write down exactly what the user said in this audio, word for word. Output only their words."
# A reply that announces a lookup or claims an action. When the voice says one of these without calling delegate, the sidecar
# delegates for it (see ToolSession._run_reply).
LEADIN_RE = re.compile(r"\b(let me (check|think|look|see|find|get|pull|open|add|note|save|log)|one (moment|sec|second)|hold on|"
                       r"i'?ll (check|look|find|get|add|note|save|log|open|set|put|take|pull)|i (will|am going to) (check|look|add|save|log|set)|"
                       r"i'?ve (added|saved|logged|noted|set|opened|put)|i have (added|saved|logged|noted|set|opened)|checking)\b", re.I)


def promises_action(text):
    return bool(LEADIN_RE.search(text or ""))


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

    def transcribe(self, key, audio, max_tok=80):
        """What the user said, word for word, read back by the thinker from the audio it already embedded. Runs in its own
        KV cache so the conversation's cached prefix is untouched."""
        msgs = [{"role": "user", "content": "<|audio|>\n\n" + TRANSCRIBE_ASK}]
        s = self.tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False, enable_thinking=False)
        head, tail = s.split("<|audio|>", 1)
        h = self.tok.encode(head, add_special_tokens=False); t = self.tok.encode(tail, add_special_tokens=False)
        e = self.embed(key, audio).astype(mx.bfloat16)
        ids = h + [engine.AUD] * e.shape[0] + t
        E = mx.concatenate([self.lm.model.embed_tokens(mx.array(h)), e, self.lm.model.embed_tokens(mx.array(t))])
        cache = engine.make_prompt_cache(self.lm)
        self.lm(mx.array([ids[:-1]]), cache=cache, input_embeddings=E[:-1][None]); mx.eval([c.state for c in cache])
        out = ""
        for r in _stream_generate(self.lm, self.tok, mx.array(ids[-1:]), input_embeddings=E[-1:], prompt_cache=cache, max_tokens=max_tok):
            out += r.text
        return " ".join(out.replace("<|im_end|>", "").split()).strip().strip('"')

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

    def __init__(self, brain, play, *args, on_delegate=None, send=None, **kw):
        """play(audio, reply_id) sends reply audio, or an interrupt for reply_id when audio is None; send(obj) sends a message."""
        self.on_delegate = on_delegate
        self.send = send or (lambda _msg: None)
        self.gen_r = None                                     # the reply the worker thread is generating
        self.announced = None                                 # the reply whose audio the browser is receiving
        self.recent = collections.OrderedDict()               # reply_id -> reply, for the browser's playout reports

        def tagged(audio):
            if audio is None:                                 # Session._onset cuts self.reply
                play(None, self._rid(self.reply)); return
            r = self.gen_r
            if r is not None and self.announced is not r:
                self.announced = r; self.send({"type": "reply_audio", "reply_id": self._rid(r)})
            play(audio, None)

        super().__init__(brain, tagged, *args, **kw)

    def _rid(self, r):
        if r is None: return None
        rid = r.get("rid")
        if rid is None:
            rid = r["rid"] = uuid.uuid4().hex[:12]; self.recent[rid] = r
            while len(self.recent) > RECENT_REPLIES: self.recent.popitem(last=False)
        return rid

    def _begin(self, r):
        with self.lock: self.gen_r = r; self._rid(r)

    def ev(self, name, **kw):
        if name == "reply_done" and self.gen_r is not None: kw["reply_id"] = self.gen_r.get("rid")
        super().ev(name, **kw)

    def _onset(self):
        r = self.reply
        heard = r is not None and not r["cancel"] and r.get("t_out") is not None
        super()._onset()
        if heard and not r["cancel"]:
            # The engine judged this reply over from generation time alone; the browser knows whether it is still playing.
            self.send({"type": "onset", "reply_id": self._rid(r)})

    def browser_cut(self, rid, played_s):
        """The browser stopped reply `rid` after `played_s` seconds of it had played: cancel it and make the history say what was
        actually heard. This also corrects the engine's own cut, which estimates what was heard from generation time."""
        try: played = float(played_s)
        except (TypeError, ValueError): return False
        if not math.isfinite(played): return False
        played = max(0.0, played)
        with self.lock:
            r = self.recent.get(str(rid))
            if r is None or (r["cancel"] and r.get("cut") is None): return False     # unknown, or merged into the next turn
            frac = max(0.0, min(1.0, played / max(r["gen_s"], 1e-3)))
            fresh = not r["cancel"]
            r["cancel"] = True; r["cut"] = (played, frac)    # a reply still generating commits this cut when it finishes
            if not r["done"]: return True
            said = self._rewrite_heard(r, played, frac)
            if said is None: return True
            if self.reply is r: self.last_said = said
            if fresh:
                if not r.get("followup"): self.cut = {"t": time.time(), "r": r["resume"] if r.get("resume") is not None else r}
                self.ev("barge_in", played_s=round(played, 2), said=said, source="browser")
            return True

    def _rewrite_heard(self, r, played, frac):
        """Rewrite a finished reply's history entry to the part that was heard. Returns what was said, or None if there is no entry."""
        e = r.get("entry")
        if e is None or e.get("calls") or not any(h is e for h in self.history): return None   # identity: entries hold arrays
        text = r.get("text") or ""
        said = r.get("heard_prefix", "") + text[: int(len(text) * frac)]
        a16 = r.get("a16") if r.get("resume") is None else None
        a16 = a16[: int(played * SR)] if a16 is not None and played > 0.5 else None
        if not said and a16 is None:
            self.history = [h for h in self.history if h is not e]; r["entry"] = None
        else:
            e["a_text"] = said + CUT_MARK; e["a_audio"] = a16; e["akey"] = uuid.uuid4().hex     # new audio, new cache key
        return said

    def _run_resume(self, r):
        self._begin(r)
        # Follow-up replies ride the base worker's "resume" job, so they queue behind turn checks and replies on the one GPU thread.
        if r.get("followup"): return self._run_followup(r)
        if r["resume"].get("followup"): return            # a cut follow-up has no user audio to continue from
        e = r["resume"].get("entry")
        r["heard_prefix"] = (e.get("a_text") or "").replace(CUT_MARK, "") if e is not None else ""   # what the resumed reply continues
        return super()._run_resume(r)

    def _run_reply(self, r):
        self._begin(r)
        super()._run_reply(r)
        calls = parse_calls(self.b.last_raw)
        if not calls and not r.get("cancel") and r.get("user") is not None and promises_action(cut_tool(self.b.last_raw, True)):
            # The voice said "Let me check" (or claimed an action) and then ended its turn without calling the tool, which the
            # Mac build does often. Hand off what the user actually said, read back from their audio by the same model.
            heard = self.b.transcribe(r["ukey"], r["user"])
            if heard:
                calls = [{"id": uuid.uuid4().hex[:12], "name": "delegate", "arguments": {"task": heard}}]
                self.ev("delegate_fallback", said=cut_tool(self.b.last_raw, True)[:120], heard=heard[:200])
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


def _headers_for(headers, name):
    target = name.lower()
    entries = headers.raw_items() if hasattr(headers, "raw_items") else headers.items() if hasattr(headers, "items") else ()
    return [str(v) for k, v in entries if str(k).lower() == target]


async def main():
    print("Loading the model...", flush=True)
    brain = ToolBrain(a.models, lang=a.lang, voice=a.voice, sys_prompt=os.path.join(a.app, "system_prompt.json"), persona=persona)
    brain.warmup()
    busy = {"on": False}

    async def handle(ws):
        headers = getattr(getattr(ws, "request", None), "headers", None) or getattr(ws, "request_headers", None) or {}
        # Server-to-sidecar loopback only: never admit a browser-originated WebSocket.
        if _headers_for(headers, "Origin"):
            await ws.close(4403, "origin forbidden"); return
        auth_headers = _headers_for(headers, "Authorization")
        auth = auth_headers[0] if len(auth_headers) == 1 else ""
        presented = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not presented or not hmac.compare_digest(presented.encode("utf-8"), token.encode("utf-8")):
            await ws.close(4401, "bad token"); return
        if busy["on"]:
            await ws.close(1013, "one conversation at a time"); return
        busy["on"] = True
        closed = False
        loop = asyncio.get_running_loop(); outq = asyncio.Queue()

        def send_soon(item):
            if closed: return
            try: loop.call_soon_threadsafe(outq.put_nowait, item)
            except RuntimeError: pass

        def play(x, reply_id=None):
            if x is None: send_soon(json.dumps({"type": "interrupt", "reply_id": reply_id})); return
            send_soon((np.clip(np.asarray(x, np.float32), -1, 1) * 32767).astype("<i2").tobytes())

        def log(line):
            try: ev = json.loads(line)
            except ValueError: return
            if "text" in ev: ev["text"] = cut_tool(str(ev["text"]), True).strip()
            if ev.get("ev") == "reply_done":
                send_soon(json.dumps({"type": "reply", "text": ev["text"], "cancelled": ev.get("cancelled", False), "reply_id": ev.get("reply_id")}))
            send_soon(json.dumps({"type": "event", **ev}))

        sess = ToolSession(brain, play, log=log, send=lambda obj: send_soon(json.dumps(obj)),
                           on_delegate=lambda cid, task: send_soon(json.dumps({"type": "delegate", "call_id": cid, "task": task})))

        async def sender():
            try:
                while True:
                    item = await outq.get(); await ws.send(item)
            except (websockets.ConnectionClosed, asyncio.CancelledError):
                pass

        tx = asyncio.ensure_future(sender()); buf = np.zeros(0, np.float32); FR = 320
        try:
            await ws.send(json.dumps({"type": "ready"}))
            async for m in ws:
                if isinstance(m, str):
                    try: o = json.loads(m)
                    except ValueError: continue
                    if o.get("type") == "tool_result": sess.tool_result(str(o.get("call_id", "")), str(o.get("output", "")))
                    elif o.get("type") == "interrupt":
                        with sess.lock: sess._onset()
                        if o.get("reply_id"): sess.browser_cut(o["reply_id"], o.get("played_s"))
                    elif o.get("type") == "cut" and o.get("reply_id"): sess.browser_cut(o["reply_id"], o.get("played_s"))
                    continue
                x = np.frombuffer(m[: len(m) // 2 * 2], "<i2").astype(np.float32) / 32768.0
                if a.rate != SR: x = engine.resample(x, a.rate, SR).astype(np.float32)
                buf = np.concatenate([buf, x])
                while len(buf) >= FR:
                    f, buf = buf[:FR], buf[FR:]; sess.feed(f)
        except websockets.ConnectionClosed:
            pass
        finally:
            closed = True
            with sess.lock:
                if sess.reply is not None: sess.reply["cancel"] = True
            tx.cancel()
            try: await tx
            except asyncio.CancelledError: pass
            busy["on"] = False

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try: loop.add_signal_handler(sig, stop_event.set)
        except (NotImplementedError, RuntimeError): pass

    async with websockets.serve(handle, "127.0.0.1", a.port, max_size=1 << 22):
        print(json.dumps({"ready": True, "port": a.port}), flush=True)
        await stop_event.wait()


if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: os._exit(0)
