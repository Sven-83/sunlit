# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
  Placeholder for next release.
  Add entries under ### Added / Changed / Fixed / Removed.
  The @alcalzone/release-script will replace this with the actual version when run.

  ## __WORK IN PROGRESS__
-->

## 0.0.1 - 2026-04-25

### Added

- Initial scaffolding.
- TCP/JSON protocol client for SunEnergyXT BK215 (handshake, commands, ACK).
- mDNS auto-discovery via `bonjour-service`.
- Position-form PI controller with conditional-integration anti-windup, deadband and hysteresis.
- Composite safety guard with eight distinct fail-safe reason codes.
- Foreign-state grid reader with EWMA smoothing and freshness tracking.
- Zero-feed-in scheduler with re-entrancy guard and park-on-stop.
- Full TypeScript strict-mode build.
- 83 unit tests across protocol, controller, safety, and discovery modules.
- jsonConfig admin UI with German and English translations.
- GitHub Actions CI: lint, type-check, unit + package + integration tests on Node 20/22 across Linux/macOS/Windows.
