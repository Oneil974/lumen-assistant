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
- Remove passwords, API keys, tokens and personal data from logs or screenshots.
  Do not send live credentials or unredacted user databases.
- Coordinate disclosure with the maintainer before publishing exploit details.

## Handling Reports

Reports are reviewed on a best-effort basis, with priority given to active
exploitation and issues with the greatest impact. Response and remediation
times depend on maintainer availability and the complexity of the issue;
this project does not commit to fixed response or resolution deadlines.

## Coordinated Disclosure

We aim to:

1. Acknowledge the report.
2. Confirm whether the issue is reproducible.
3. Assess severity based on impact and exploitability, using CVSS where useful.
4. Prepare a fix, mitigation, or documented risk acceptance.
5. Credit the reporter if requested.
6. Publish an advisory when users need to take action.

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

Generated reports are written to `dist/security/`. Review and redact them
before sharing or attaching them to a release. Dependency audits do not
replace checks for exposed credentials, code review or platform testing.

## Dependency audit — 2026-10-15

The desktop Cargo lockfile reported zero known vulnerabilities with the
RustSec database fetched for the 2026-10-15 review. This is a dated audit
result, not a guarantee about future advisories. SQL Server now uses the
official tiberius 0.13.0 TLS stack. A documented local object adaptation
selects patched ruzstd 0.9.1 for firmware parsing; see
[`LUMEN-PATCH.md`](src-tauri/crates/object/LUMEN-PATCH.md). No advisory is suppressed.

The complete audit still exits nonzero for two moderate npm findings
(ExcelJS/uuid), reviewed under R-009 in the
[security risk register](docs/security-risk-register.md).
An accepted risk is not a clean npm audit. Real SQL Server interoperability,
platform builds and optional native engine archives require separate checks.
