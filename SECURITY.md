# Asenix Watcher Security Notes

Asenix Watcher is designed so validator runners can use Machine alerts without
giving Asenix control of their VPS, server, or local PC.

## What It Does

- Reads local node health from configured local endpoints such as
  `http://127.0.0.1:8545/health`.
- Reads public chain data from the configured Asentum RPC.
- Checks read-only system status: systemd active state, Docker running state,
  process presence, disk pressure, memory pressure, and optional log warnings.
- Sends outbound HTTPS heartbeats to the hosted Asenix Watcher bot server.
- Sends Telegram status messages to the user.

## What It Does Not Do

- It does not accept inbound network connections on the user's machine.
- It does not expose SSH, shell, terminal, or remote command execution.
- It does not restart, stop, start, upgrade, or modify the validator service.
- It does not read private keys, validator seeds, wallet files, or recovery
  phrases.
- It does not send raw log contents to Telegram by default.
- The hosted bot cannot execute commands on the user's machine.

## Pairing

The hosted bot creates a random pairing token when the user runs
`/connect_machine`. The local Machine alerts reporter uses that token to send
heartbeats. The token is stored hashed on the server.

If a pairing token is leaked, the user can run `/connect_machine` again to
create a new token, or `/remove` to delete the chat data.
