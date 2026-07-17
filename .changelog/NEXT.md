## Creative Commissions

### Changed

- [issue-2686] Creative Commission taste feedback now federates across your machines. A 👍/👎 (and its note) rated on one machine flows to your other sync peers and steers the *same* commission's next run there — while each machine keeps its own schedule and only the owning machine fires the cron, so nothing double-runs. Feedback moved from an inline field on the machine-local commission into its own federated `commissionFeedback` record kind (one row per reaction, last-write-wins with soft-delete tombstones); a new **Commission Feedback** toggle appears under a peer's sync categories. Existing reactions are split into the federated store automatically at boot.
