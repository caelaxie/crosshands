# CrossHands

CrossHands is a local computer-use runtime for coding agents. It inspects and
operates the current user's desktop through a JSON CLI and an MCP server over
stdio. It only controls that user's active graphical session.

## Prompt

Paste this into any coding agent:

```
Install and configure CrossHands for this coding agent.

CrossHands drives the current user's local desktop. It does not provide remote
control.

1. Confirm Node.js 22 or newer is available.
2. Install the CLI and MCP adapter together at the same version:

   npm install --global @crosshands/cli @crosshands/mcp

   Do not install a @crosshands/platform-* package directly.

3. Run this from the same local desktop session:

   crosshands computer doctor --json

   Continue if readiness is ready or capability_reduced. If it is
   operator_action_required or unavailable, tell me the exact operator
   action or error. Never click or accept an OS permission dialog. On
   macOS, ask me to grant Accessibility and Screen Recording to
   "CrossHands Computer Use" in System Settings.

4. Register a stdio MCP server in this agent's usual MCP config:

   command: crosshands-mcp
   args: []

   Do not add a network listener.

5. If this agent uses skills, copy
   https://raw.githubusercontent.com/caelaxie/crosshands/main/skills/computer-use/SKILL.md
   into its skills directory.

Confirm doctor readiness and that the MCP server is registered.
```

## License

CrossHands is MIT licensed. Copied or substantially derived Orca code retains
Lovecast Inc.'s copyright and license notice. See `LICENSE` and
`THIRD_PARTY_NOTICES.md`.
