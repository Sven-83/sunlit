# Security Policy

## Supported Versions

Security fixes are provided for the latest published version on npm. Please always upgrade to the latest version before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in ioBroker.bk215, please **do not open a public GitHub issue**. Instead, report it privately through one of these channels:

1. **GitHub Security Advisory** (preferred):
   <https://github.com/Sven-83/sunlit/security/advisories/new>

2. **Email**: svmorgen@gmx.de — please include `[ioBroker.bk215 SECURITY]` in the subject line.

Please include:

- A description of the vulnerability
- Steps to reproduce
- The version affected
- Your assessment of the impact
- Any suggested mitigation, if you have one

You can expect:

- Acknowledgement of your report within 72 hours
- A fix or mitigation plan within 30 days for confirmed vulnerabilities
- Public disclosure (after the fix is released) crediting the reporter, unless you prefer to remain anonymous

## Scope

This policy covers the adapter code in this repository. It does not cover:

- Vulnerabilities in upstream dependencies (please report them to the respective project)
- Vulnerabilities in ioBroker core or other adapters (please report to the ioBroker community)
- Issues in the SunEnergyXT / Sunlit cloud or device firmware (please contact the manufacturer)

## What this adapter does with sensitive data

- The optional Sunlit cloud API token is stored encrypted (`encryptedNative`) at rest.
- No credentials are sent in plain text over the network — local TCP traffic to the BK215 carries no credentials at all (the device authenticates by network reachability).
- Logs at default `info` level do not contain credentials. At `debug` level, the wire-level protocol frames are logged; these do not contain credentials, but may contain device identifiers.
