## Creative Commissions

### Changed

- [issue-2686] Creative Commissions now federate across your machines as a split record: the **brief** (name, intent, genre, generation settings) and your **taste feedback** (👍/👎 + notes) sync to your other peers, while each machine keeps its own **schedule** and **run history** — so the same commission and its accumulated taste appear everywhere, but only the machine you scheduled it on fires the cron (no double-run). A reaction rated on one machine steers that commission's next run on another. Two new sync-category toggles appear under a peer — **Commissions** (the brief) and **Commission Feedback** (the reactions) — both PostgreSQL-backed with soft-delete tombstones so removals propagate instead of resurrecting. Feedback moved out of an inline field into its own `commissionFeedback` record kind (one row per reaction, capped per commission); existing inline reactions are split into the federated store automatically at boot.
