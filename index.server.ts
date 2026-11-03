import type { PluginServerContext } from "@getpaseo/plugin/server";
import { checkAll, install, restart, sessionClosed, sessionOpened, useApi, watch } from "./server/updates";
import * as rpc from "./shared/updates";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export default function contribute(server: PluginServerContext) {
  // Records when each provider process starts. A session that started before an install runs the old binary.
  // Paseo reopens open sessions before their next prompt when a plugin with this hook loads.
  server.before("agent.session_open", ({ request }) => {
    if (request.purpose === "interactive") sessionOpened(request.agentId, request.provider);
  });
  // A closed runtime (idle collection, close, archive) starts the new binary on its next prompt.
  server.on("agent.closed", ({ agent }) => sessionClosed(agent.id));
  server.on("agent.archived", ({ agent }) => sessionClosed(agent.id));

  server.handle(rpc.watchState, ({ revision }, { paseo }) => {
    useApi(paseo);
    return watch(revision);
  });
  server.handle(rpc.installUpdate, async ({ provider, restartAgentId }, { paseo }) => ({
    done: await install(provider, restartAgentId, paseo),
  }));
  server.handle(rpc.restartAgent, async ({ agentId, mode }, { paseo }) => {
    await restart(agentId, mode, paseo);
    return {};
  });

  const timer = setInterval(() => void checkAll(), CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
