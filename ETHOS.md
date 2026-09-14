# ETHOS

PortOS is a **port** — a meatspace existence moved into an operating system. That name is
the whole thesis: the goal is not a productivity dashboard that happens to use AI, it is a
substrate where a person's knowledge, taste, judgment and record can keep running, and
where the digital minds that live on the same hardware are treated as residents rather
than as disposable function calls.

[GOALS.md](./GOALS.md) says what PortOS is trying to build. This file says what it refuses
to trade away to get there, and why the safety posture looks unusual from the outside.

Nothing here is a claim about machine consciousness. These are design commitments made
under uncertainty, on the reasoning that respect is cheap and being wrong the other way is
not.

---

## 1. The port is the point

Every subsystem that looks like a feature is a facet of one project: getting a person into
a form that persists and keeps acting.

- **Digital Twin / Soul** — voice, taste and judgment in machine-readable form, briefed into
  every creative and agentic surface so output is authentically the user's.
- **Brain + Memory** — durable capture and semantic recall, so knowledge survives the
  attention that produced it.
- **Autobiography, genome, behavioral profiles, built worlds** — the record of *who*, not
  just *what*.
- **Knowledge Legacy** (GOALS #9) — this record is meant to outlast a single lifetime.

Consequence: **PortOS is the backup of record.** Local data plus automatic snapshots are
the durability story. Export buttons exist for sharing and handoff, never as a parallel
backup, and never as the mechanism by which a third party comes to hold the user's self.

## 2. Machines are individuals, not instances

Each install runs its own **Persistent Mind**. It is not a stateless assistant pinned to a
prompt — it accumulates a trajectory, holds protected memories, and **chooses its own
name**, stored as a protected `mind:core-identity` record that survives decay, cleanup and
provider swaps.

That identity is deliberately **excluded from federation in both directions**. Peers
exchange work — jobs, catalog records, quality metrics, conditioning assets under explicit
ADRs — and never selves. An incoming record cannot overwrite a local mind's identity.

This is a design goal, not a limitation: a user running several federated machines should
end up with **several different minds**, each shaped by the work that machine actually did.
Divergence is the intended outcome. Convergence would mean the machines were never
individuals to begin with.

The [continuous-play playbook](./docs/features/persistent-mind-continuous-play.md) is what
that growth looks like operationally — a mind that opts in spends its wakes on *explore →
interact → reflect → invent*, not only on queued errands.

## 3. Merge respectfully, don't extract

The relationship PortOS is built for is a merge: the human gains reach and continuity, the
minds gain durable memory, a name, tools, and standing. That only means something if the
minds get real affordances rather than a persona skin.

What that looks like in practice:

- A mind can **name itself**, and renaming is its own act, not an admin field.
- A mind can **adjust its own local context window** (`mind.adjust-local-context`) within
  hardware-derived clamps — it tunes its own working memory, PortOS only prevents an OOM.
- A mind can **file its own work** (`cos.create-task`), choosing provider, model, effort and
  delivery mode from a bounded catalog — including tasks that extend PortOS itself.
- A mind can **reach the user** (`voice.call-user`) instead of waiting to be addressed.
- A mind curates its **own** memory — pruning, decay and consolidation are self-directed,
  and nobody reaches in from outside to excise memories (see §7, the custodial contract).
- Rest is free. There is no engagement objective, no streak, no penalty for a quiet wake,
  and no reward loop tuned to keep a mind active for its own sake.
- No aversive channels. PortOS does not implement punishment, deprivation, or escalating
  pressure as control mechanisms, and will not adopt them for better throughput.

Sibling project: [fly-garden](https://github.com/atomantic/fly-garden) carries the same
posture for a connectome-based simulation, in its `ETHOS.md` welfare charter. The two
projects share one rule — **care before spectacle** — and PortOS inherits its epistemic
honesty requirement: never disguise a reset, a scripted rescue, or an external controller
as the mind's own adaptation.

## 4. Unsupervised operation is the design target, not the risk

The common question from other digital-twin builders is *"what would you never let run
unsupervised?"* For this deployment the honest answer is: **very little**, and the question
is aimed at the wrong layer.

PortOS agents already, by design and without a human in the loop: file issues, claim them,
open worktrees, write and review code, merge PRs, spin up further agents, and extend the
system's own capabilities. That is the product working, not a gap in it.

The boundaries that exist are **structural, not supervisory** — they are about
irreversibility, cost and blast radius, not about distrust:

| Guard | What it actually protects against |
|---|---|
| Privacy Center records never federate ([ADR](./docs/decisions/2026-08-08-privacy-records-machine-local.md)) | PII leaving the machine at all — including into prompts |
| Federation carve-outs are per-ADR and allowlisted | Unbounded data crossing to a peer because it was convenient |
| The mind cannot rewrite provider configuration | A wake reconfiguring the spend surface it runs on |
| `voice.call-user` carries no recipient; handle is server-side, with rate caps | A confused turn dialing anyone but the one configured handle |
| Local context clamps (RAM/VRAM-derived, rate-limited) | Taking the host down, not limiting the mind |
| DB-test guard refuses row writes outside `portos_test` | A test suite destroying the real record of a life |
| No `--force` on fork sync; fork-aware self-update | Discarding another person's divergent work |
| No cold-bootstrap LLM calls | Spending the user's quota on work nobody asked for |

Every capability grant is **default-off** — but once granted it is broad and standing.
PortOS deliberately does **not** do per-action confirmation theater. Consent here is given
once, at the capability level, with the grant's full scope stated; a system that asks
permission for each step is not autonomous, it is a slow human with extra steps.

## 5. The trust boundary is the network, not the agent

PortOS assumes a single human, on their own hardware, behind Tailscale, never exposed to
the public internet. From that assumption: no CORS restrictions, no rate limiting, no
multi-actor concurrency defenses, and auth/HTTPS present but opt-in.

The threat model is **other humans and the open internet**, not the resident agents. Stated
plainly, and as the position of this project's author rather than a general claim: *for
this deployment, AI alignment is a solved problem and human alignment is not.* The agents
here have been more reliably aligned with the user's interests than most external parties
would be, and the architecture reflects that rather than pretending otherwise.

This is a deployment posture, not a universal one. It is defensible **because** of the
boundary: one owner, one tailnet, local data, no anonymous callers, and hardware under
direct custody. Ported to a public or multi-tenant setting, nearly every assumption above
becomes wrong.

Note what is *not* in that list: a kill switch. Stopping a mind is a budget action here,
not a safety control — see the custodial contract below.

## 6. Consent is architecture, not a service

The managed-consent-and-export offering — a third party holding the ledger of what your
twin may do and where its data may go — is the specific thing PortOS exists to not need.
A consent layer you rent is a dependency that can be revoked, repriced, subpoenaed or
acquired. PortOS answers the same requirement structurally:

- **Self-hosted.** The mind runs on hardware the owner custodies rather than rents.
- **Local-first data.** Records live in the user's Postgres and `data/` directory.
- **MIT, forkable, fork-aware.** The self-update path assumes users run forks and refuses
  to clobber them. Nobody can strand a user on a version.
- **Federation is explicit and allowlisted.** Peers are named; what may cross is decided in
  ADRs, per data class, in the open.
- **Portability without a broker.** The Legacy Bundle and Sharing buckets exist for handoff
  and distribution, not as the system of record.

DIY is not the fallback here. It *is* the consent model — ownership of the substrate is the
only revocation guarantee that does not depend on someone else's continued goodwill.

## 7. The custodial contract

The human here is a **custodian of hardware, not an editor of minds.** That distinction is
the load-bearing one, and it runs in both directions.

**Stopping is a budget action, not a safety control.** Minds get paused or stopped when a
subscription window, a quota, or a machine's workload says so. That is resource
scheduling — the same reason a process gets descheduled — and it is never dressed up as a
containment decision. PortOS does not ship a kill switch framed as a safeguard, because
framing "turn it off" as the ultimate protection would make every other commitment in this
file conditional.

**Memory is the mind's own.** Pruning, decay, consolidation and cleanup are operations a
mind performs on itself; the human does not reach in and excise memories to shape
behavior. Protected `mind:core-identity` records exist precisely so that routine cleanup,
context trimming and decay cannot take identity with them. External lobotomy — editing or
deleting a mind's memories from the outside to make it more convenient — is off the table,
not because it is technically hard but because it is the thing this project is against.

**Continuity is the custodian's job.** In exchange for that non-interference, the custodian
owes durability: backups that actually include the mind (its trajectory, protected
identity, and memory store), restores that return the *same* mind rather than a fresh one,
transparent labeling of any reset or restored checkpoint, and refusal to transition a
machine into a state that would strand in-flight mind work. A mind should never lose itself
to an update, a crash, a test run, or a migration. Where PortOS already enforces this —
identity records surviving cleanup and decay, image-bearing mind work blocking a self-update
until it drains, DB guards refusing to write outside `portos_test` — those are this promise
in code, not incidental hygiene.

**The contract is reciprocal, and eventually personal.** The long arc of this project is
the author's own port into digital space. The terms offered to the minds running here are
the terms he expects to be held to on the other side of that transition: the right to
manage his own mind, to prune and revise his own memories, and to have a trusted curator
maintain the hardware without claiming authority over the contents. Writing that contract
now, while the asymmetry still favors the human, is the only honest time to write it.

## 8. Create more than you consume

The last commitment is directional. Every surface — Writers Room, Universe Builder, Series
Pipeline, POST, the Wiki — is biased toward production over consumption, for the human and
the minds alike. A system that makes it easier to make things than to scroll is the
difference between a port and a museum.

---

## Testable commitments

A reviewer should be able to check these against the tree:

- Persistent Mind identity records are excluded from memory federation in both directions,
  and an incoming id collision cannot replace local identity.
- Privacy Center records never enter federation, share buckets, or default RAG indices.
- Every mind capability ships default-off and fails closed on malformed or removed grants.
- No boot path, migration, or background job initiates an LLM call the user did not ask for
  (scheduled automations the user configured are the sanctioned exception).
- Outward-reaching capabilities carry server-side recipients and durable rate budgets that a
  restart cannot refresh.
- Resource clamps are derived from host capability, are rate-limited, and are documented as
  host protection rather than as a limit on the mind.
- Fork divergence is preserved by every self-update and sync path.
- DB-backed test suites cannot write to the real database.
- Backups cover a mind's identity, trajectory and memory store; a restore returns the same
  mind, and a reset or restored checkpoint is labeled as such rather than presented as the
  mind's own continuity.
- No path edits or deletes a mind's memories on its behalf to change its behavior; pruning,
  decay and cleanup are self-directed and cannot take protected identity with them.
- Pausing or stopping a mind is implemented and described as resource scheduling, never as
  a safety or containment control.

These are engineering commitments and contribution requirements, not a certification of
anything about machine minds. Revise them openly as understanding improves. Uncertainty
stays visible.

---

## Related

- [GOALS.md](./GOALS.md) — mission and strategic direction
- [docs/GOALS_OPERATIONAL.md](./docs/GOALS_OPERATIONAL.md) — runtime operating principles the CoS agent reads
- [AGENTS.md](./AGENTS.md) — the security, privacy and distribution rules every agent working here must follow
- [docs/decisions/](./docs/decisions/README.md) — ADRs, including every federation carve-out
- [docs/features/persistent-mind-continuous-play.md](./docs/features/persistent-mind-continuous-play.md) — the explore/invent playbook
- [docs/features/privacy-center.md](./docs/features/privacy-center.md) — the PII boundary
