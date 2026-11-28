import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../../../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./portos_sophon.py', import.meta.url));

// Load the sidecar against a stand-in for the Sophon Mac engine: no model, microphone or GPU. The stand-in Session keeps the
// engine's own barge-in decision (Session._onset in adventists-ai/sophon-realtime mac/engine.py, Apache-2.0) so the test
// exercises the same "is this reply still being heard" judgement, on a synthetic clock.
const harness = String.raw`
import importlib.util, json, sys, threading, types
import time
clock = {"now": 0.0}
time.time = lambda: clock["now"]      # the engine and the sidecar both read wall time through time.time

engine = types.ModuleType("engine")
engine.SR = 16000
engine.MAX_REPLY_TOK = 8
engine.HIST_TURNS = 20
engine.HIST_SEC = 600
engine.tag_clean = lambda s, final: s
engine.stream_generate = lambda *a, **k: iter(())
MARK = "……（被用户打断）"

class Brain:
    def __init__(self, *a, **k): self.SYS = ""

class Session:
    def __init__(self, brain, play, log=print):
        self.b = brain; self.play = play; self.log = log; self.lock = threading.Lock()
        self.history = []; self.last_said = ""; self.reply = None; self.prev_user = None; self.t_reply = 0.0
        self.cut = None; self.sgen = 0; self.uid = 0; self.events = []
    def ev(self, name, **kw):
        kw = {"ev": name, **kw}; self.events.append(kw); self.log(json.dumps(kw, ensure_ascii=False))
    def _run_reply(self, r):
        def emit(a):
            if r["cancel"]: return
            if r["t_out"] is None: r["t_out"] = clock["now"]
            r["gen_s"] += len(a) / 24000; self.play(a)
        for chunk in r["chunks"]: emit(chunk)
        r["text"] = r["say"]; r["a16"] = list(range(int(r["gen_s"] * engine.SR))); r["done"] = True
        with self.lock:
            if not r["cancel"]: self._commit(r, r["a16"], r["text"]); self.last_said = r["text"]
        self.ev("reply_done", text=r["text"], cancelled=r["cancel"])
    def _onset(self):
        # The engine's decision, verbatim apart from the merge and resume branches this test does not reach.
        r = self.reply; now = time.time(); self.sgen += 1; self.uid += 1
        if r is not None and not r["cancel"] and not (r["done"] and r["t_out"] is not None and now - r["t_out"] - 0.25 >= r["gen_s"] - 0.3):
            if r["t_out"] is not None:
                played = now - r["t_out"] - 0.25
                r["cancel"] = True; self.play(None)
                txt = r.get("text") or ""; said = txt[: int(len(txt) * max(0.0, min(1.0, played / max(r["gen_s"], 1e-3))))]
                if r.get("entry") is not None: self.history = [h for h in self.history if h is not r["entry"]]
                r["cut"] = (max(played, 0.0), max(0.0, min(1.0, played / max(r["gen_s"], 1e-3))))
                if r["done"]:
                    a16 = r.get("a16"); a16 = a16[: int(max(played, 0) * engine.SR)] if a16 is not None and played > 0.5 else None
                    self._commit(r, a16, said + MARK)
                self.last_said = said; self.ev("barge_in", played_s=round(played, 2), said=said)
                self.cut = {"t": now, "r": r}
        self.prev_user = None

engine.Brain = Brain; engine.Session = Session
sys.modules["engine"] = engine
for name in ("numpy", "mlx", "mlx.core", "websockets"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["mlx"].core = sys.modules["mlx.core"]

sys.argv = [sys.argv[1], "--app", ".", "--models", ".", "--port", "1", "--token", "fixture-token"]
spec = importlib.util.spec_from_file_location("portos_sophon", sys.argv[0])
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)

out = []
sess = sidecar.ToolSession(Brain(), lambda audio, rid: out.append({"type": "interrupt", "reply_id": rid} if audio is None else "audio"),
                           log=lambda line: None, send=out.append)
sess.b.last_raw = ""

def reply(say, start):
    clock["now"] = start
    r = {"user": None, "ukey": None, "cancel": False, "done": False, "gen_s": 0.0, "t_out": None, "chunks": [[0.0] * 12000, [0.0] * 12000], "say": say}
    sess.reply = r; sess._run_reply(r); return r

def onset(at):
    clock["now"] = at
    with sess.lock: sess._onset()

result = {}
# A finished 1 s reply whose first chunk was generated at t=10. The engine thinks it is over by t=11.2.
r1 = reply("abcdefghij", 10.0)
result["markers"] = [m for m in out if m != "audio"]
out.clear(); onset(11.2)
result["late_onset"] = out[:]
out.clear(); result["cut_ok"] = sess.browser_cut(r1["rid"], 0.6)
result["after_cut"] = {"history": [h["a_text"] for h in sess.history], "audio": len(sess.history[-1]["a_audio"]), "last_said": sess.last_said,
                       "cut_is_r1": sess.cut["r"] is r1, "barge": [e for e in sess.events if e["ev"] == "barge_in"]}
result["recut_ok"] = sess.browser_cut(r1["rid"], 0.2)
result["unknown_ok"] = sess.browser_cut("feedfacecafe", 0.5)
result["bad_played_ok"] = sess.browser_cut(r1["rid"], "nan")

# A second reply the engine still believes is playing at t=20.8: the engine cuts it, the browser corrects what was heard.
sess.history.clear(); sess.events.clear(); out.clear()
r2 = reply("klmnopqrst", 20.0)
out.clear(); onset(20.8)
result["engine_cut"] = out[:]
result["engine_said"] = sess.history[-1]["a_text"]
sess.browser_cut(r2["rid"], 0.3)
result["corrected"] = sess.history[-1]["a_text"]
result["ids_differ"] = r1["rid"] != r2["rid"]
print(json.dumps({"r1": r1["rid"], "r2": r2["rid"], **result}, ensure_ascii=False))
`;

