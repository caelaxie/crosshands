# Provider conformance and release evidence

CrossHands does not claim provider reliability from source tests or a headless simulation. Release conformance runs the final immutable package set through the broker, CLI, and MCP against native fixture apps on dedicated, unlocked, resettable interactive machines.

## Frozen v1 suite

[`catalog.v1.json`](../../benchmarks/conformance/catalog.v1.json) is the release catalog. Its digest, fixture version, 28 tasks, three adapters, 100 repetitions, failure classifications, infrastructure invalidations, and thresholds are frozen before a candidate runs. Tasks are never removed after outcomes are visible.

Every mandatory task must independently reach 95/100 on every macOS and Windows cell and 90/100 on every Ubuntu Xorg cell, through each adapter. Scores are not pooled. Product failures remain in the denominator. Opaque automatic retries are forbidden in blocking v1 runs because their attempts cannot be independently scored; the runner retries only a predeclared infrastructure invalidation. An invalidated attempt remains in the evidence and can be replaced only when an independent runner-controller event is recorded.

The blocking matrix has Node 22 and Node 24 cells for:

- macOS 14.8.7 on Apple Silicon and Intel;
- macOS 26.5.2 on Apple Silicon;
- Windows 10 22H2 and the latest GA Windows 11 on x64;
- Ubuntu 24.04.4 LTS with GNOME Xorg on x64.

The Windows 11 role is `windows-11-current-x64`: candidate preparation must record whether Windows 11 26H1 is selected and freeze its exact edition and build rather than accepting a moving `current` label. Before running any candidate, the release coordinator records exact OS build numbers (and the Ubuntu image/build digest) in each candidate manifest. Each manifest also freezes architecture, Node version, desktop/session identity, display origins/sizes/scales, locale, IME, fixture reset digest, permissions, package digests, and signer fingerprints. An unavailable mandatory runner is a no-go.

## Fixtures and independent oracle

The macOS SwiftUI, Windows WPF, and Linux Tk fixtures in [`fixtures/apps`](../../fixtures/apps/PROTOCOL.md) expose matching native accessibility controls. They write a private, atomic semantic oracle containing counters and digests, not user-visible content. The driver must reset the fixtures independently, operate only through the installed CrossHands candidate, and compare final semantic state with that oracle.

Window-manager states (multiple monitors, negative origins, mixed scaling, minimized, occluded, and off-screen), session and peer identities, IME, clipboard restoration, payload substitution, timeouts, cancellation, provider crashes, and concurrent callers are imposed and measured by the runner. A fixture's own accessibility tree or a provider response cannot serve as the final oracle.

## Evidence rules

The platform driver protocol is intentionally external to the package under test. `run.mjs` refuses to run without an absolute executable supplied by the dedicated runner, verifies its SHA-256 against the reviewed digest frozen in each candidate manifest, and records every attempt immediately. The driver must return only normalized digests, semantic assertion state, error/outcome classification, retry count, and privacy attestations. Raw accessibility text, screenshots, clipboard data, window titles, literal input, and canary values are forbidden in retained evidence. The release owner reviews the exact driver digest as part of the runner trust root; a driver-provided classification alone is never evidence that another driver binary was reviewed.

Any identity/peer boundary failure, canary leak, sensitive-target exposure, payload-integrity failure, unsigned required artifact, MCP stdout corruption, human-only boundary bypass, rollback failure, or claimed success without a matching oracle rejects the release regardless of score. Result, error, and verification-state digests must match between broker, CLI, and MCP for an equivalent reset repetition.

The release coordinator retains access-controlled detailed privacy-safe fixture evidence for one year. The repository workflow artifact is a 90-day transport copy; signed manifests and aggregate reports are retained with the release. Release roles, approvals, package signatures, SBOM/notices, registry promotion identity, rollback drill, agent results, and post-promotion canaries belong in the immutable release manifest. Missing or inconsistent evidence is a no-go.

## Running the workflow

Interactive self-hosted runners must carry all labels declared in [`.github/workflows/conformance.yml`](../../.github/workflows/conformance.yml), start from a restored machine snapshot/dedicated account, and expose:

- `CROSSHANDS_CANDIDATE_MANIFEST`: absolute path to the cell's signed candidate manifest;
- `CROSSHANDS_CONFORMANCE_DRIVER`: absolute path to the reviewed platform driver;
- a final candidate already installed from the restricted registry, with the same digests recorded in the manifest.

Dispatch the workflow with the immutable candidate identifier. Each cell uploads original JSONL attempts even when it fails. The aggregate job accepts only all twelve exact cells and runs the strict evaluator. Headless `test:conformance` validates the catalog and evaluator but is not interactive provider evidence unless `CROSSHANDS_CONFORMANCE_EVIDENCE` points at downloaded real runner artifacts.

After that real-evidence test passes, `evaluate.mjs` writes the promotion input `conformance-evidence.json`. It contains six release-policy cells and all 28 frozen task IDs. Each task's `passed` value is the worst count across broker, CLI, MCP, Node 22, and Node 24, so a stronger adapter or Node cell cannot conceal a weaker one. The artifact retains product-failure and infrastructure counts, zero automatic retries, immutable record digests, exact OS/runner/package identities, and an empty exclusion list.

No interactive runner evidence exists in the repository by default. Until every declared cell, signing identity, registry-resolved artifact, rollback drill, and 24-hour canary has run, U10 and the v1 release claim remain incomplete.
