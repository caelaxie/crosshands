# Orca compatibility baseline

CrossHands uses `stablyai/orca` commit
`8adfef4ff80e7817b7c7bcd6b8ddf69289078c3c` as its first compatibility
baseline. Orca remains the source precedent; CrossHands' Product Contract is
the authority when a behavior is product-specific or intentionally differs.

## Operation ledger

| Orca operation             | CrossHands status | CrossHands operation       | Notes                                                         |
| -------------------------- | ----------------- | -------------------------- | ------------------------------------------------------------- |
| `capabilities`             | kept              | `capabilities`             | Contract-versioned capability report                          |
| `list-apps`                | kept              | `list-apps`                | Stable platform-derived app identity is added                 |
| `permissions`              | adapted           | `permissions`              | Inspects and guides; never automates OS permission dialogs    |
| `list-windows`             | kept              | `list-windows`             | Window identity is bound to process/session identity          |
| `get-app-state`            | adapted           | `get-app-state`            | Returns an opaque interaction context and desktop epoch       |
| `click`                    | kept              | `click`                    | Element and coordinate targeting retain explicit verification |
| `perform-secondary-action` | kept              | `perform-secondary-action` | Only provider-advertised actions are accepted                 |
| `scroll`                   | kept              | `scroll`                   | Invalidates earlier observation state                         |
| `drag`                     | kept              | `drag`                     | Element-to-element and coordinate forms remain                |
| `type-text`                | adapted           | `type-text`                | Secret-safe input is supplied through stdin, never arguments  |
| `press-key`                | kept              | `press-key`                | Platform-normalized key vocabulary                            |
| `hotkey`                   | kept              | `hotkey`                   | Platform-aware modifier normalization                         |
| `paste-text`               | adapted           | `paste-text`               | Clipboard side effects are explicit and verified              |
| `set-value`                | adapted           | `set-value`                | Protected-field input requires the secret-safe path           |

All 14 pinned Orca computer-use operations remain represented. CrossHands
removes the Orca product concepts around them rather than silently dropping a
computer-use primitive.

## Flag ledger

| Orca flag or group               | Status   | CrossHands behavior                                               |
| -------------------------------- | -------- | ----------------------------------------------------------------- |
| `--json`                         | kept     | Machine output is stable JSON; diagnostics never share stdout     |
| `--app`                          | kept     | Accepts name, platform identity, or `pid:<number>` selectors      |
| `--window-id`, `--window-index`  | kept     | Resolved within the current interaction context                   |
| `--restore-window`               | kept     | Best-effort and verified; never implies success                   |
| `--no-screenshot`                | kept     | Omits image capture without changing semantic observation         |
| element and coordinate flags     | kept     | Mutually exclusive target forms are schema-validated              |
| literal `--text` / `--value`     | adapted  | Non-secret values only; protected values use stdin                |
| `--text-stdin` / `--value-stdin` | kept     | Dedicated secret-safe CLI channel                                 |
| `--worktree`                     | excluded | Orca orchestration concept; no CrossHands equivalent              |
| `--session`                      | excluded | Replaced by broker-issued interaction context, not agent sessions |

## Result and error meanings

- Provider delivery alone is not success. Mutations report `verified`,
  `indeterminate`, `failed`, or `not_attempted`.
- References are short-lived and bound to interaction context, graphical
  session, provider generation, process/window identity, snapshot, and desktop
  epoch.
- Missing permissions, stale targets, blocked targets, unsupported
  capabilities, invalid input, timeouts, and unavailable sessions are distinct
  machine-readable error classes.
- A usable accessibility observation may include an `issues` array for a
  separately failed screenshot component; adapters preserve its machine code,
  retry policy, and remediation instead of silently dropping the failure.
- Accessibility content and screenshot data are untrusted application content.
- Known sensitive applications are blocked before observation or action.

## Product concepts intentionally excluded

- Orca worktrees and agent sessions
- Electron application lifecycle and resource lookup
- IDE, terminal, orchestration, and renderer integration
- Orca RPC routing and product branding
- Remote or network transport

Copied or substantially derived files retain the Lovecast Inc. notice and MIT
permission text recorded in `THIRD_PARTY_NOTICES.md`.
