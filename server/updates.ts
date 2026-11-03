import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { ProviderUpdate, UpdatesState } from "../shared/updates";

type Paseo = PluginHandlerContext["paseo"];

// Paseo rejects a plugin RPC after 30 s, so each long poll returns before that.
const POLL_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function run(command: string, timeout = POLL_WAIT_MS): Promise<string> {
  // Constant commands only. The shell resolves npm shims such as codex.cmd on Windows.
  // The lib target is ES2023, so Promise.withResolvers is not typed here.
  return new Promise((resolve, reject) => {
    exec(command, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (error) reject(new Error(`${command} failed: ${output.slice(-500) || error.message}`));
      else resolve(output);
    });
  });
}

function version(text: string): string {
  const match = /\d+\.\d+\.\d+/.exec(text);
  if (!match) throw new Error(`No version in: ${text.trim()}`);
  return match[0];
}

function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(POLL_WAIT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function npmLatest(pkg: string): Promise<string> {
  const body: unknown = JSON.parse(await fetchText(`https://registry.npmjs.org/${pkg}/latest`));
  return z.object({ version: z.string() }).parse(body).version;
}

// The bucket that the Claude Code native installer and `claude update` read.
const CLAUDE_RELEASES =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

async function claudeLatest(): Promise<string> {
  const settings = await readFile(join(homedir(), ".claude", "settings.json"), "utf8").catch(() => "");
  const channel = /"autoUpdatesChannel"\s*:\s*"stable"/.test(settings) ? "stable" : "latest";
  return version(await fetchText(`${CLAUDE_RELEASES}/${channel}`));
}

// Each entry reads the installed and the latest version, and names the provider's own update command.
const PROVIDERS: Record<string, { check(): Promise<[string, string]>; update: string }> = {
  claude: {
    check: async () => [version(await run("claude --version")), await claudeLatest()],
    update: "claude update",
  },
  codex: {
    check: async () => [version(await run("codex --version")), await npmLatest("@openai/codex")],
    update: "codex update",
  },
  omp: {
    async check() {
      const out = await run("omp update --check");
      const current = version(/Current version:.*/.exec(out)?.[0] ?? out);
      const available = /New version available:.*/.exec(out)?.[0];
      return [current, available ? version(available) : current];
    },
    update: "omp update",
  },
};

/** Paseo provider ids can carry a model, such as "codex/gpt-5.5". */
export const providerId = (provider: string) => provider.split("/")[0];

// All state is in memory. A daemon restart starts every provider process again, so nothing is stale after it.
const available = new Map<string, ProviderUpdate>();
const installs = new Map<string, Promise<void>>();
const installed = new Map<string, { version: string; at: number }>();
const sessions = new Map<string, { provider: string; openedAt: number }>();
// "Restart now" chosen while the provider installs. reload() runs when the install succeeds.
const restartAfterInstall = new Set<string>();
const restarting = new Set<string>();

let revision = 1;
const waiters = new Set<() => void>();
function changed() {
  revision++;
  for (const wake of waiters) wake();
  waiters.clear();
}

function isStale(agentId: string): boolean {
  const session = sessions.get(agentId);
  const update = session && installed.get(session.provider);
  return !!update && session.openedAt < update.at;
}

function snapshot(): UpdatesState {
  return {
    updates: [...available.values()],
    installing: [...installs.keys()],
    installed: [...installed].map(([provider, { version }]) => ({ provider, version })),
    stale: [...sessions.keys()].filter((id) => isStale(id) && !restarting.has(id)),
    queued: [...restartAfterInstall],
  };
}

export async function watch(since: number): Promise<{ revision: number; state: UpdatesState }> {
  if (since === revision) {
    let wake = () => {};
    const woken = new Promise<void>((resolve) => (wake = resolve));
    waiters.add(wake);
    await Promise.race([woken, sleep(POLL_WAIT_MS)]);
    waiters.delete(wake);
  }
  return { revision, state: snapshot() };
}

async function checkOne(provider: string): Promise<string | undefined> {
  try {
    const [current, latest] = await PROVIDERS[provider].check();
    if (isNewer(latest, current)) available.set(provider, { provider, current, latest });
    else available.delete(provider);
    return current;
  } catch (error) {
    // A provider that is not installed or not reachable shows no pill.
    available.delete(provider);
    console.error(`[provider-updates] ${provider} check failed:`, error);
    return undefined;
  } finally {
    changed();
  }
}

export async function checkAll(): Promise<void> {
  await Promise.all(Object.keys(PROVIDERS).map(checkOne));
}

export function sessionOpened(agentId: string, provider: string): void {
  sessions.set(agentId, { provider: providerId(provider), openedAt: Date.now() });
  changed();
}

/** The runtime is gone, so the next open uses the binary on disk. */
export function sessionClosed(agentId: string): void {
  sessions.delete(agentId);
  restartAfterInstall.delete(agentId);
  changed();
}

/**
 * Explicit user action only. reload() stops a running turn and any background work in the provider process.
 * A session the user does not restart keeps the old binary until Paseo closes the idle runtime. That close
 * runs the provider safety checks, and agent.closed then clears the stale mark.
 */
async function forceRestart(agentId: string, paseo: Paseo): Promise<void> {
  restartAfterInstall.delete(agentId);
  if (restarting.has(agentId) || !isStale(agentId)) {
    changed();
    return;
  }
  restarting.add(agentId);
  changed();
  try {
    const agent = paseo.agents.ref(agentId);
    // ponytail: status is read before reload(); a turn that starts in between is stopped and not resumed.
    const wasRunning = (await agent.refresh())?.agent.status === "running";
    // The session_open hook records the new openedAt.
    await agent.reload();
    // Same text Paseo sends to agents it resumes after a daemon restart (default agents.resumePrompt).
    if (wasRunning) await agent.send("Resume working.");
  } catch (error) {
    console.error(`[provider-updates] restart of ${agentId} failed:`, error);
  } finally {
    restarting.delete(agentId);
    changed();
  }
}

/** Starts the update, or joins the one in progress. Returns false while it still runs. */
export async function install(provider: string, restartAgentId: string | undefined, paseo: Paseo): Promise<boolean> {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`No updater for provider "${provider}"`);
  if (restartAgentId) {
    restartAfterInstall.add(restartAgentId);
    changed();
  }
  let job = installs.get(provider);
  if (!job) {
    job = (async () => {
      console.log(await run(entry.update, 10 * 60_000));
      const current = await checkOne(provider);
      const left = available.get(provider);
      if (left) throw new Error(`${entry.update} finished, but ${provider} still reports ${left.current}`);
      if (!current) throw new Error(`${entry.update} finished, but the ${provider} version check failed`);
      installed.set(provider, { version: current, at: Date.now() });
      // Paseo reads the new version for new sessions.
      await paseo.providers.refresh();
    })();
    installs.set(provider, job);
    changed();
    // An agent with no tracked session is included so it leaves the set. forceRestart drops it.
    const waiting = () => [...restartAfterInstall].filter((id) => (sessions.get(id)?.provider ?? provider) === provider);
    job
      .finally(() => {
        installs.delete(provider);
        changed();
      })
      .then(
        () => {
          for (const id of waiting()) void forceRestart(id, paseo);
        },
        () => {
          // Nothing to apply: drop the restarts that waited for this install.
          for (const id of waiting()) restartAfterInstall.delete(id);
          changed();
        },
      );
  }
  return Promise.race([job.then(() => true), sleep(POLL_WAIT_MS).then(() => false)]);
}

/** "now" restarts at once, or after the install in progress. "cancel" drops a restart that waits for an install. */
export async function restart(agentId: string, mode: "now" | "cancel", paseo: Paseo): Promise<void> {
  const session = sessions.get(agentId);
  if (mode === "cancel") restartAfterInstall.delete(agentId);
  else if (session && installs.has(session.provider)) restartAfterInstall.add(agentId);
  else return Promise.race([forceRestart(agentId, paseo), sleep(POLL_WAIT_MS)]);
  changed();
}
