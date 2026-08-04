import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import path from "path"
import type { ConfigAgentFile } from "@/config/agent-file"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const it = testEffect(Layer.mergeAll(testStateLayer, NodeServices.layer))
const handlerContext = Context.empty() as Context.Context<unknown>

// Goes through the same web handler production serves, which is where disposeMiddleware — and so the
// instance reload this feature depends on — is installed.
const request = (dir: string, route: string, init?: RequestInit) =>
  Effect.promise(() =>
    HttpApiApp.webHandler().handler(
      new Request(`http://localhost${route}`, {
        ...init,
        headers: { "x-opencode-directory": dir, "content-type": "application/json", ...init?.headers },
      }),
      handlerContext,
    ),
  )

const json = <T>(dir: string, route: string, init?: RequestInit) =>
  request(dir, route, init).pipe(Effect.flatMap((response) => Effect.promise((): Promise<T> => response.json())))

const AGENT = `---
description: Reviews changes
mode: subagent
---

Review the diff.
`

const seed = (dir: string) =>
  Effect.promise(() => Bun.write(path.join(dir, ".opencode", "agent", "reviewer.md"), AGENT))

const listAgentFiles = (dir: string) => json<ConfigAgentFile.Info[]>(dir, InstancePaths.agentFile)

const agentFileStatus = (dir: string) =>
  json<{ revision: string; loaded: string; stale: boolean }>(dir, InstancePaths.agentFileStatus)

const listAgents = (dir: string) =>
  json<{ name: string; description?: string; prompt?: string }[]>(dir, InstancePaths.agent)

describe("agent file HttpApi", () => {
  it.live("lists the project agent files", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* seed(dir)

      const reviewer = (yield* listAgentFiles(dir)).find((file) => file.name === "reviewer")

      expect(reviewer).toBeDefined()
      expect(reviewer?.scope).toBe("project")
      expect(reviewer?.frontmatter.description).toBe("Reviews changes")
      expect(reviewer?.prompt).toBe("Review the diff.")
    }),
  )

  it.live("applies an update to the agents the instance serves", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* seed(dir)

      expect((yield* listAgents(dir)).find((agent) => agent.name === "reviewer")?.description).toBe("Reviews changes")

      const target = (yield* listAgentFiles(dir)).find((file) => file.name === "reviewer")!
      const update = yield* request(dir, InstancePaths.agentFile, {
        method: "PUT",
        body: JSON.stringify({
          path: target.path,
          frontmatter: { ...target.frontmatter, description: "Reviews changes closely" },
          prompt: "Review the diff, then summarize it.",
        }),
      })
      expect(update.status).toBe(200)

      const after = (yield* listAgents(dir)).find((agent) => agent.name === "reviewer")
      expect(after?.description).toBe("Reviews changes closely")
      expect(after?.prompt).toBe("Review the diff, then summarize it.")
    }),
  )

  it.live("rejects writes outside the agent config directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* seed(dir)

      const response = yield* request(dir, InstancePaths.agentFile, {
        method: "PUT",
        body: JSON.stringify({ path: path.join(dir, "escaped.md"), frontmatter: {}, prompt: "nope" }),
      })

      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ name: "AgentFileError" })
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "escaped.md")).exists())).toBe(false)
    }),
  )

  it.live("creates an agent the instance then serves, and refuses duplicates", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* seed(dir)

      const created = yield* json<{ name: string; path: string; scope: string }>(dir, InstancePaths.agentFile, {
        method: "POST",
        body: JSON.stringify({
          name: "planner",
          scope: "project",
          frontmatter: { description: "Plans work", mode: "subagent" },
          prompt: "Plan before acting.",
        }),
      })
      expect(created.name).toBe("planner")
      expect(created.scope).toBe("project")
      expect(created.path).toBe(path.join(dir, ".opencode", "agent", "planner.md"))

      expect((yield* listAgents(dir)).find((agent) => agent.name === "planner")?.description).toBe("Plans work")

      const duplicate = yield* request(dir, InstancePaths.agentFile, {
        method: "POST",
        body: JSON.stringify({ name: "planner", scope: "project", frontmatter: {}, prompt: "again" }),
      })
      expect(duplicate.status).toBe(400)
      expect(yield* Effect.promise(() => duplicate.json())).toMatchObject({ name: "AgentFileError" })
    }),
  )

  it.live("rejects agent names that would escape the agent directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* seed(dir)

      const response = yield* request(dir, InstancePaths.agentFile, {
        method: "POST",
        body: JSON.stringify({ name: "../escaped", scope: "project", frontmatter: {}, prompt: "x" }),
      })

      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "escaped.md")).exists())).toBe(false)
    }),
  )

  it.live("deletes an agent and drops it from the served list", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* seed(dir)
      const target = (yield* listAgentFiles(dir)).find((file) => file.name === "reviewer")!

      const response = yield* request(dir, `${InstancePaths.agentFile}?path=${encodeURIComponent(target.path)}`, {
        method: "DELETE",
      })

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => Bun.file(target.path).exists())).toBe(false)
      expect((yield* listAgentFiles(dir)).find((file) => file.name === "reviewer")).toBeUndefined()
      expect((yield* listAgents(dir)).find((agent) => agent.name === "reviewer")).toBeUndefined()
    }),
  )

  it.live("refuses to delete outside the agent config directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* seed(dir)
      const outside = path.join(dir, "keep.md")
      yield* Effect.promise(() => Bun.write(outside, "keep me"))

      const response = yield* request(dir, `${InstancePaths.agentFile}?path=${encodeURIComponent(outside)}`, {
        method: "DELETE",
      })

      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => Bun.file(outside).exists())).toBe(true)
    }),
  )

  it.live("reports staleness when an agent file changes on disk, and clears it after a reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* seed(dir)

      expect((yield* agentFileStatus(dir)).stale).toBe(false)

      yield* Effect.promise(() =>
        Bun.write(path.join(dir, ".opencode", "agent", "reviewer.md"), `${AGENT}\nAlso check the tests.\n`),
      )
      const stale = yield* agentFileStatus(dir)
      expect(stale.stale).toBe(true)
      expect(stale.revision).not.toBe(stale.loaded)

      const reload = yield* request(dir, InstancePaths.reload, { method: "POST" })
      expect(reload.status).toBe(200)

      expect((yield* agentFileStatus(dir)).stale).toBe(false)
      expect((yield* listAgents(dir)).find((item) => item.name === "reviewer")?.prompt).toContain(
        "Also check the tests.",
      )
    }),
  )
})
