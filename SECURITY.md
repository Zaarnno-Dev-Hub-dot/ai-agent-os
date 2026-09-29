# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's **Report a vulnerability** button on the
[Security tab](https://github.com/Zaarnno-Dev-Hub-dot/ai-agent-os/security/advisories/new)
of this repository. Include what you found, how to reproduce it, and what you think the impact is.
You should get a first reply within a few days.

## What to know about the design

AI Agent OS is a **local-first tool for one person on one machine**. Keep these in mind when you run it:

- **The gateway listens on `127.0.0.1` only** and has no login. Do not expose it to a network, put it behind a
  public tunnel, or bind it to `0.0.0.0` without adding authentication in front of it. The optional
  `AGENT_OS_ALLOW_TUNNEL_ORIGINS` setting only widens which browser origins may call it; it does not add auth.
- **Saved API keys are stored in plain text** in `data/saved-agents.json` so agents can reconnect. They are never
  sent back to the browser. `data/` is git-ignored; keep it private and out of backups you share.
- **Agents run with the permissions of the CLI you connect.** A connected coding agent (Claude, Codex, Cursor and
  so on) can read and change files in its workspace and run commands, just as it can in your terminal. Only connect
  agents you trust, and point them at workspaces you are happy for them to change.
- **Proof of life is not a sandbox.** The nonce check shows that an agent is alive and answering. It does not
  limit what the agent can do.
- **Your CLI logins stay with the CLIs.** The dashboard never asks for ChatGPT, Claude or Grok passwords.

## In scope

Bugs in this repository that let a web page or another local process read chat history or saved keys, make the
gateway run commands it should not, escape an agent's workspace, or bypass the proof-of-life check.

## Out of scope

Anything that needs you to expose the gateway to an untrusted network, vulnerabilities in the third-party CLIs
and services you connect, and social-engineering attacks.