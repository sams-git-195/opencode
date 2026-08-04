export * as ConfigAgentFile from "./agent-file"

import path from "path"
import { unlink } from "fs/promises"
import { createHash } from "crypto"
import matter from "gray-matter"
import { Exit, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Filesystem } from "@/util/filesystem"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"

const PATTERN = "{agent,agents}/**/*.md"
const PREFIXES = ["agent/", "agents/"]

export const Scope = Schema.Literals(["project", "global"]).annotate({ identifier: "AgentFileScope" })

// Only the frontmatter keys the editor understands. Any other key present in the file is preserved
// verbatim on write, so hand-authored fields never get dropped by a round trip through the UI.
export const Frontmatter = Schema.Struct({
  description: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  steps: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
  disable: Schema.optional(Schema.Boolean),
  permission: Schema.optional(Schema.Record(Schema.String, ConfigPermissionV1.Rule)),
}).annotate({ identifier: "AgentFileFrontmatter" })
export type Frontmatter = Schema.Schema.Type<typeof Frontmatter>

export const Info = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  directory: Schema.String,
  scope: Scope,
  frontmatter: Frontmatter,
  prompt: Schema.String,
  // Frontmatter keys the editor does not model, so the UI can say they are only editable in the file.
  extra: Schema.Array(Schema.String),
  // Set when the file could not be parsed or its frontmatter failed validation; the UI shows it read-only.
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "AgentFile" })
export type Info = Schema.Schema.Type<typeof Info>

export const Update = Schema.Struct({
  path: Schema.String,
  frontmatter: Frontmatter,
  prompt: Schema.String,
}).annotate({ identifier: "AgentFileUpdate" })
export type Update = Schema.Schema.Type<typeof Update>

export const Create = Schema.Struct({
  name: Schema.String,
  scope: Scope,
  frontmatter: Frontmatter,
  prompt: Schema.String,
}).annotate({ identifier: "AgentFileCreate" })
export type Create = Schema.Schema.Type<typeof Create>

export const Status = Schema.Struct({
  revision: Schema.String,
  loaded: Schema.String,
  stale: Schema.Boolean,
}).annotate({ identifier: "AgentFileStatus" })

const KNOWN = new Set(Object.keys(Frontmatter.fields))
const decodeFrontmatter = Schema.decodeUnknownExit(Frontmatter)

export async function list(dirs: string[]) {
  const result: Info[] = []
  for (const dir of dirs) {
    for (const file of await scan(dir)) {
      result.push(await read(dir, file))
    }
  }
  return result
}

export async function write(dirs: string[], input: Update) {
  const file = resolveWithin(dirs, input.path)
  const existing = ((await ConfigMarkdown.parse(file).catch(() => undefined))?.data ?? {}) as Record<string, unknown>
  const next = Object.fromEntries(Object.entries(input.frontmatter).filter(([, value]) => value !== undefined))
  // Rewrite in the file's original key order so an edit produces a minimal diff. Keys the editor does
  // not model pass through untouched; known keys the editor cleared are dropped.
  const kept = Object.keys(existing).flatMap((key) => {
    if (!KNOWN.has(key)) return [[key, existing[key]] as const]
    return key in next ? [[key, next[key]] as const] : []
  })
  const added = Object.entries(next).filter(([key]) => !(key in existing))
  await Filesystem.write(file, matter.stringify(`\n${input.prompt.trim()}\n`, Object.fromEntries([...kept, ...added])))
  return file
}

export async function create(worktree: string, input: Create) {
  const name = agentName(input.name)
  const dir = input.scope === "global" ? Global.Path.config : path.join(worktree, ".opencode")
  const file = path.join(dir, "agent", `${name}.md`)
  if (await Filesystem.exists(file)) throw new Error(`agent already exists: ${file}`)
  const frontmatter = Object.fromEntries(Object.entries(input.frontmatter).filter(([, value]) => value !== undefined))
  await Filesystem.write(file, matter.stringify(`\n${input.prompt.trim()}\n`, frontmatter))
  return file
}

export async function remove(dirs: string[], target: string) {
  const file = resolveWithin(dirs, target)
  if (!(await Filesystem.exists(file))) throw new Error(`agent file not found: ${file}`)
  await unlink(file)
  return file
}

// Identifies the on-disk state of every agent markdown file the instance would load. A revision that
// differs from the one captured at load time means the running instance is serving stale agent config.
export async function revision(dirs: string[]) {
  const files = (await Promise.all(dirs.map(scan))).flat().sort()
  const parts = await Promise.all(
    files.map(async (file) => {
      const stat = await Filesystem.statAsync(file)
      return `${file}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`
    }),
  )
  return createHash("sha1").update(parts.join("\n")).digest("hex")
}

async function read(dir: string, file: string): Promise<Info> {
  const base = {
    name: configEntryNameFromPath(path.relative(dir, file), PREFIXES),
    path: file,
    directory: dir,
    scope: dir.startsWith(Global.Path.config) ? ("global" as const) : ("project" as const),
  }

  const parsed = await ConfigMarkdown.parse(file).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error: error instanceof Error ? error.message : String(error) }),
  )
  if (!parsed.value)
    return {
      ...base,
      frontmatter: {},
      prompt: await Filesystem.readText(file).catch(() => ""),
      extra: [],
      error: parsed.error,
    }

  const data = parsed.value.data as Record<string, unknown>
  const decoded = decodeFrontmatter(Object.fromEntries(Object.entries(data).filter(([key]) => KNOWN.has(key))))
  return {
    ...base,
    frontmatter: Exit.isSuccess(decoded) ? decoded.value : {},
    prompt: parsed.value.content.trim(),
    extra: Object.keys(data).filter((key) => !KNOWN.has(key)),
    error: Exit.isSuccess(decoded) ? undefined : `${file}: unsupported frontmatter values`,
  }
}

function scan(dir: string) {
  return Glob.scan(PATTERN, { cwd: dir, absolute: true, dot: true, symlink: true })
}

// The path arrives from a client, so it is only accepted when it names a markdown file inside one of
// the config directories this instance already loads agents from.
function resolveWithin(dirs: string[], input: string) {
  const file = path.resolve(input)
  if (path.extname(file) !== ".md") throw new Error(`not an agent markdown file: ${input}`)
  const owner = dirs.find((dir) => {
    const relative = path.relative(dir, file).replaceAll("\\", "/")
    return PREFIXES.some((prefix) => relative.startsWith(prefix))
  })
  if (!owner) throw new Error(`path is outside the agent config directories: ${input}`)
  return file
}

// The name becomes a path under `agent/`, so it is restricted to plain segments. Nesting is allowed
// because agent keys support it (`team/build`), but traversal and absolute paths are not.
function agentName(input: string) {
  const name = input.trim().replaceAll("\\", "/")
  if (!name) throw new Error("agent name is required")
  if (name.length > 128) throw new Error("agent name is too long")
  if (!name.split("/").every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)))
    throw new Error(`invalid agent name: ${input}`)
  return name
}
