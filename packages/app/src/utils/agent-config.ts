import type { AgentFile, AgentFileCreate, AgentFileUpdate, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { queryOptions } from "@tanstack/solid-query"
import { pathKey } from "@/utils/path-key"
import type { ServerScope } from "@/utils/server-scope"
import type { ServerProtocol } from "@/utils/server-protocol"

const EMPTY_STATUS = { revision: "", loaded: "", stale: false }

// Agent files live behind the v1 instance routes, so the editor stays inert on v2-only servers.
const supported = async (protocol?: Promise<ServerProtocol>) => (await protocol) !== "v2"

export const agentFilesQuery = (
  scope: ServerScope,
  directory: string,
  sdk: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions({
    queryKey: [scope, pathKey(directory), "agentFiles"] as const,
    queryFn: async (): Promise<AgentFile[]> => {
      if (!(await supported(protocol))) return []
      return (await sdk.agentFile.list()).data ?? []
    },
  })

// Polled rather than pushed: agent markdown can change from an editor, from git, or from another
// opencode client, and none of those produce a server event the app already listens to.
export const AGENT_CONFIG_POLL_MS = 5_000

export const agentConfigStatusQuery = (
  scope: ServerScope,
  directory: string,
  sdk: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions({
    queryKey: [scope, pathKey(directory), "agentConfigStatus"] as const,
    queryFn: async () => {
      if (!(await supported(protocol))) return EMPTY_STATUS
      return (await sdk.agentFile.status()).data ?? EMPTY_STATUS
    },
    refetchInterval: AGENT_CONFIG_POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: EMPTY_STATUS,
  })

export const saveAgentFile = async (sdk: OpencodeClient, input: AgentFileUpdate) =>
  (await sdk.agentFile.update({ agentFileUpdate: input })).data

export const createAgentFile = async (sdk: OpencodeClient, input: AgentFileCreate) =>
  (await sdk.agentFile.create({ agentFileCreate: input })).data

export const deleteAgentFile = async (sdk: OpencodeClient, path: string) => {
  await sdk.agentFile.delete({ path })
}

// Disposes the instance server-side. The server then emits `server.instance.disposed`, which the
// directory event reducer turns into a bootstrap refresh of agents, commands, and config.
export const reloadInstance = async (sdk: OpencodeClient) => {
  await sdk.instance.reload()
}
