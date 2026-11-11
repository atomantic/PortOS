# Runtime advisory review, 2026-11-11

This is the advisory-specific review for [#15768](https://github.com/atomantic/PortOS/issues/15768).
It adds 72 exact target/package/version dispositions, shared by amd64 and arm64:
62 for pgvector and 10 for SuperCollider. Eight pgvector matches are upstream
version-range mismatches; 64 remain **blocked, not fixed**, tracked in
[#15788](https://github.com/atomantic/PortOS/issues/15788). Earlier GSS rationales are corrected to remove their default-SCRAM inference;
their blocked dispositions and tracking remain intact. Other prior reviews and [#15669](https://github.com/atomantic/PortOS/issues/15669) remain separate.

## Inventory and primary evidence

[Run 43044058183](https://github.com/atomantic/PortOS/actions/runs/43044058183)
scanned commit `c99a8e71e4d84f1f62b54c715c3f02a63efee285` with Syft 1.55.0,
Grype 0.121.0 and database v6.1.10 built `2026-11-11T06:21:32Z`.
The actual SBOMs, scans and database-status artifacts agree across architectures.
The recipes are unchanged by this review:

| Target | Pinned input | Newly matched installed packages |
| --- | --- | --- |
| pgvector | `pgvector/pgvector:pg17@sha256:7d0a41464797aeb9862dfdc0bbf1526b82cfd324cdd8036df19e3545f4a9ccb8` | `libgssapi-krb5-2`, `libk5crypto3`, `libkrb5-3`, `libkrb5support0` at `1.20.1-2+deb12u5`; `libssl3`, `openssl` at `3.0.22-1~deb12u2` |
| SuperCollider | `debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2`, snapshot `20261104T212339Z` | `libssl3t64`, `openssl-provider-legacy` at `3.5.7-1~deb13u3` |

Primary sources checked on 2026-11-11:

- [MITKRB5-SA-2026-001](https://web.mit.edu/kerberos/advisories/MITKRB5-SA-2026-001.txt)
  and [MIT 1.22.3 release details](https://mailman.mit.edu/pipermail/kerberos-announce/2026q4/000212.html).
- [OpenSSL's November 10 advisory](https://openssl-library.org/news/secadv/20261110.txt).
- Debian's [krb5](https://security-tracker.debian.org/tracker/source-package/krb5)
  and [openssl](https://security-tracker.debian.org/tracker/source-package/openssl)
  trackers. Each CVE has its own tracker page, e.g.
  [CVE-2026-71200](https://security-tracker.debian.org/tracker/CVE-2026-71200)
  and [CVE-2026-107496](https://security-tracker.debian.org/tracker/CVE-2026-107496).
  They still record these installed source versions as vulnerable/unfixed.

## Kerberos: 13 IDs, four packages each

All 52 matches remain `blocked`. The following distinctions bound the exposure;
they do not certify the loaded libraries safe or replace a Debian backport.

| CVE-2026 suffix | Affected path identified by upstream | Runtime assessment |
| --- | --- | --- |
| 107364 | MIT DoS group | No KDC runs here; the aggregate advisory does not prove every GSS caller unaffected. Retain the installed-library blocker. |
| 107884 | kadmind password-change authorization | No kadmind package, process or entrypoint. |
| 111423 | PAC server-checksum validation | GSS application-server compatibility remains supported; retain the blocker. |
| 71199 | CAMMAC verifier checksums | Do not assume an operator's KDC is patched; retain the blocker. |
| 71200 | MIT DoS group, including application servers | Pre-authentication GSS token handling prevents a default-SCRAM unreachability claim. |
| 112314 | GSS-RPC client reply verification | No `libgssrpc4`; PostgreSQL GSS transport is not GSS-RPC. |
| 112315 | RPCSEC_GSS decoding | No `libgssrpc4` or kadmind. |
| 112316 | kadm5 XDR decoding | No `libkadm5srv-mit12` or kadmind. |
| 112317 | KDB keytab access in KDC/kadmind | Neither server runs here. |
| 112318 | kadmind policy RPC | No kadmind. |
| 112319 | GSS-RPC XDR allocations | No `libgssrpc4` or kadmind. |
| 112320 | GSS-RPC authentication contexts | No `libgssrpc4` or kadmind. |
| 118380 | RPCSEC_GSS service-type handling | No `libgssrpc4` or kadmind; PostgreSQL GSS is not this RPC protocol. |

The seven 112314–112320 descriptions are also individually recorded in the
[CVE Program's published records](https://github.com/CVEProject/cvelistV5/tree/main/cves/2026/112xxx).
The real pgvector SBOM lacks `libgssrpc4`, `libkadm5srv-mit12`,
`krb5-admin-server` and `krb5-kdc`. Source-package matching explains why these
components can be reported against the four installed client libraries.

`docker-compose.yml` publishes PostgreSQL only on `127.0.0.1`; it adds no
Kerberos keytab or GSS configuration. This bounds exposure, but **SCRAM in
pg_hba is not a pre-authentication GSS gate**. PostgreSQL 17's
[`ProcessStartupPacket`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/tcop/backend_startup.c)
accepts a TCP `GSSENCRequest` when compiled with GSS support, before the normal
startup/authentication flow. It calls
[`secure_open_gssapi`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/libpq/be-secure-gssapi.c),
which reads client tokens and invokes `gss_accept_sec_context`. This code review
is why the loaded-library blockers are retained even for the default recipe;
no exploit or assertion that a particular malformed token succeeds is implied.
Operator-configured GSS authentication/encryption remains supported.

MIT released 1.22.3; Debian's bookworm `1.20.1-2+deb12u5` is still unfixed.
Unblock each pair only after Debian security backports its fix and a compatible
PostgreSQL 17/pgvector image includes it. Debian security and the upstream image
maintainers own those releases; PortOS owns verified adoption in #15788.

## OpenSSL: five IDs

| Advisory | Required path | pgvector 3.0.22 | SuperCollider 3.5.7 |
| --- | --- | --- | --- |
| CVE-2026-88822 | QUIC peer detection | Upstream explicitly excludes 3.0; two `not-reachable` source-range matches. | Two `blocked` matches. |
| CVE-2026-88823 | AES-GCM-SIV AAD updates | Upstream excludes 3.0; two `not-reachable` matches. | Two `blocked` matches. |
| CVE-2026-95691 | QUIC frame processing | Upstream excludes 3.0; two `not-reachable` matches. | Two `blocked` matches. |
| CVE-2026-95692 | AES-GCM-SIV nonce handling | Upstream excludes 3.0; two `not-reachable` matches. | Two `blocked` matches. |
| CVE-2026-107496 | CMS encryption to a hostile EC recipient certificate | Two `blocked` matches; upstream explicitly excludes ordinary TLS/QUIC from this path. | Two `blocked` matches. |

PostgreSQL TLS, its entrypoint and `pg_isready` do not perform CMS encryption.
This is a caller distinction, not proof that installed OpenSSL is patched.
Debian's broad source-package matches for the other four IDs conflict with
upstream's explicit 3.0 exclusion; the ledger records that evidence without
changing the raw scan or claiming a fix.

SuperCollider generated source can execute commands inside the sandbox, so a
package merely being unused by stock `sclang`/`scsynth` does not establish
unreachability. `buildSuperColliderRunArgs` in `server/lib/superColliderRuntime.js`
applies `--network none`, a non-root user, dropped capabilities,
`no-new-privileges`, a read-only root, resource/time limits and disposable
per-render containers. External QUIC peers cannot reach that network namespace;
local crypto calls and render-local denial of service remain possible. All ten
matches therefore remain blocked rather than being dismissed by the sandbox.

The OpenSSL fixes are in source, with releases scheduled for December 1:
3.5.10 and premium-support 3.0.24. Neither a scheduled release nor a source
commit proves a released Debian backport. #15788 names each outstanding group:
Debian security must publish the backports; pgvector must rebuild pg17, and
SuperCollider must adopt a matching official Debian base/snapshot with its
existing integrity and native guards. Preserve volume and GSS compatibility.

## Verification and limits

Replay strict verification with each original SBOM, scan, database-status file
and image provenance; compare the two architectures' new pair sets before
adding version-scoped ledger entries. Run the verifier's existing boundary and
ledger-contract tests. A new dispatched scan must independently regenerate the
SBOM/database evidence on both native architectures before this review is
considered delivered. Passing strict reconciliation means every match has a
reviewed disposition; it does not mean no vulnerabilities or coverage gaps.
The external eidoverse render parent remains explicitly unavailable.
