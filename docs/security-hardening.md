# Security Hardening Notes

_Last updated: 2026-07-06_

This document lists concrete hardening work for Lumen. It is intentionally
practical: each item should become a small issue or pull request.

## WebView And CSP

Current CSP allows `unsafe-inline`, `unsafe-eval`, remote `https:` connections,
and disables asset CSP modification for scripts and styles.

Target state:

- Remove `unsafe-eval` from the main app.
- Move inline scripts to bundled files.
- Use nonces or hashes where inline scripts are unavoidable.
- Restrict `connect-src` to known providers and user-configured endpoints.
- Keep previews/sandboxed user content in isolated windows or iframes.

## Tauri Commands

Target state:

- Maintain an inventory of all exposed Tauri commands.
- Mark commands as public, session-protected, profile-protected, or admin-only.
- Require session unlock for file, memory, agent, shortcut, and execution-like
  operations where user data or local actions are involved.
- Add input validation for paths, URLs, workflow names, and shell arguments.

## Companion LAN Server

Current design uses TOTP pairing and HMAC-signed tokens. Further hardening:

- Add rate limiting to `/auth/pair`.
- Add request size limits.
- Add token audience/version fields, not only expiry.
- Consider showing an explicit "LAN companion is active" indicator.
- Bind to LAN only after explicit user action.

## Secrets

Target state:

- Store API keys and long-lived secrets in the OS keychain where available.
- Use Argon2id for password-derived hashes.
- Avoid putting bearer tokens in URLs when possible; if unavoidable for
  WebSocket/images, keep TTL short and avoid logging query strings.

## Updates

Target state:

- Decide between Tauri signed updater or manual signed release downloads.
- Publish security update instructions.
- Keep release signing evidence with each release.
- Document expected product lifetime and support window.

## Supply Chain

Release gate:

```bash
npm run security:audit
npm run security:sbom
```

Recommended additional tools:

- `cargo audit`
- `cargo deny`
- `cargo cyclonedx`
- `@cyclonedx/cyclonedx-npm`

The security-fixed dependency set currently requires Rust 1.89 or newer. Update
Rust before running release builds:

```bash
rustup update stable
```

If you must stay on Rust 1.86 temporarily, install compatible audit tools:

```bash
cargo install cargo-audit --version 0.22.1 --locked
cargo install cargo-deny --version 0.18.3 --locked
```

`cargo-deny 0.18.x` cannot parse newer RustSec advisories that use CVSS 4.0.
The audit script therefore lets `cargo-audit` cover RustSec advisories and runs
`cargo-deny` for bans, licenses, and sources on Rust 1.86.

The audit script tolerates missing optional tools but fails on detected
vulnerabilities when the relevant scanner is available.
