# CrossHands

CrossHands is a standalone, agent-agnostic computer-use runtime for coding
agents. It exposes one versioned operation contract through two local adapters:

- a JSON CLI with an installable computer-use skill;
- an MCP server over stdio.

CrossHands is based on the computer-use subsystem in
[stablyai/orca](https://github.com/stablyai/orca) and is being separated so
agents can use the capability without installing the Orca desktop application.
The compatibility baseline is Orca commit
`9c8f4c398c3f8ba267cca14e0b65c3f6f87f2aa4`.

## First-release scope

- Local computer use on macOS, Windows, and Linux.
- macOS and Windows are the primary reliability targets.
- Linux targets Ubuntu 24.04 GNOME on Xorg for full conformance and reports
  capability gaps honestly on Wayland.
- Codex, OpenCode, and Oh My Pi are reference clients, not dependencies.

Remote control, hosted services, agent orchestration, OpenTelemetry, and a
general-purpose desktop UI are intentionally outside the first release.

## Installation and readiness

CrossHands is not published to the public npm registry yet. Release candidates
are installed from the project's configured restricted npm-compatible registry;
do not install similarly named packages from an unverified registry. Once a
stable release is published, the supported global installation is:

```sh
npm install --global crosshands @crosshands/mcp
crosshands computer doctor --json
```

The `crosshands` package selects exactly one version-matched platform payload
for the current OS and CPU. Do not install a platform payload directly. Doctor
must report a compatible payload, a protected local broker endpoint, an active
unlocked graphical session, native dependencies, integrity, and permissions
before an agent is allowed to mutate the desktop. macOS permissions are granted
manually in System Settings; Windows must run on the local equal-integrity
desktop; Linux full support requires Ubuntu 24.04 GNOME on Xorg.

See the [install, update, and uninstall guide](docs/platforms/install.md) and the
platform notes for [macOS](docs/platforms/macos.md),
[Windows](docs/platforms/windows.md), and [Linux](docs/platforms/linux.md).

## Updating and uninstalling

Update the CLI, MCP adapter, and platform payload as one versioned bundle. A
mixed-version or partially installed bundle fails before desktop dispatch. The
release process stages and verifies the complete replacement before activation,
and preserves the previous complete release for the supported rollback path.

Before uninstalling, close every agent using CrossHands and remove both global
packages with the same package manager that installed them. CrossHands-owned
broker IPC, caches, logs, and temporary captures may then be removed; exported
screenshots and user configuration are preserved. Operating-system permission
records are never removed automatically. Exact paths and permission-revocation
steps are in the [lifecycle guide](docs/platforms/install.md#uninstall).

## Development

CrossHands requires Node.js 22 or newer and uses the package manager pinned in
`package.json`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

The repository is under active development and is not yet a public release.
See [the Orca compatibility ledger](docs/compatibility/orca-9c8f4c3.md) for the
extraction boundary and intentional deviations.

Release workflows intentionally fail closed until the restricted registry,
signing identities, notarization/timestamp services, protected environments,
and backup release owners are configured. A candidate is built once and
promoted by digest without rebuilding it.

The checked-in conformance and release tests validate catalogs, schemas, and
evidence policy; they are not a claim that live desktops or reference agents
have passed. A release candidate must still run the final installed artifacts
on the complete interactive matrix described in the
[provider conformance guide](docs/platforms/conformance.md), then pass the
[Codex, OpenCode, and OMP benchmark](docs/platforms/agent-benchmarks.md).
Promotion requires those exact evidence artifacts.

## License

CrossHands is MIT licensed. Copied or substantially derived Orca code retains
Lovecast Inc.'s copyright and license notice. See `LICENSE` and
`THIRD_PARTY_NOTICES.md`.
