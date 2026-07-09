# CrossHands

CrossHands is a standalone, agent-agnostic computer-use runtime for coding
agents. It exposes one versioned operation contract through two local adapters:

- a JSON CLI with an installable computer-use skill;
- an MCP server over stdio.

CrossHands is based on the computer-use subsystem in
[stablyai/orca](https://github.com/stablyai/orca) and is being separated so
agents can use the capability without installing the Orca desktop application.
The compatibility baseline is Orca commit
`8adfef4ff80e7817b7c7bcd6b8ddf69289078c3c`.

## First-release scope

- Local computer use on macOS, Windows, and Linux.
- macOS and Windows are the primary reliability targets.
- Linux targets Ubuntu 24.04 GNOME on Xorg for full conformance and reports
  capability gaps honestly on Wayland.
- Codex, OpenCode, and Oh My Pi are reference clients, not dependencies.

Remote control, hosted services, agent orchestration, OpenTelemetry, and a
general-purpose desktop UI are intentionally outside the first release.

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
See [the Orca compatibility ledger](docs/compatibility/orca-8adfef4.md) for the
extraction boundary and intentional deviations.

## License

CrossHands is MIT licensed. Copied or substantially derived Orca code retains
Lovecast Inc.'s copyright and license notice. See `LICENSE` and
`THIRD_PARTY_NOTICES.md`.
