import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { installUpdate, restartAgent, type UpdatesState, watchState } from "./shared/updates";

type Agent = { workspaceId: string; provider: string; running: boolean };
type Pill = { key: string; button: PluginButton };

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const agents = new Map<string, Agent>();
  const pills = new Map<string, { registration: PluginButtonRegistration; key: string }>();
  let state: UpdatesState = { updates: [], installing: [], installed: [], stale: [], queued: [] };

  const install = (provider: string, restartAgentId?: string) => async () => {
    // Each call waits at most 20 s. Paseo keeps the pill busy until the loop ends.
    // Only the first call asks for a restart, so a cancel made during the install stays cancelled.
    let input: { provider: string; restartAgentId?: string } = { provider, restartAgentId };
    while (!(await client.rpc(installUpdate, input)).done) input = { provider };
  };
  const restart = (agentId: string, mode: "now" | "cancel") => async () => {
    await client.rpc(restartAgent, { agentId, mode });
  };
  const item = (id: string, title: string, icon: string, onPress: () => void | Promise<void>, disabled = false) =>
    ({ kind: "item", id, title, icon, disabled, behavior: { kind: "action", onPress } }) satisfies PluginButtonMenuEntry;
  // Only an explicit "now" item calls reload(). Without it, the session keeps the old binary
  // until Paseo closes the idle runtime after its safety checks.
  const whenSafe = "Applies when Paseo closes the idle session";
  const restartNowTitle = (running: boolean) => (running ? "Restart now (stops this turn)" : "Restart now");

  /** The pill for one agent, or null. `key` changes only when the pill must change. */
  function describe(agentId: string, { provider: p, running }: Agent): Pill | null {
    const update = state.updates.find((u) => u.provider === p);
    const queued = state.queued.includes(agentId);
    const installed = state.installed.find((i) => i.provider === p);

    if (update && state.installing.includes(p)) {
      return {
        key: `installing ${update.latest} ${queued}`,
        button: {
          title: queued ? `Installing ${p} ${update.latest}, then restarting this session` : `Installing ${p} ${update.latest}`,
          icon: "Loader",
          label: `Updating ${p}…`,
          disabled: !queued,
          behavior: queued
            ? { kind: "menu", items: [item("cancel", "Cancel the restart", "X", restart(agentId, "cancel"))] }
            : { kind: "action", onPress() {} },
        },
      };
    }
    if (installed && state.stale.includes(agentId)) {
      return {
        key: `stale ${installed.version} ${running}`,
        button: {
          title: `This session uses the old ${p}. Restart it to use ${installed.version}.`,
          icon: "RotateCw",
          label: `Restart for ${p} ${installed.version}`,
          behavior: {
            kind: "menu",
            items: [
              item("restart-now", restartNowTitle(running), "RotateCw", restart(agentId, "now")),
              item("when-safe", whenSafe, "Clock", () => {}, true),
            ],
          },
        },
      };
    }
    if (update) {
      return {
        key: `update ${update.latest} ${running}`,
        button: {
          title: `Update ${p} ${update.current} → ${update.latest}`,
          icon: "Download",
          label: `${p} ${update.latest} available`,
          behavior: {
            kind: "menu",
            items: [
              item("update", `Update (${whenSafe.toLowerCase()})`, "Download", install(p)),
              item("update-now", `Update and ${restartNowTitle(running).toLowerCase()}`, "RotateCw", install(p, agentId)),
            ],
          },
        },
      };
    }
    return null;
  }

  function sync() {
    if (lifetime.signal.aborted) return;
    for (const [agentId, pill] of pills) {
      if (agents.has(agentId)) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, agent] of agents) {
      const next = describe(agentId, agent);
      const pill = pills.get(agentId);
      if (!next) {
        pill?.registration.remove();
        pills.delete(agentId);
      } else if (!pill) {
        const registration = client.addComposerPill({
          id: "provider-update",
          workspaceId: agent.workspaceId,
          agentId,
          button: next.button,
        });
        pills.set(agentId, { registration, key: next.key });
      } else if (pill.key !== next.key) {
        // An update closes an open menu, so only send real changes.
        pill.registration.update(next.button);
        pill.key = next.key;
      }
    }
  }

  const track = (agent: { id: string; workspaceId?: string | null; provider: string; status: string }) => {
    if (!agent.workspaceId) return;
    agents.set(agent.id, {
      workspaceId: agent.workspaceId,
      provider: agent.provider.split("/")[0],
      running: agent.status === "running",
    });
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          agents.clear();
          for (const { agent } of entries) track(agent);
          sync();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") track(update.agent);
          else agents.delete(update.agentId);
          sync();
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[provider-updates] agent observation failed", error);
    });

  void (async () => {
    let revision = 0;
    while (!lifetime.signal.aborted) {
      try {
        const result = await client.rpc(watchState, { revision });
        revision = result.revision;
        state = result.state;
        sync();
      } catch (error) {
        if (lifetime.signal.aborted) return;
        console.error("[provider-updates] state poll failed", error);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  })();

  return () => {
    lifetime.abort();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
