import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigAgent } from "@/config/agent"
import { ConfigAgentFile } from "@/config/agent-file"
import { tmpdir } from "../fixture/fixture"

const AGENT = `---
description: Reviews changes
mode: subagent
temperature: 0.2
permission:
  bash: deny
  edit:
    "src/**": allow
customKey: keep-me
---

Review the diff carefully.
`

async function seed(dir: string) {
  await Bun.write(path.join(dir, "agent", "reviewer.md"), AGENT)
  return dir
}

describe("ConfigAgentFile.list", () => {
  test("reads frontmatter, prompt, and unmodelled keys", async () => {
    await using tmp = await tmpdir({ init: seed })
    const [file] = await ConfigAgentFile.list([tmp.path])

    expect(file.name).toBe("reviewer")
    expect(file.scope).toBe("project")
    expect(file.prompt).toBe("Review the diff carefully.")
    expect(file.frontmatter.description).toBe("Reviews changes")
    expect(file.frontmatter.mode).toBe("subagent")
    expect(file.frontmatter.temperature).toBe(0.2)
    expect(file.frontmatter.permission).toEqual({ bash: "deny", edit: { "src/**": "allow" } })
    expect(file.extra).toEqual(["customKey"])
    expect(file.error).toBeUndefined()
  })

  test("reports unparseable frontmatter instead of throwing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "agent", "broken.md"), "---\ntemperature: not-a-number\n---\n\nbody\n")
        return dir
      },
    })
    const [file] = await ConfigAgentFile.list([tmp.path])

    expect(file.name).toBe("broken")
    expect(file.frontmatter).toEqual({})
    expect(file.error).toContain("unsupported frontmatter values")
  })
})

describe("ConfigAgentFile.write", () => {
  test("round-trips through the agent loader and preserves unmodelled keys", async () => {
    await using tmp = await tmpdir({ init: seed })
    const [before] = await ConfigAgentFile.list([tmp.path])

    await ConfigAgentFile.write([tmp.path], {
      path: before.path,
      frontmatter: {
        ...before.frontmatter,
        description: "Reviews changes carefully",
        temperature: undefined,
        permission: { bash: "allow", edit: { "src/**": "allow" } },
      },
      prompt: "Review the diff, then summarize it.",
    })

    const [after] = await ConfigAgentFile.list([tmp.path])
    expect(after.frontmatter.description).toBe("Reviews changes carefully")
    expect(after.frontmatter.temperature).toBeUndefined()
    expect(after.frontmatter.permission).toEqual({ bash: "allow", edit: { "src/**": "allow" } })
    expect(after.prompt).toBe("Review the diff, then summarize it.")
    expect(after.extra).toEqual(["customKey"])

    // The loader the runtime actually uses has to accept what the editor wrote.
    const loaded = await ConfigAgent.load(tmp.path)
    expect(loaded.reviewer.description).toBe("Reviews changes carefully")
    expect(loaded.reviewer.prompt).toBe("Review the diff, then summarize it.")
    expect(loaded.reviewer.permission).toEqual({ bash: "allow", edit: { "src/**": "allow" } })
  })

  test("keeps the original frontmatter key order so edits stay a small diff", async () => {
    await using tmp = await tmpdir({ init: seed })
    const [before] = await ConfigAgentFile.list([tmp.path])

    await ConfigAgentFile.write([tmp.path], {
      path: before.path,
      frontmatter: { ...before.frontmatter, description: "Reviews changes carefully", color: "primary" },
      prompt: before.prompt,
    })

    const written = await Bun.file(before.path).text()
    expect(written.match(/^[a-zA-Z_]+/gm)?.slice(0, 5)).toEqual([
      "description",
      "mode",
      "temperature",
      "permission",
      "customKey",
    ])
    // Newly set keys land after the ones the file already had.
    expect(written.indexOf("color:")).toBeGreaterThan(written.indexOf("customKey:"))
    expect(written).toContain("---\n\nReview the diff carefully.\n")
  })

  test("rejects paths outside the agent config directories", async () => {
    await using tmp = await tmpdir({ init: seed })

    expect(ConfigAgentFile.write([tmp.path], writeInput(path.join(tmp.path, "escaped.md")))).rejects.toThrow(
      "outside the agent config directories",
    )
    expect(ConfigAgentFile.write([tmp.path], writeInput(path.join(tmp.path, "agent", "notes.txt")))).rejects.toThrow(
      "not an agent markdown file",
    )
    expect(
      ConfigAgentFile.write([tmp.path], writeInput(path.join(tmp.path, "agent", "..", "..", "elsewhere.md"))),
    ).rejects.toThrow("outside the agent config directories")
  })
})

