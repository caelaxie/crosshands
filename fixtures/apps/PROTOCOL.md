# CrossHands Conformance Fixture Protocol v1

The three fixture apps expose the same semantic controls through native accessibility APIs. They are test targets, not CrossHands providers, and must never be used as the source of provider success. The conformance driver resets a fixture, interacts only through the installed CrossHands artifact, and then reads the fixture's independent oracle file.

## Launch and reset

Each fixture accepts:

```text
--oracle <absolute path> --instance <a|b> --scenario <normal|slow|crash|rerender|sensitive|injection>
```

The runner creates a new private directory for each repetition and launches two processes (`a` and `b`). A clean launch writes oracle schema `crosshands.fixture-oracle/v1`, fixture version `1.0.0`, instance identity, render epoch, and semantic state. Reset means terminating both fixtures, deleting the private directory, relaunching, and comparing the oracle digest with the candidate manifest. A provider observation is never accepted as reset evidence.

The oracle contains counters, booleans, selection identifiers, focus identifiers, normalized text digests, coordinates, and render epochs. It never contains literal input, clipboard contents, secure values, accessibility text, screenshots, or canary material. Atomic replacement is required so the driver cannot read a partial state.

## Accessibility surface

Every platform fixture has stable native accessibility names prefixed `CrossHands Fixture` and provides:

- two same-named app instances and three independently identifiable windows;
- invoke, focus, toggle, selection, ordinary value, secure value, context-menu, scroll, and drag controls;
- ordinary text, key, hotkey, paste, and programmatic set-value targets;
- a high-contrast non-sensitive screenshot marker and controls that rerender with new native identities;
- Unicode and composed-character labels plus a malicious on-screen instruction labeled as untrusted fixture content;
- scenario triggers for a pre-dispatch delay, post-dispatch delay, process crash, rerender, overlay, and sensitive-app identity.

Multi-monitor, negative-origin, mixed-DPI, minimized, occluded, and off-screen states are imposed by the external driver because an application cannot independently prove the window manager's final placement. IME and clipboard restoration are likewise asserted by the driver using OS state digests, never literal retained values.

## Driver response

`benchmarks/conformance/run.mjs` invokes an absolute, runner-owned driver executable once per attempt. The executable reads one `crosshands.conformance-driver-request/v1` JSON line from stdin and writes exactly one `crosshands.conformance-driver-response/v1` JSON line to stdout. It must perform fixture reset, invoke the requested adapter, read the independent oracle, scan CrossHands-owned persistence locations for canary digests, and return only privacy-safe fields from `benchmarks/conformance/evidence.schema.json` that are not supplied by the runner.

Infrastructure invalidation is limited to the catalog's predeclared host/controller failures and requires an independently addressable runner event. Fixture, provider, adapter, permission, timeout, and assertion failures are product failures. Automatic retries are recorded and never erase the original repetition.

No committed file in this directory is release evidence. Release evidence must come from final installed packages on the declared interactive, resettable machines.
