import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { ConfigAgentFile } from "@/config/agent-file"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import path from "path"
import { InstanceHttpApi } from "../api"
import { ApiAgentFileError, ApiVcsApplyError } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

const agentFileError = (error: unknown) =>
  new ApiAgentFileError({
    name: "AgentFileError",
    data: { message: error instanceof Error ? error.message : String(error) },
  })

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    // Reload reuses disposal: dropping the instance makes the next request rebuild config, agents,
    // commands, and skills from disk without restarting the server.
    const reload = Effect.fn("InstanceHttpApi.reload")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getAgentFile = Effect.fn("InstanceHttpApi.agentFile")(function* () {
      const directories = yield* config.directories()
      return yield* Effect.promise(() => ConfigAgentFile.list(directories))
    })

    const updateAgentFile = Effect.fn("InstanceHttpApi.agentFileUpdate")(function* (ctx: {
      payload: ConfigAgentFile.Update
    }) {
      const directories = yield* config.directories()
      const written = yield* Effect.tryPromise({
        try: () => ConfigAgentFile.write(directories, ctx.payload),
        catch: agentFileError,
      })
      // The instance still holds the pre-write agent config, so drop it and let the next request reload.
      yield* markInstanceForDisposal(yield* InstanceState.context)
      const listed = yield* Effect.promise(() => ConfigAgentFile.list(directories))
      const info = listed.find((item) => item.path === written)
      if (!info) return yield* Effect.fail(agentFileError(new Error(`agent file not found: ${written}`)))
      return info
    })

    const createAgentFile = Effect.fn("InstanceHttpApi.agentFileCreate")(function* (ctx: {
      payload: ConfigAgentFile.Create
    }) {
      const instance = yield* InstanceState.context
      const created = yield* Effect.tryPromise({
        try: () => ConfigAgentFile.create(instance.worktree, ctx.payload),
        catch: agentFileError,
      })
      // The new file changes which directories and agents the instance resolves, so drop it.
      yield* markInstanceForDisposal(instance)
      // Created files can sit in a directory the current instance never scanned, so read the file
      // directly rather than filtering the list the stale directory set would produce.
      const listed = yield* Effect.promise(() => ConfigAgentFile.list([path.dirname(path.dirname(created))]))
      const info = listed.find((item) => item.path === created)
      if (!info) return yield* Effect.fail(agentFileError(new Error(`agent file not found: ${created}`)))
      return info
    })

    const deleteAgentFile = Effect.fn("InstanceHttpApi.agentFileDelete")(function* (ctx: { query: { path: string } }) {
      const directories = yield* config.directories()
      yield* Effect.tryPromise({
        try: () => ConfigAgentFile.remove(directories, ctx.query.path),
        catch: agentFileError,
      })
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getAgentFileStatus = Effect.fn("InstanceHttpApi.agentFileStatus")(function* () {
      const [directories, loaded] = yield* Effect.all([config.directories(), config.agentRevision()])
      const revision = yield* Effect.promise(() => ConfigAgentFile.revision(directories))
      return { revision, loaded, stale: revision !== loaded }
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("reload", reload)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("agentFile", getAgentFile)
      .handle("agentFileUpdate", updateAgentFile)
      .handle("agentFileCreate", createAgentFile)
      .handle("agentFileDelete", deleteAgentFile)
      .handle("agentFileStatus", getAgentFileStatus)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
