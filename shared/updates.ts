import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const providerUpdate = z.object({ provider: z.string(), current: z.string(), latest: z.string() });
export type ProviderUpdate = z.infer<typeof providerUpdate>;

const updatesState = z.object({
  /** Newer versions that are not installed. */
  updates: z.array(providerUpdate),
  /** Providers whose update command runs now. */
  installing: z.array(z.string()),
  /** Versions this plugin installed since the daemon started. */
  installed: z.array(z.object({ provider: z.string(), version: z.string() })),
  /** Agents whose open session started before its provider was updated. */
  stale: z.array(z.string()),
  /** Agents with "Restart now" that wait for the install in progress. */
  queued: z.array(z.string()),
});
export type UpdatesState = z.infer<typeof updatesState>;

/** Long poll: returns when the state revision differs from `revision`, or after about 20 s. */
export const watchState = defineRpc({
  name: "updates.watch",
  input: z.object({ revision: z.number() }),
  output: z.object({ revision: z.number(), state: updatesState }),
});

/** Long poll: call again while `done` is false. `restartAgentId` restarts that session when the install succeeds. */
export const installUpdate = defineRpc({
  name: "updates.install",
  input: z.object({ provider: z.string(), restartAgentId: z.string().optional() }),
  output: z.object({ done: z.boolean() }),
});

export const restartAgent = defineRpc({
  name: "updates.restart",
  input: z.object({ agentId: z.string(), mode: z.enum(["now", "cancel"]) }),
  output: z.object({}),
});
