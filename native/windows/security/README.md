# Windows control-pipe relay

`pipe_relay.cpp` is the security boundary for the Windows broker endpoint. The
release build compiles it for x64 and records its SHA-256 in the payload
manifest. The PE is unsigned. A stock Windows 10/11 machine runs the packaged
executable; it does not compile it and does not require PowerShell 7.

The relay, rather than Node, owns `CreateNamedPipeW`. It installs a protected
DACL for the broker's current logon SID before listening, sets
`PIPE_REJECT_REMOTE_CLIENTS`, verifies the client PID, Windows session, user
SID, logon SID/authentication ID, and integrity level while impersonating the
client, and only then forwards bytes to the broker over inherited stdio.

Build from an x64 Native Tools Command Prompt:

```bat
native\windows\security\build.cmd
```

The build writes
`packages\platform-windows\assets\crosshands-pipe-relay.exe`. Release assembly
must then:

1. Hash the compiled PE.
2. Record the hash under `files["crosshands-pipe-relay.exe"]`.
3. Pack the PE, manifest, and notices together. Runtime compilation or a PATH
   lookup for the helper is forbidden.

The JavaScript launcher verifies the package-relative absolute path and
final-byte SHA-256 before spawning. The signed release manifest remains the
authority for the expected hash.

Do not replace this with a Node `net.Server` plus a post-accept check. Node's
public API does not expose the accepted named-pipe handle needed to set the
DACL or query the peer token before request bytes enter JavaScript.
