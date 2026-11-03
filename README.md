# Provider Updates

Show a pill above the Paseo composer when a newer version of the agent's provider CLI is available. Select the pill to install the update on the daemon machine.

<img alt="The omp update pill above the Paseo composer" src="assets/update-pill.png" width="900">

## Requirements

Paseo desktop and daemon 0.14.0 or later are required. The plugin has no runtime dependencies and no build step.

Enable the provider in Paseo. The plugin checks the executable that Paseo resolves for it, including a custom binary path.

## Install

```sh
paseo plugin add git:po-trottier/paseo-provider-updates
```

For development, install from a local clone:

```text
npm install
npm run typecheck
paseo plugin add .
```

After a source change, run `paseo plugin reload provider-updates`. Do not restart Paseo.

## Version checks

The plugin asks Paseo for every enabled and ready provider: built-in, ACP and custom. It does not use a fixed provider list. Checks start when the first Paseo client connects, then run once an hour.

For each provider, `paseo.providers.diagnostic()` gives the configured command and the resolved executable. The install method of that executable selects the version check and the update command:

| Install method | How the plugin finds it | Latest version | Update command |
| --- | --- | --- | --- |
| Global npm package | The executable, or the npm shim that starts it, is in `node_modules/<pkg>` under `npm root -g` | npm registry `latest` | `npm install -g <pkg>@latest` |
| Homebrew formula or cask | The executable is in `Cellar/<name>/<version>` or `Caskroom/<name>/<version>` | `brew info --json=v2 [--cask] <name>` | `brew upgrade [--cask] <name>` |
| Native Claude Code | Provider `claude`, not from npm or Homebrew | Release channel from `autoUpdatesChannel` in `~/.claude/settings.json` (`latest` or `stable`) | `<resolved executable> update` |
| Native OMP | Provider `omp`, not from npm or Homebrew | `<resolved executable> update --check` | `<resolved executable> update` |

Thus a new ACP agent that installs from npm works with no code change. The plugin validates npm and Homebrew names before it puts them in a command. It does not run the executable from `PATH`.

A provider that starts with `npx`, `bunx`, `pnpx` or `uvx` shows no pill. These runners download the package at launch.

Other install methods show no pill. Examples are a package in a project folder, a standalone binary with its own updater, `pipx`, and `bun` global installs. The plugin writes one log line for each such provider. Each check run also logs the providers it found and their update commands. Run `paseo plugin logs provider-updates` to see them.

An update can run for 10 minutes. A failed update shows the command output in a toast.

## Pill states

The pill shows on each agent whose provider has an update.

| State | Menu |
| --- | --- |
| Update available | **Update** (applies when Paseo closes the idle session), or **Update and restart now**. |
| Update installs | Disabled on every agent of that provider. If you selected "restart now", you can cancel that restart. |
| Session uses the old version | **Restart now**. |

## Restarts

An update never stops a session by itself. An open session keeps the old binary until Paseo closes its idle runtime. Paseo does this after one hour idle, and only when the provider reports no background work. The next prompt then starts the new version. Agents with no open session show no restart pill.

**Restart now** calls `reload()` on that one agent. Paseo reopens the same conversation with the new binary. If the agent was running a turn, the turn stops, and the plugin sends `Resume working.` so the agent continues. This is the default text that Paseo sends to agents it resumes after a daemon restart.

If you select **Update and restart now**, the restart waits for the install. If the install fails, the plugin drops the restart.

## How it works

- A `before("agent.session_open")` hook records when each interactive provider session starts. A session that started before an install runs the old binary.
- The `agent.closed` and `agent.archived` events clear that record, because the next open uses the binary on disk.
- After an install, the plugin calls `paseo.providers.refresh()` so new sessions read the new version.
- Paseo stops a plugin RPC after 30 seconds. The install and state RPCs are long polls that return within 20 seconds, and the client calls them again until the work is done.

All state is in daemon memory. A daemon restart starts every provider process again, so no session is old after it.

## Known limits

- **Restart now** also stops background work inside the provider process, such as OMP async jobs or Claude Code background shells.
- If `agents.idleRuntimeCleanup` is `false`, Paseo never closes idle sessions. Use **Restart now**.
- Paseo reopens open sessions before their next prompt when this plugin loads or reloads, because the plugin declares a session-open hook.
- Only updates installed through the pill mark sessions as old. An update from a terminal does not.
- Paseo 0.14 does not let a plugin read `agents.resumePrompt`, so the resume text is fixed.

## Development checks

```text
npm run typecheck
paseo plugin ls
paseo plugin logs provider-updates
```

Paseo contracts: [plugin reference](https://paseo.sh/docs/plugins/reference).
