# Windows control-pipe relay

`pipe_relay.cpp` is the security boundary for the Windows broker endpoint. The
release build compiles it for x64, signs the resulting PE with the CrossHands
Authenticode identity, and records its SHA-256 and signer in the release
manifest. A stock Windows 10/11 machine runs the packaged executable; it does
not compile it and does not require PowerShell 7.

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

1. Sign that exact PE with SHA-256 and an RFC 3161 timestamp.
2. Verify it with `signtool verify /pa /all /v` on Windows 10 and Windows 11.
3. Hash the final signed bytes; signing after hashing invalidates the candidate.
4. Record the hash under `files["crosshands-pipe-relay.exe"]` and set the
   manifest's required Authenticode publisher, certificate thumbprint, and
   timestamp policy.
5. Pack the PE, manifest, and notices together. Runtime compilation or a PATH
   lookup for the helper is forbidden.

The JavaScript launcher verifies the package-relative absolute path, final-byte
SHA-256, trusted Authenticode chain, exact publisher, thumbprint shape, and
timestamp policy before spawning. The signed release manifest remains the
authority for the expected hash and signer.

Do not replace this with a Node `net.Server` plus a post-accept check. Node's
public API does not expose the accepted named-pipe handle needed to set the
DACL or query the peer token before request bytes enter JavaScript.
