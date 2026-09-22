# CrossHands CLI

The `@crosshands/cli` package provides the local JSON CLI and broker entrypoint for
the CrossHands computer-use runtime.

```sh
crosshands computer doctor --json
crosshands computer list-apps --json
crosshands computer get-app-state --app <app> --goal <goal> --json
```

Install the matching platform payload for macOS, Windows, or Linux before
running real desktop operations. CrossHands controls only the active graphical
session on the local machine and does not authenticate one same-user agent
process from another.
