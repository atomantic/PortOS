# Eidoverse Worlds

Use **Settings → Features → Install & enable** to set up Eidoverse Worlds and the companion video runtime. The toggle alone does not install dependencies. Use the managed app's **Git** tab to inspect both checkouts. **Update both** refreshes and restarts them. **Sync fork only** updates the supported fork without changing local checkouts. Branch changes require a clean checkout and preserve local commits.

Keep the Worlds sequencer on loopback port 8940 and open the world through PortOS, including the fullscreen `/eidoverse/solo` view. Exposing the sequencer directly bypasses PortOS admission. Back up the machine-local world history and assets in `data/eidoverse/worlds`. Disabling the feature hides it and stops automatic startup. Review separately configured jobs as well.

## PortOS Commons

Open the launch view or run the projection explicitly to update the Commons. It projects bounded local signals without copying private records into the world. User labels and aliases remain separate. The optional scheduled projection is disabled by default. If the renderer reports unavailable, check the managed app and its assets first.

## Federated guest travel

Use the **Federation Terminal** or a destination button. Both owned installs need guest-capable runtimes and the receiving host's resident presence enabled. The source operator presence leaves before the destination opens. The resident stays home.

A time-limited guest ticket grants access to the destination guest renderer. It carries no PortOS API, construction or host authority. Ending a visit, expiry or losing the peer closes its sockets. Guest chat stays bounded to the live visit. The Mind needs its separate default-off travel grant, and local world writes have their own grant. See [guest chat](../decisions/2026-09-05-eidoverse-guest-chat.md) and [peer administration](./peer-administration.md).

## Foundations and controllers

Review local authored foundations before promoting a shared baseline. Promotion requires resilience evidence. Publishing makes the approved package available to eligible peers. Withdraw it before deleting the owned foundation. Inherited packages keep their original provenance and stay separate from local foundations. See [federated foundations](../decisions/2026-09-18-federated-eidoverse-foundations.md).

Controllers run shipped deterministic definitions. Explicitly opt in to world delivery if wanted. Check controller status after failures or configuration changes. See [Eidoverse Video](../EIDOVERSE_VIDEO.md) for capture and replay.
