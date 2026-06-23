# Asenix Watcher

Asenix Watcher is a Telegram-based monitoring tool for Asentum validators.

It helps operators track validator status, wallet balance, recent block
production, chain health, and optional machine-level health checks from the
server running the node or Operator app.

## What It Monitors

With only a validator wallet address, the bot can check:

- wallet balance
- validator-set presence
- public chain height
- recent proposed blocks
- basic chain availability

With Machine alerts enabled, it can also check:

- local node RPC availability
- local node height compared with public chain height
- systemd service status, when configured
- node process presence
- disk and memory pressure
- recent error-like log activity

Machine alerts are optional. The bot still provides public chain monitoring
without installing anything on the validator machine.

## Telegram Commands

```text
/add 0xValidatorWallet
/status
/chain
/node
/connect_machine
/remove
```

Command details:

- `/add 0x...` adds a validator wallet to monitor.
- `/status` shows the full watcher dashboard.
- `/chain` shows public chain and validator data.
- `/node` shows Machine alerts status.
- `/connect_machine` generates a one-line setup command for deeper machine checks.
- `/remove` removes the current Telegram chat data from the watcher.

After adding a wallet, the bot also provides inline dashboard buttons so users
do not need to remember commands.

## Machine Alerts

Machine alerts add deeper checks from the machine running the Asentum node or
Operator app. The setup command is generated inside Telegram:

```text
/connect_machine
```

The generated command includes a short-lived pairing token and should be run on
the same VPS, local PC, or server that runs the validator.

Linux example:

```bash
ASENIX_WATCHER_SERVER="https://watch.example.com" ASENIX_WATCHER_TOKEN="pairing-token" sh -c "$(curl -fsSL https://watch.example.com/install-machine-alerts.sh)"
```

Windows example:

```powershell
$env:ASENIX_WATCHER_SERVER="https://watch.example.com"; $env:ASENIX_WATCHER_TOKEN="pairing-token"; iex (irm https://watch.example.com/install-machine-alerts.ps1)
```

The Machine alerts reporter is outbound-only and read-only. It sends health
heartbeats to the hosted watcher server. It does not expose SSH, accept remote
commands, or store validator keys.

## Configuration

Create a local `.env` from the example file:

```bash
cp .env.example .env
```

Required server environment:

```text
TELEGRAM_BOT_TOKEN=
ASENIX_WATCHER_PUBLIC_URL=
ASENIX_WATCHER_REPO=
```

Useful optional settings:

```text
ASENIX_WATCHER_PORT=8787
ASENIX_PUBLIC_RPC_URL=https://testnet.asentum.com
ASENIX_SCAN_WINDOW_BLOCKS=256
ASENIX_POLL_SECONDS=60
ASENIX_REMINDER_MINUTES=60
ASENIX_PUBLIC_BLOCK_STALE_SECONDS=600
ASENIX_PUBLIC_BLOCK_CRITICAL_SECONDS=3600
ASENIX_WATCHER_SERVER_STATE=/data/watcher-server-state.json
```

`ASENIX_WATCHER_PUBLIC_URL` must be the public HTTPS URL for the hosted watcher
server. It is used when generating Machine alerts setup commands.

`ASENIX_POLL_SECONDS` controls how often the server checks Telegram and monitored
wallet status. `ASENIX_REMINDER_MINUTES` controls how often continuing problems
are repeated after the first alert.

`ASENIX_PUBLIC_BLOCK_STALE_SECONDS` controls when the bot warns that public chain
blocks look stale. `ASENIX_PUBLIC_BLOCK_CRITICAL_SECONDS` controls when that
becomes a critical chain-health alert.

## Running The Server

```bash
npm start
```

The server keeps chat state in a JSON file. For production deployments, use
persistent storage for `ASENIX_WATCHER_SERVER_STATE` or replace the JSON file
with a database-backed store.

## Deploying On Fly.io

The included `fly.toml` expects a persistent volume mounted at `/data`.

```bash
fly apps create asenix-watcher
fly volumes create asenix_watcher_data --size 1 --region lhr --app asenix-watcher
fly secrets set TELEGRAM_BOT_TOKEN="YOUR_BOT_TOKEN" ASENIX_WATCHER_PUBLIC_URL="https://asenix-watcher.fly.dev" ASENIX_WATCHER_REPO="https://github.com/YOUR_USERNAME/asenix-watcher.git" --app asenix-watcher
fly deploy --app asenix-watcher
```

If the Fly app name is different, update `fly.toml` and
`ASENIX_WATCHER_PUBLIC_URL` to match the actual Fly URL.

## Local Machine Configuration

The Machine alerts installer writes a `.env` file for the local reporter. It can
also be configured manually with:

```text
ASENIX_WATCHER_SERVER=
ASENIX_WATCHER_TOKEN=
ASENIX_NODE_RPC_URL=http://127.0.0.1:8545
ASENIX_NODE_PROCESS_NAMES=asentum-validator,node
ASENIX_SYSTEMD_SERVICES=asentum-validator
ASENIX_DISK_PATHS=/
```

Only enable checks that match how the node is actually running. Asentum's VPS
and CLI docs describe `asentum-validator` running under systemd, so Linux
validator servers should normally use the service and local RPC checks. Desktop
Operator app users should normally rely on local RPC and process checks, because
the desktop app exposes logs through the app rather than a documented systemd
service.

## Probe Mode

Run a one-time public validator check:

```bash
npm run probe -- --address 0xValidatorWallet --window 128
```

JSON output:

```bash
npm run probe -- --address 0xValidatorWallet --json
```

## Security Model

Asenix Watcher is designed to be read-only.

- It does not store validator seeds, private keys, or recovery data.
- It does not run restart, stop, start, upgrade, or delete commands.
- It does not expose inbound access on the user's machine.
- It does not provide SSH or shell access.
- It only sends outbound health heartbeats to the configured watcher server.
- Telegram commands only return status information.
- Raw logs are not sent to Telegram by default.
