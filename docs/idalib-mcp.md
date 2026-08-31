# IDALIB-MCP

ProofBlade uses the installed `ida-pro-mcp` package through
`scripts/idalib-mcp-streamable.py`. The adapter initializes IDA headlessly,
opens exactly one target binary, and serves the upstream read-only analysis
tools over Streamable HTTP at `/mcp`.

Start one server for each target before a reverse run:

```powershell
D:\app\python\python.exe scripts/idalib-mcp-streamable.py `
  --host 127.0.0.1 --port 18745 `
  D:\CTF\图片和附件\magic
```

The project client then uses `http://127.0.0.1:18745/mcp`. The local Windows
port policy excludes 8745, so 18745 is intentional. A server must be restarted
with the next binary between tasks; the upstream IDALIB process is single-input
and does not provide a multi-binary session switch.

The private answer documents in the attachment directory must stay outside the
agent workspace and are never passed to IDA or the model. Keep expected answers
in the verifier-owned scorer only.
