# ProofBlade CTF containers

These images are local execution environments for Web/Pwn competition runs.
They are deliberately separate from the model/provider process and are created
per challenge by `DockerContainerRuntime`.

Build them from the repository root:

```powershell
pwsh -File .\scripts\build-ctf-images.ps1
```

The first build downloads the Ubuntu packages, Playwright Chromium, and the
Pwn toolchain, so it can take several minutes and use multiple gigabytes of
local Docker storage. The Web image exposes Playwright's bundled Chromium at
`/opt/playwright-browsers`; it does not require a host browser or X server.

`target-only` networking starts the small egress gateway image beside the
solver container and only permits the concrete IPv4 host/port pairs parsed from
the platform connection string. Use `networkPolicy: "none"` for offline
analysis or `"bridge"` only for a deliberate local-development configuration.

The default image tags are local (`proofblade/ctf-web:latest`,
`proofblade/ctf-pwn:latest`, `proofblade/ctf-pwn-kernel:latest`, and
`proofblade/ctf-egress-gateway:latest`). Change them in `proofblade.config.json`
when using a private registry, and keep `pullPolicy: "never"` in an offline
competition environment.
