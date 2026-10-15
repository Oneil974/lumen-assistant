# Security Risk Register

_Last updated: 2026-10-07_

| ID | Risk | Severity | Status | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| R-001 | Missing public security contact | High | Mitigated 2026-10-15 | Maintainer | Private vulnerability reporting contact configured in `SECURITY.md`. Privacy-policy contact remains a separate release checklist item. |
| R-002 | CSP allows `unsafe-inline` and `unsafe-eval` | High | Open | Engineering | Required areas must be isolated or refactored before CRA-ready release. |
| R-003 | Session password hashing uses iterated SHA-256 | Medium | Open | Engineering | Migrate to Argon2id or OS credential storage. |
| R-004 | Companion server listens on LAN when enabled | Medium | Open | Engineering | Add rate limiting, request size limits, and visible active state. |
| R-005 | No signed update policy | High | Open | Release owner | Decide Tauri signed updater or signed manual downloads. |
| R-006 | npm dependency vulnerabilities via `@magenta/music` | Critical | Mitigated | Engineering | Removed optional Magenta runtime path; WebAudio local engine remains. Confirm with `npm audit`. |
| R-007 | Rust advisories in PDF/XML/firmware dependencies | High | In progress | Engineering | `time`, `plist`, and `notify-rust` security updates require Rust 1.89+. `lopdf` remains via `printpdf` and `pdf-extract`; `xmas-elf` remains via `espflash`. |
| R-008 | MapLibre GL `DOM.sanitize()` XSS bypass (GHSA, critical, `<=6.4.0`) shipped in `src/lib/vendor/maplibre/` | Critical | Mitigated | Engineering | Upgraded to `maplibre-gl@6.11.2`. v6 is ESM-only: `scripts/build-vendor.mjs` re-bundles it with esbuild into an IIFE (`window.maplibregl`, API unchanged for `src/carte/`) + a standalone module worker located via `setWorkerUrl`. Carte verified (vector basemap, GeoJSON layers, `queryRenderedFeatures`, popups). |
| R-009 | `uuid@8.3.2` bundled inside `exceljs@4.4.0` (`dist/exceljs.min.js`) — GHSA-w5hq-g745-h8pq, missing buffer bounds check (`<11.1.1`) | Moderate | Accepted | Engineering | Not reachable: the flaw only affects `v3`/`v5`/`v6` called with a `buf` argument; exceljs only calls `v4()` without arguments (conditional-formatting `x14Id`). No newer exceljs exists (4.4.0 is latest, unmaintained since 2024-12); an npm `overrides` would not change the shipped prebuilt bundle, and rebuilding exceljs from `lib/` would need Node polyfills. Allow-listed in `scripts/vendor-inventory.mjs` for this exact range only; revisit if exceljs publishes a release or if a replacement (e.g. SheetJS CE) is adopted. |
| R-010 | SQL Server connector legacy TLS chain | Unscored by advisory | Mitigated 2026-10-15 | Engineering | Updated to official tiberius 0.13.0 (tokio-rustls 0.26); removed rustls 0.21 and rustls-webpki 0.101.7. Desktop and standalone server locks updated to rustls 0.23.46 / quinn-proto 0.11.19. Firmware decompressor ruzstd updated to 0.9.1 through the documented object bridge. Fresh cargo-audit reports zero known vulnerabilities in both locks; no advisory suppression added. Live SQL Server connection testing remains required. |