describe.skipIf(!python)('realtime voice sidecar playout cuts', () => {
  const run = () => {
    const proc = spawnSync(python, ['-c', harness, script], { encoding: 'utf8' });
    expect(proc.status, proc.stderr || proc.error?.message).toBe(0);
    return JSON.parse(proc.stdout.trim().split('\n').at(-1));
  };

  it('tags reply audio and the reply with one id, and asks the browser on a late onset instead of staying silent', () => {
    const res = run();
    expect(res.markers).toEqual([{ type: 'reply_audio', reply_id: res.r1 }]);
    // The engine judged the reply over (no interrupt), so the browser is told the user started speaking.
    expect(res.late_onset).toEqual([{ type: 'onset', reply_id: res.r1 }]);
    expect(res.ids_differ).toBe(true);
  });

  it('makes history match what the browser played when it stops a reply the engine thought was over', () => {
    const res = run();
    expect(res.cut_ok).toBe(true);
    expect(res.after_cut.history).toEqual(['abcdef……（被用户打断）']);
    expect(res.after_cut.audio).toBe(9600);
    expect(res.after_cut.last_said).toBe('abcdef');
    expect(res.after_cut.cut_is_r1).toBe(true);
    expect(res.after_cut.barge).toEqual([{ ev: 'barge_in', played_s: 0.6, said: 'abcdef', source: 'browser' }]);
    // A repeated report re-trims the same entry; unknown ids and bad numbers change nothing.
    expect(res.recut_ok).toBe(true);
    expect(res.unknown_ok).toBe(false);
    expect(res.bad_played_ok).toBe(false);
  });

  it('keeps the engine cut for a reply it believes is playing, then corrects its estimate from the browser playout', () => {
    const res = run();
    expect(res.engine_cut).toEqual([{ type: 'interrupt', reply_id: res.r2 }]);
    expect(res.engine_said).toBe('klmno……（被用户打断）');
    expect(res.corrected).toBe('klm……（被用户打断）');
  });
});
