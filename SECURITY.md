# Security Policy

_Last updated: 2026-10-15_

Lumen is a local-first desktop application. This policy explains how to report
security issues and what users can expect from the project maintainers.

## Supported Versions

| Version | Security support |
| --- | --- |
| 0.3.x | Supported during active development |

Security fixes are provided for the latest public build unless a separate
long-term support version is announced.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately.

- Private reporting contact: [lumenassistantsecurity@gmail.com](mailto:lumenassistantsecurity@gmail.com).
- Include: affected version, operating system, reproduction steps, expected
  impact, logs or screenshots if useful, and whether the issue is actively
  exploited.
- Do not publish exploit details until a fix or mitigation is available.

## Response Targets

| Severity | Initial response | Target remediation |
| --- | --- | --- |
| Critical | 2 business days | 7 calendar days |
| High | 3 business days | 14 calendar days |
| Medium | 5 business days | 30 calendar days |
| Low | 10 business days | Next planned release |

If a vulnerability is already being actively exploited, it is handled as a
critical incident regardless of its initial score.

## Coordinated Disclosure

We aim to:

1. Acknowledge the report.
2. Confirm whether the issue is reproducible.
3. Assign severity using CVSS v4.0 or the closest applicable CVSS version.
4. Prepare a fix, mitigation, or documented risk acceptance.
5. Credit the reporter if requested.
6. Publish an advisory when users need to take action.

## Cyber Resilience Act Reporting

For products made available on the EU market, actively exploited vulnerabilities
and severe incidents must be assessed for reporting under Regulation (EU)
2024/2847, the Cyber Resilience Act. Lumen's internal workflow is documented in
`docs/vulnerability-management.md`.

The CRA reporting obligation starts on 2026-09-11. Main CRA obligations apply
from 2027-12-11.

## Security Scope

In scope:

- Tauri command exposure and privilege boundaries.
- Local file access and sandbox isolation.
- Companion LAN server authentication and authorization.
- Secret handling, API keys, tokens, and credentials.
- Update, build, packaging, and dependency supply chain.
- XSS or content injection in bundled WebViews.

Out of scope:

- Issues requiring physical access to an unlocked machine without privilege
  escalation.
- Vulnerabilities in third-party AI models or services that are not caused by
  Lumen integration code.
- Social engineering.

## Security Baseline

Before public release, every build should pass:

```bash
npm run security:audit
npm run security:sbom
```

Generated reports are written to `dist/security/` and should be attached to the
release record.

## Dependency audit — 2026-10-15

The desktop and standalone server lockfiles report zero known vulnerabilities
with the RustSec database fetched for this review. SQL Server now uses the
official tiberius 0.13.0 TLS stack. A documented local object adaptation
selects patched ruzstd 0.9.1 for firmware parsing; see
`src-tauri/crates/object/LUMEN-PATCH.md`. No advisory is suppressed.

The complete audit still exits nonzero for two moderate npm findings
(ExcelJS/uuid), reviewed under R-009 in `docs/security-risk-register.md`.
An accepted risk is not a clean npm audit. Real SQL Server interoperability,
platform builds and optional native engine archives require separate checks.
