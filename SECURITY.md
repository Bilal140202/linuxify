# Security Policy

## Supported Versions

Linuxify is currently pre-1.0 alpha software. Security fixes will be applied
to the latest `main` branch and to the most recent tagged release. Once v1.0
ships, the latest two minor releases will receive security patches for three
months each (LTS policy — see `docs/14-cicd/release-pipeline.md`).

| Version | Supported          |
|---------|--------------------|
| 0.x.x   | :white_check_mark: latest only |
| < 0.1   | :x: not released    |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report vulnerabilities privately:

- **Email**: `security@linuxify.dev`
- **PGP**: Encrypt sensitive reports using the public key in `KEYS` (to be
  published with the v0.1.0 release). Until then, plain email is acceptable.

Please include:
- A description of the vulnerability and its impact.
- Steps to reproduce (proof of concept if possible).
- Affected versions (run `linuxify --version` and `linuxify doctor`).
- Any suggested mitigations or fixes.

### Response Timeline

- **Acknowledgement**: within 48 hours of report.
- **Initial assessment**: within 5 business days.
- **Fix or mitigation**: targeted within 30 days for high-severity issues,
  90 days for medium, best-effort for low.
- **Public disclosure**: coordinated with reporter after fix is released.
  Default disclosure window is 90 days from initial report, extendable by
  mutual agreement.

## Scope

In scope:
- The Linuxify CLI itself.
- The Linuxify package registry (git-based v1 and HTTP v2 when shipped).
- The Linuxify plugin SDK and plugin loading mechanism.
- The Linuxify documentation site (if a vulnerability would let an attacker
  serve malicious content).

Out of scope:
- Vulnerabilities in upstream CLIs (Cline, Codex, etc.) — report to those
  projects directly.
- Vulnerabilities in Termux, proot, or proot-distro — report upstream.
- Vulnerabilities in Node.js, npm, or the Linux kernel — report upstream.
- Social engineering attacks against maintainers.
- Issues requiring root access on the user's device.

## Security Model

See `docs/13-security/security-model.md` for the complete security model,
trust boundaries, and threat analysis. See
`docs/13-security/threat-analysis.md` for the STRIDE-based threat catalog
and risk register. See `docs/13-security/key-management.md` for cryptographic
key handling.

## Known Security Limitations

Linuxify v1 has honest limitations documented in
`docs/13-security/security-model.md` §15. The most important:

- **proot is not a security boundary.** Code running inside proot has the
  same filesystem access as the user. Do not run untrusted CLIs.
- **Packages inherit upstream trust.** A malicious npm/PyPI package can do
  anything the user can do. Linuxify does not re-verify upstream signatures
  in v1.
- **Plugins run with full user privileges.** No sandboxing in v1. Capability-
  based plugin sandboxing is on the v2 roadmap.
- **No package signing in v1.** The v1 git-based registry relies on signed
  git commits by maintainers, not per-package signatures. Ed25519 package
  signing is on the v2 roadmap (see `docs/20-adrs/adr-013-ed25519-for-package-signing-v2.md`).

## Acknowledgements

Security researchers who responsibly report vulnerabilities will be credited
in the release notes that ships the fix (with their permission). We're
grateful for every report.
