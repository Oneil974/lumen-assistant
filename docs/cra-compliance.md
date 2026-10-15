# Cyber Resilience Act Compliance Plan

_Last updated: 2026-07-06_

This document tracks Lumen's preparation for Regulation (EU) 2024/2847, the
Cyber Resilience Act (CRA). It is not legal advice; it is the engineering and
release-readiness checklist for the product.

## Applicability

Lumen is distributed as a desktop software product with digital elements
(Windows, macOS, Linux packages). If it is made available on the EU market, the
CRA should be treated as applicable unless legal counsel confirms an exemption.

Key dates:

- 2024-12-10: CRA entered into force.
- 2026-09-11: reporting obligations begin.
- 2027-12-11: main obligations begin.

## Current Status

Status: **not yet conformity-ready**.

Reasons:

- No completed technical documentation package.
- No released SBOM attached to builds.
- No complete vulnerability handling evidence trail.
- No formal conformity assessment record.
- No release process proving secure-by-default configuration.

## Product Security Baseline

| Area | Current evidence | Status | Next action |
| --- | --- | --- | --- |
| Security contact | `SECURITY.md` template | Partial | Replace placeholder email |
| Vulnerability workflow | `docs/vulnerability-management.md` | Partial | Exercise with a test advisory |
| Dependency scanning | `scripts/security-audit.sh` | Partial | Run in CI and release gates |
| SBOM | `scripts/security-sbom.sh` | Partial | Attach SBOM to every release |
| Tauri permissions | `src-tauri/capabilities/default.json` | Partial | Review every command by threat model |
| CSP | `src-tauri/tauri.conf.json` allows unsafe script modes | Open risk | Remove or isolate `unsafe-eval`/inline needs |
| LAN companion | TOTP/HMAC design in Rust | Partial | Add rate limiting and document pairing UX |
| Password storage | Iterated SHA-256 | Open risk | Migrate to Argon2id or platform keychain |
| Updates | No updater policy found | Open risk | Define signed update channel or manual update policy |
| Secure defaults | Local-first mode documented | Partial | Verify network features are opt-in |
| Incident reporting | Procedure drafted | Partial | Add ENISA/CSIRT owner and contact details |
| User documentation | Privacy policy exists | Partial | Keep network/AI provider claims accurate |

## CRA Engineering Checklist

Before public EU distribution:

1. Define intended purpose, supported platforms, expected lifetime, and security
   support period.
2. Classify the product under the CRA risk categories and document the rationale.
3. Maintain a threat model covering WebView, Tauri commands, local files,
   companion LAN server, AI provider integrations, shortcuts, and updates.
4. Keep a dependency inventory and SBOM for every release.
5. Run vulnerability scans for npm and Cargo dependencies before release.
6. Track known vulnerabilities, mitigations, and fix versions.
7. Provide a private vulnerability reporting channel.
8. Define and test incident triage, fix, advisory, and CRA notification paths.
9. Ensure secure default configuration: local-first, least privilege, no exposed
   LAN services unless user-enabled.
10. Document user-facing security update instructions.
11. Preserve release evidence: build hash, SBOM, audit logs, changelog, signing
    status, and test results.
12. Prepare declaration of conformity and CE marking evidence when legally due.

## Technical Documentation Folder

Use this structure for each release:

```text
dist/security/
  lumen-<version>-sbom.cdx.json
  npm-audit.json
  cargo-audit.json
  cargo-deny.json or cargo-deny.txt
  release-security-notes.md
  dependency-licenses.txt
  build-hashes.txt
```

## Open Risks To Close First

1. Replace placeholder security contact in `SECURITY.md` and app documentation.
2. Add Argon2id password hashing for session locks.
3. Reduce CSP exceptions or isolate code that requires `unsafe-eval`.
4. Add rate limiting to companion pairing/token endpoints.
5. Add a signed update or clearly documented manual update process.
6. Add CI security workflow and make it required for releases.

## Release Decision

A release is CRA-ready only when all required checklist items are complete, all
critical/high vulnerabilities are fixed or formally accepted, and the release
record contains SBOM, scan results, build provenance, and user security notes.
