Shows a pill above the composer when a newer version of the agent's provider CLI is available. Click the pill to install the update on the daemon machine.

The daemon checks Claude Code, Codex and Oh My Pi once an hour:

| Provider | Installed version | Latest version | Update command |
| --- | --- | --- | --- |
| `claude` | `claude --version` | Claude Code release channel from `autoUpdatesChannel` (`latest` or `stable`) | `claude update` |
| `codex` | `codex --version` | npm `@openai/codex` | `codex update` |
| `omp` | `omp update --check` | `omp update --check` | `omp update` |

A provider that is not installed, or that the daemon cannot check, shows no pill. An update can run for 10 minutes.

## Pill states

| State | Menu |
| --- | --- |
| Update available | Update (applies when Paseo closes the idle session), or update and restart now. |
| Update installs | Disabled. If you chose "restart now", you can cancel that restart. |
| Session uses the old version | Restart now. |

An update never stops a session by itself. The session keeps the old binary until Paseo closes its idle runtime. Paseo does this after one hour idle, and only when the provider reports no background work. The next prompt then starts the new version. Agents with no open session show no restart pill.

"Restart now" reopens the same conversation with the new binary at once. If the agent was running a turn, the turn stops, and the plugin sends `Resume working.` so the agent continues.

## Known limits

- "Restart now" also stops background work inside the provider process, such as OMP async jobs or Claude Code background shells.
- If you set `agents.idleRuntimeCleanup` to `false`, Paseo never closes idle sessions. Use "restart now".
- Paseo reopens open sessions before their next prompt when this plugin loads or reloads, because the plugin records each session start.
- Only updates installed through the pill mark sessions as old. An update from a terminal does not.
- The plugin runs `claude`, `codex` and `omp` from the daemon `PATH`. A custom provider binary in Paseo settings is not checked.
