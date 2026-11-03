import { exec, execFile, type ExecException } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { ProviderUpdate, UpdatesState } from "../shared/updates";

type Paseo = PluginHandlerContext["paseo"];

// Paseo rejects a plugin RPC after 30 s, so each long poll returns before that.
const POLL_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

async function run(
  command: readonly string[],
  timeout = POLL_WAIT_MS,
  env?: Record<string, string>,
  acceptExitOne = false,
): Promise<string> {
  const options = { timeout, windowsHide: true, env: { ...process.env, ...env }, encoding: "utf8" as const };
  try {
    let output;
    if (process.platform === "win32" && command[0] === "npm") {
      // npm.cmd needs a shell. Only these fixed argument shapes enter it.
      const root = command.length === 3 && command[1] === "root" && command[2] === "-g";
      const install = command.length === 4 && command[1] === "install" && command[2] === "-g" &&
        command[3].endsWith("@latest") && NPM_NAME.test(command[3].slice(0, -7));
      if (!root && !install) throw new Error("Invalid npm command");
      output = await execAsync(command.join(" "), options);
    } else output = await execFileAsync(command[0], command.slice(1), options);
    return output.stdout.trim() || output.stderr.trim();
  } catch (error) {
    const failure = error as ExecException & { stdout?: string; stderr?: string };
    if (acceptExitOne && failure.code === 1) return failure.stdout?.trim() || failure.stderr?.trim() || "";
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim();
    throw new Error(`${command.join(" ")} failed: ${output.slice(-500) || failure.message}`);
  }
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

type Updater = { label: string; check(): Promise<[string, string]>; update: readonly string[] };

const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const BREW_NAME = /^[\w@.+-]+$/;

// Runners that download the package at each launch. They need no update.
const LAUNCHERS = /^(npx|bunx|pnpx|uvx)(\.\w+)?$/i;

// Providers that update themselves when they are not installed by npm or Homebrew.
const NATIVE: Record<string, (exe: string) => Pick<Updater, "check" | "update">> = {
  claude: (exe) => ({
    check: async () => [version(await run([exe, "--version"])), await claudeLatest()],
    update: [exe, "update"],
  }),
  omp: (exe) => ({
    async check() {
      const out = await run([exe, "update", "--check"]);
      const current = version(/Current version:.*/.exec(out)?.[0] ?? out);
      const available = /New version available:.*/.exec(out)?.[0];
      return [current, available ? version(available) : current];
    },
    update: [exe, "update"],
  }),
};

let npmRoot: Promise<string> | undefined;

/** The global npm package that holds `path`, directly or through an npm shim. */
async function npmPackage(path: string): Promise<{ pkg: string; dir: string } | undefined> {
  const inside = /^(.*?[\\/]node_modules[\\/])((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(path);
  let found = inside && { pkg: inside[2], dir: inside[1] + inside[2] };
  if (!found && (await stat(path)).size < 64_000) {
    // npm shims on Windows (.cmd, .ps1, sh) name the package script relative to the shim folder.
    const shim = /node_modules[\\/]((?:@[^\\/"']+[\\/])?[^\\/"']+)[\\/]/.exec(await readFile(path, "utf8"));
    if (shim) found = { pkg: shim[1], dir: join(dirname(path), "node_modules", shim[1]) };
  }
  if (!found) return undefined;
  const pkg = found.pkg.replace("\\", "/");
  // A package in a project folder is not a global install, so `npm install -g` does not update it.
  npmRoot ??= run(["npm", "root", "-g"]).catch(() => "");
  const root = (await npmRoot).toLowerCase();
  if (!NPM_NAME.test(pkg) || !root || !join(found.dir).toLowerCase().startsWith(join(root).toLowerCase())) return undefined;
  return { pkg, dir: found.dir };
}

const field = (text: string, name: string) => new RegExp(`^\\s*${name}: (.+)$`, "m").exec(text)?.[1].trim();
const unknown = new Set<string>();

/** Finds how the provider was installed, from the command and binary that Paseo resolves. */
export async function classify(
  provider: string,
  command: string | undefined,
  resolved: string | undefined,
): Promise<Pick<Updater, "check" | "update"> | "launcher" | undefined> {
  if (command && LAUNCHERS.test(basename(command.trim().split(/\s+/)[0]))) return "launcher";
  if (!resolved) return undefined;
  const path = await realpath(resolved).catch(() => resolved);

  const npm = await npmPackage(path).catch(() => undefined);
  if (npm) {
    return {
      async check() {
        const manifest = JSON.parse(await readFile(join(npm.dir, "package.json"), "utf8"));
        return [version(z.object({ version: z.string() }).parse(manifest).version), await npmLatest(npm.pkg)];
      },
      update: ["npm", "install", "-g", `${npm.pkg}@latest`],
    };
  }

  const brew = /[\\/](Cellar|Caskroom)[\\/]([^\\/]+)[\\/]/.exec(path);
  if (brew && BREW_NAME.test(brew[2])) {
    const [, kind, name] = brew;
    const flag = kind === "Caskroom" ? ["--cask"] : [];
    return {
      async check() {
        // Read both versions from brew each time. The path that Paseo resolved still names the old version after an upgrade.
        const info = JSON.parse(await run(["brew", "info", "--json=v2", ...flag, name]));
        const [installed, latest] = kind === "Caskroom"
          ? [info.casks?.[0]?.installed, info.casks?.[0]?.version]
          : [info.formulae?.[0]?.linked_keg ?? info.formulae?.[0]?.installed?.at(-1)?.version, info.formulae?.[0]?.versions?.stable];
        return [version(String(installed)), version(String(latest))];
      },
      update: ["brew", "upgrade", ...flag, name],
    };
  }

  const native = NATIVE[provider];
  if (native) return native(path);
  if (!unknown.has(`${provider}:${path}`)) {
    unknown.add(`${provider}:${path}`);
    console.log(`[provider-updates] ${provider}: unknown install method (${path}), no update check`);
  }
  return undefined;
}

/** Every enabled and ready Paseo provider that this plugin can update. */
async function discover(paseo: Paseo): Promise<Map<string, Updater>> {
  const { entries } = await paseo.providers.waitForReady();
  const found = new Map<string, Updater>();
  await Promise.all(
    entries
      .filter((entry) => entry.enabled && entry.status === "ready")
      .map(async (entry) => {
        try {
          const { diagnostic } = await paseo.providers.diagnostic(entry.provider);
          const updater = await classify(entry.provider, field(diagnostic, "Configured command"), field(diagnostic, "Resolved path"));
          if (updater && updater !== "launcher") found.set(entry.provider, { label: entry.label ?? entry.provider, ...updater });
        } catch (error) {
          console.error(`[provider-updates] ${entry.provider} discovery failed:`, error);
        }
      }),
  );
  return found;
}

let updaters = new Map<string, Updater>();
let api: Paseo | undefined;

/** Plugin contribution has no SDK handle, so checks start with the first client RPC. */
export function useApi(paseo: Paseo): void {
  const first = !api;
  api = paseo;
  if (first) void checkAll();
}

/** Paseo provider ids can carry a model, such as "codex/gpt-5.5". */
export const providerId = (provider: string) => provider.split("/")[0];

// All state is in memory. A daemon restart starts every provider process again, so nothing is stale after it.
const available = new Map<string, ProviderUpdate>();
const installs = new Map<string, Promise<void>>();
const installed = new Map<string, { label: string; version: string; at: number }>();
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
    installed: [...installed].map(([provider, { label, version }]) => ({ provider, label, version })),
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
  const updater = updaters.get(provider);
  try {
    if (!updater) throw new Error("not discovered");
    const [current, latest] = await updater.check();
    if (isNewer(latest, current)) available.set(provider, { provider, label: updater.label, current, latest });
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
  if (!api) return;
  updaters = await discover(api);
  console.log(`[provider-updates] checking: ${[...updaters].map(([id, u]) => `${id} (${u.update.join(" ")})`).join(", ") || "none"}`);
  for (const provider of available.keys()) if (!updaters.has(provider)) available.delete(provider);
  changed();
  await Promise.all([...updaters.keys()].map(checkOne));
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
  const entry = updaters.get(provider);
  if (!entry) throw new Error(`No updater for provider "${provider}"`);
  const command = entry.update.join(" ");
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
      if (left) throw new Error(`${command} finished, but ${provider} still reports ${left.current}`);
      if (!current) throw new Error(`${command} finished, but the ${provider} version check failed`);
      installed.set(provider, { label: entry.label, version: current, at: Date.now() });
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
