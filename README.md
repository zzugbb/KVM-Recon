# KVM-Recon

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/zzugbb/KVM-Recon/actions/workflows/ci.yml/badge.svg)](https://github.com/zzugbb/KVM-Recon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/zzugbb/KVM-Recon?include_prereleases)](https://github.com/zzugbb/KVM-Recon/releases)

Offline BMC/KVM evidence capture.

KVM-Recon is an offline desktop client that records browser-visible evidence while an operator logs into a BMC and opens HTML5 KVM. It manually exports a Capture Pack 2.0 containing HTTP bodies, scripts, browser state, screenshots, and realtime channel data. Capture does not depend on vendor or protocol-family rules. Packs are **unredacted** and must be handled as sensitive data.

The current version is 0.3.0 and uses Capture Pack 2.0. Historical 0.2.x packs and their YES/PARTIAL/NO results are not Capture Pack 2.0 integrity verdicts.

The in-app UI and the field guide are currently Chinese. This README is the English entry for GitHub visitors.

## What this project is

- An offline capture tool. It is **not** a production KVM gateway and does not provide a remote console for operators.
- It does not need the public internet and does not call external analysis services inside the server room.
- Operators enter a BMC address, optionally add a free-text device label, then manually log in and open HTML5 KVM.
- This tool **does not write adapters**.

Capture Pack 2.0 reports only `captureIntegrity` (COMPLETE/INCOMPLETE) and `workflowStatus`. It does not classify the protocol family. An unfamiliar architecture may still yield a COMPLETE pack if the observed evidence and integrity gates are satisfied.

## Download

Get macOS and Windows installers from [GitHub Releases](https://github.com/zzugbb/KVM-Recon/releases) and check `SHA256SUMS.txt`. Maintainer release steps are in `docs/releasing.md`.

Current builds **do not use paid Apple / Microsoft developer certificates**:

- **macOS**: ad-hoc signature. If Gatekeeper says the developer cannot be verified after a browser download, allow it in **System Settings → Privacy & Security**.
- **Windows**: no Authenticode signature. If SmartScreen says Windows protected your PC or the publisher is unknown, choose **More info → Run anyway**.

0.3.0 field instructions (Chinese) are in [docs/field-guide.md](docs/field-guide.md). Historical 0.2.x instructions remain available from their Git tags.

## Field workflow

1. Install and open KVM-Recon in the server room.
2. Enter the BMC address and optionally a free-text device label.
3. Start capture. The tool opens an isolated browser and records optional TLS/Redfish facts.
4. An embedded browser opens the BMC. On-site staff **manually** log in if needed.
5. Open HTML5 KVM and wait for the Viewer picture; keep any popup open.
6. The tool records Chromium-observable HTTP, scripts/Workers, state, screenshots, and realtime channels. The pack includes `raw/http/session.har` with captured bodies, so no separate Chrome HAR export is needed. Missing bodies or sources are reported; HAR is not a wire-level packet capture.
7. Manually export the pack. Start with `00_START_HERE.md` inside the ZIP.

The main window shows the current tool version (`vX.Y.Z`). Exported packs also include `manifest.tool.buildId` so a field package can be traced to the exact build.

## Development

Requires Node.js 22+.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run dev
```

- `npm test`: unit tests plus Mock KVM, schema, and export checks. The optional field HAR replay uses `KVM_RECON_FIELD_COLLECTION_2`.
- `npm run test:e2e`: Electron browser capture and protocol-fixture replay (build first).
- `npm run package:mac` / `npm run package:win`: local installers; tagged `v*` releases are documented in `docs/releasing.md`

## Docs

Index: `docs/README.md`.

- `docs/v0.3-development-spec.md`: 0.3.0 data contract and implementation specification
- `docs/field-guide.md`: 0.3.0 field workflow (Chinese)
- `docs/releasing.md`: build and publish installers
- `docs/development-plan.md`: product boundary and current status
- `schema/2.0/`: Capture Pack 2.0 JSON Schema
- `CHANGELOG.md`: version history
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`

## Safety and limits

- Packs can contain plaintext passwords, cookies, tokens, and realtime payloads. Store and share them only in controlled environments; never attach a raw pack to a public issue.
- Will not: auto-login, MITM, call AI inside the server room, auto-write adapters, or fully decode video.
- Report vulnerabilities via [Security Advisories](https://github.com/zzugbb/KVM-Recon/security/advisories/new). Do not paste credentials or unredacted capture packs into issues.

## License

[MIT](LICENSE)
