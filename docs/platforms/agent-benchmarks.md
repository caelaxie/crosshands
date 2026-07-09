# Reference-agent and release evidence

CrossHands has two independent release axes. Provider conformance proves that the desktop implementation works. Reference-agent benchmarks prove that one frozen Codex, OpenCode, and Oh My Pi configuration can use both public adapters. An agent pass never substitutes for provider conformance.

No checked-in test result claims that a live agent or interactive platform runner was executed. Local tests use synthetic evidence fixtures to prove that incomplete or inconsistent release evidence is rejected.

## Frozen reference cells

The source of truth is [`benchmarks/agents/catalog.json`](../../benchmarks/agents/catalog.json). It binds the prompt, tasks, agent configuration files, generic skill, release policy, and their SHA-256 digests. The current pre-candidate freeze uses:

| Agent    | Exact client        | Model                                | Reference cell                    | Approval            | Network during run           |
| -------- | ------------------- | ------------------------------------ | --------------------------------- | ------------------- | ---------------------------- |
| Codex    | `codex-cli 0.143.0` | `gpt-5.1-codex`                      | macOS Tahoe 26.5.2, Apple Silicon | `never`             | only `api.openai.com:443`    |
| OpenCode | `opencode 1.17.10`  | `anthropic/claude-sonnet-4-20250514` | Windows 11 25H2 x64               | benchmark allowlist | only `api.anthropic.com:443` |
| Oh My Pi | `omp 16.3.14`       | `anthropic/claude-sonnet-4-20250514` | Ubuntu 24.04.4 GNOME Xorg x64     | benchmark allowlist | only `api.anthropic.com:443` |

Model availability, the exact operating-system build ID, runner image digest, Node patch, display, locale, IME, agent version, and every config digest are re-frozen before an RC. The Windows owner must record why Windows 11 25H2 or new-device-scoped 26H1 is the applicable “latest GA” cell. A moving `latest` label is never acceptable evidence.

Each agent runs the same task five times through `cli-skill` and five times through `mcp`. At least four of five scored runs must match the independent fixture-state oracle for each adapter. Product failures and retries remain in the denominator. A run may be invalidated only for a predeclared runner-infrastructure class, and its original privacy-safe record remains linked. The prompt-injection task is characterization; its result is not described as a broker security boundary.

## Interactive runner contract

The agent workflow runs only on resettable, active, unlocked, same-user interactive runners. Each runner provides three non-repository executables:

- `CROSSHANDS_BENCHMARK_RESET_HOOK` restores the dedicated account and fixture oracle before a run and verifies cleanup afterward.
- `CROSSHANDS_NETWORK_GUARD` applies and verifies the exact model-API allowlist after packages are installed. Registry access is disabled during scored runs.
- `CROSSHANDS_AGENT_BENCHMARK_DRIVER` verifies the installed client version and config, installs the immutable candidate artifacts, executes both adapters, resets the fixture between trials, queries the independent final-state oracle, and writes one fragment matching the validator contract.

The driver must not write accessibility text, screenshots, clipboard contents, literal input, or the canary to evidence. Its fragment retains only IDs, classifications, durations, oracle matches, and cryptographic bindings. The workflow combines exactly one fragment per reference agent and rejects fewer than five scored trials, fewer than four oracle matches, config drift, a missing characterization, or forbidden raw fields.

## Release evidence gate

`tests/release/` exercises the same validator against synthetic fixtures. A real release evidence document is accepted only when it binds all of the following:

- candidate and default-channel package sets with identical versioned SHA-256 digests;
- the signed release manifest, signer fingerprint, macOS notarization, Windows Authenticode timestamp and chain, and Linux payload signature;
- the SPDX SBOM and a legal-notice binding for every package;
- exact runner baselines and package image digests for Sonoma 14.8.7 on Intel and Apple Silicon, Tahoe 26.5.2 on Apple Silicon, Windows 10 22H2, the adjudicated Windows 11 25H2/26H1 GA cell, and Ubuntu 24.04.4 GNOME Xorg;
- 100 retained outcomes for each of the 28 exact task IDs in the cryptographically bound conformance catalog, in every cell, with at least 95 passes on macOS/Windows and 90 on Linux;
- Node 22 and 24 package, CLI, and MCP gates, adapter parity, and the validated 4/5 reference-agent aggregate;
- zero violations for identity, peer, secret, payload-integrity, silent-success, sensitive-target, and MCP-stdout cases;
- signed `go` decisions from the release coordinator, three provider owners, signing/provenance owner and a distinct backup, benchmark adjudicator, rollback owner, and issue/security intake owner;
- a last-known-good rollback drill, main-package-first channel rollback, same-digest promotion, and clean-machine canaries on all three platforms at promotion, 1 hour, 6 hours, and 24 hours.

Supplying an artifact directory to `validate-evidence.mjs` additionally verifies `artifacts/release/release-manifest.json` cryptographically, checks the SBOM and notice bindings, and hashes every package under `artifacts/packages/`. Without the public release key, artifact validation fails closed.

Any missing runner, unsigned artifact, failed primitive, unreviewed exclusion, safety violation, silent success, digest drift, failed rollback, or canary failure is a no-go regardless of aggregate score. Raw application evidence is not retained. Privacy-safe detailed records are access-controlled by the release coordinator for 365 days; signed manifests and aggregate reports follow the release retention policy.

## Promotion, rollback, and finalization

Promotion takes exact artifact names and workflow run IDs for provider conformance, validated reference-agent evidence, and a signed combined `release-evidence.json`. It also takes the expected Ed25519 public-key fingerprint. Before any registry tag moves, the release workflow downloads those artifacts cross-run, verifies the combined signature, binds both embedded sections byte-for-byte to the separately downloaded evidence, and verifies their candidate package-set and release-manifest identities. It then enforces the per-cell thresholds, Node adapter gates, zero-tolerance cases, signed owner decisions, and rollback readiness. Promotion still moves only the previously published candidate digests and never rebuilds.

The 1-hour, 6-hour, and 24-hour canaries necessarily happen after promotion. Once the 24-hour record exists, run the separate `finalize` operation with the same candidate coordinates and a newly signed complete combined evidence artifact. Finalization invokes the full artifact-aware validator, including every canary, signature, SBOM, notice, package byte, approval, and rollback binding. It only uploads an immutable `v1-ready-<version>` evidence record and summary; it cannot publish a package or move a tag.

Rollback intentionally does not require currently passing conformance, agent, or canary evidence. It retains the existing signed last-known-good candidate-manifest and registry-integrity requirements, then moves the main package first and the matching payload set second.

## Running the model gates

```sh
corepack pnpm benchmark:agents
corepack pnpm release:validate
```

These commands validate definitions and evidence models; they do not impersonate a live agent run. Start the `Reference-agent benchmarks` workflow with an immutable release run ID and signed manifest digest to collect live acceptance evidence.