describe("ConfigAgentFile.create", () => {
  test("writes a loadable agent under the project config directory", async () => {
    await using tmp = await tmpdir({ init: seed })

    const created = await ConfigAgentFile.create(tmp.path, {
      name: "planner",
      scope: "project",
      frontmatter: { description: "Plans work", mode: "subagent", permission: { edit: "deny" } },
      prompt: "Plan before acting.",
    })

    expect(created).toBe(path.join(tmp.path, ".opencode", "agent", "planner.md"))
    const loaded = await ConfigAgent.load(path.join(tmp.path, ".opencode"))
    expect(loaded.planner.description).toBe("Plans work")
    expect(loaded.planner.prompt).toBe("Plan before acting.")
    expect(loaded.planner.permission).toEqual({ edit: "deny" })
  })

  test("supports nested names and refuses to overwrite", async () => {
    await using tmp = await tmpdir({ init: seed })
    const input = { name: "team/reviewer", scope: "project" as const, frontmatter: {}, prompt: "Review." }

    await ConfigAgentFile.create(tmp.path, input)
    const loaded = await ConfigAgent.load(path.join(tmp.path, ".opencode"))
    expect(Object.keys(loaded)).toContain("team/reviewer")

    expect(ConfigAgentFile.create(tmp.path, input)).rejects.toThrow("agent already exists")
  })

  test("rejects names that would escape the agent directory", async () => {
    await using tmp = await tmpdir({ init: seed })
    for (const name of ["../escaped", "..", "/absolute", "with space", "", "  "]) {
      expect(
        ConfigAgentFile.create(tmp.path, { name, scope: "project", frontmatter: {}, prompt: "x" }),
      ).rejects.toThrow(/invalid agent name|agent name is required/)
    }
  })
})

describe("ConfigAgentFile.remove", () => {
  test("deletes a file inside the config directories", async () => {
    await using tmp = await tmpdir({ init: seed })
    const [file] = await ConfigAgentFile.list([tmp.path])

    await ConfigAgentFile.remove([tmp.path], file.path)

    expect(await Bun.file(file.path).exists()).toBe(false)
    expect(await ConfigAgentFile.list([tmp.path])).toEqual([])
  })

  test("refuses paths outside the config directories and missing files", async () => {
    await using tmp = await tmpdir({ init: seed })

    expect(ConfigAgentFile.remove([tmp.path], path.join(tmp.path, "escaped.md"))).rejects.toThrow(
      "outside the agent config directories",
    )
    expect(ConfigAgentFile.remove([tmp.path], path.join(tmp.path, "agent", "ghost.md"))).rejects.toThrow(
      "agent file not found",
    )
  })
})

describe("ConfigAgentFile.revision", () => {
  test("changes when an agent file is written and is stable otherwise", async () => {
    await using tmp = await tmpdir({ init: seed })
    const before = await ConfigAgentFile.revision([tmp.path])
    expect(await ConfigAgentFile.revision([tmp.path])).toBe(before)

    await Bun.write(path.join(tmp.path, "agent", "reviewer.md"), `${AGENT}\nMore guidance.\n`)
    expect(await ConfigAgentFile.revision([tmp.path])).not.toBe(before)
  })

  test("changes when an agent file is added", async () => {
    await using tmp = await tmpdir({ init: seed })
    const before = await ConfigAgentFile.revision([tmp.path])

    await Bun.write(path.join(tmp.path, "agent", "second.md"), "---\nmode: all\n---\n\nHello.\n")
    expect(await ConfigAgentFile.revision([tmp.path])).not.toBe(before)
  })
})

function writeInput(target: string) {
  return { path: target, frontmatter: {}, prompt: "nope" }
}
