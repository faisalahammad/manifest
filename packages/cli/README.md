# TierGate CLI

`mnfst` manages a TierGate gateway from your terminal. Use it to create agents, connect AI providers, configure model routing, and inspect requests. The dashboard calls agents **Harnesses**; CLI commands use `agent`.

The npm package is `mnfst-gateway-cli`. The command it installs is `mnfst`. Node.js 20 or later is required.

## Install

```bash
npm install -g mnfst-gateway-cli
mnfst --help
```

To run it without a global install:

```bash
npx mnfst-gateway-cli --help
```

## Quick start

Sign in to your TierGate server with `mnfst login --url https://your-host`, then create an agent and connect a provider:

```bash
mnfst login
mnfst agent create --name my-app --platform openai-sdk
mnfst provider connect openai --agent my-app --credential-env OPENAI_API_KEY
mnfst models my-app --provider openai
mnfst agent configure my-app --models gpt-4o-mini --provider openai
mnfst routing status my-app
mnfst agent setup my-app
```

Set `OPENAI_API_KEY` in your environment before connecting the provider. Choose a model shown by `mnfst models` if `gpt-4o-mini` is unavailable to your account. `mnfst agent setup` returns wiring instructions with the agent key masked.

For a self-hosted gateway, pass its URL when you sign in:

```bash
mnfst login --url https://gateway.example.com
```

The CLI uses that gateway for later commands. You can select another gateway with `--url` or `MANIFEST_URL`.

## Useful commands

| Task                           | Command                                             |
| ------------------------------ | --------------------------------------------------- |
| Check your connection          | `mnfst doctor`                                      |
| List available agent platforms | `mnfst agent platforms`                             |
| List connectable providers     | `mnfst provider catalog`                            |
| Review an agent's routing      | `mnfst routing status my-app`                       |
| Read or set model params       | `mnfst routing params get my-app`                   |
| See which provider key serves  | `mnfst agent provider keys my-app openai`           |
| Restart key rotation           | `mnfst agent provider reset-rotation my-app openai` |
| Read recent requests           | `mnfst requests get --agent my-app --range 7d`      |
| See all commands and options   | `mnfst --help`                                      |

Most commands write JSON to stdout for scripts and coding agents. `mnfst agent env` and `mnfst skill show` write text. `mnfst routing test` sends a real provider request, which may incur provider charges. Destructive commands require `--yes`.

## Credentials

Browser login is the default. For a script, provide a management credential through standard input or an environment variable:

```bash
printf '%s' "$MY_KEY" | mnfst login --token-stdin
# or
mnfst login --token-env MY_KEY
```

The CLI stores login credentials for each gateway host in `~/.config/manifest/config.json` with file mode `0600`. A stored credential is only sent to the host where it was saved. `MANIFEST_API_KEY` overrides the stored credential for the selected host.

Agent keys are separate from management credentials. The CLI stores a newly created agent key in its local keystore and does not print it in `mnfst agent setup` unless you pass `--reveal`. Use `mnfst agent env my-app` to get the key and URL for your application; its output contains the key, so handle it as a secret.

## Usage telemetry

This section describes the CLI built from this repository. The `mnfst-gateway-cli` package on npm is published by Manifest, the upstream project, and keeps its defaults: it signs in to Manifest Cloud unless you pass `--url` or set `MANIFEST_URL`, and it sends usage telemetry to Manifest unless you set `MANIFEST_TELEMETRY_DISABLED=1`.

The CLI records and sends nothing unless you set `MANIFEST_CLI_TELEMETRY_ENDPOINT` to your own collector. With it set, events are batched locally and normally sent once per install per day. The payload contains a random, persistent install ID; CLI version; operating system; Cloud or self-hosted target; and each command's name, result, duration, and minute-level time. It may include the detected coding-agent runtime. It does not include command arguments, agent or provider names, gateway URLs, prompts, or credentials.

`MANIFEST_TELEMETRY_DISABLED=1` turns it off again. Telemetry files are stored beside the CLI config.

## Documentation

See the [CLI documentation](https://github.com/faisalahammad/tiergate/blob/main/packages/cli/README.md) for more examples and the [GitHub repository](https://github.com/faisalahammad/tiergate) for source and issues.
