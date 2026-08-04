import type {
  AgentFile,
  AgentFileFrontmatter,
  AgentFileScope,
  OpencodeClient,
  PermissionActionConfig,
} from "@opencode-ai/sdk/v2/client"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useQuery } from "@tanstack/solid-query"
import { type Accessor, type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { agentFilesQuery, createAgentFile, deleteAgentFile, saveAgentFile } from "@/utils/agent-config"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const MODES = ["all", "primary", "subagent"] as const
const SCOPES = ["project", "global"] as const
const ACTIONS = ["allow", "ask", "deny"] as const

// Permission keys, not tool names: several tools share one key (write/edit/patch all gate on `edit`).
// Keys omitted here stay in the file untouched, so this list only limits what the form exposes.
// `patterns` marks the keys the config schema types as a Rule, meaning they accept a glob map as well
// as a bare action; the rest only accept an action.
const PERMISSIONS = [
  { key: "bash", patterns: true },
  { key: "edit", patterns: true },
  { key: "read", patterns: true },
  { key: "glob", patterns: true },
  { key: "grep", patterns: true },
  { key: "list", patterns: true },
  { key: "task", patterns: true },
  { key: "skill", patterns: true },
  { key: "lsp", patterns: true },
  { key: "external_directory", patterns: true },
  { key: "webfetch", patterns: false },
  { key: "websearch", patterns: false },
  { key: "todowrite", patterns: false },
  { key: "doom_loop", patterns: false },
] as const

type Permission = (typeof PERMISSIONS)[number]["key"]
type Action = PermissionActionConfig
type Selection = "inherit" | Action | "patterns"
type PatternRow = { id: number; pattern: string; action: Action }
type Rule = { key: string; action: Action } | { key: string; rows: PatternRow[] }
type Fields = Omit<AgentFileFrontmatter, "permission">
type Draft = { fields: Fields; permission: Rule[]; prompt: string }
type PermissionEntry = [string, NonNullable<AgentFileFrontmatter["permission"]>[string]]

let rowID = 0

// The draft keeps permissions as an ordered array rather than the file's object shape: pattern order
// decides precedence (the last matching rule wins), and reordering or renaming a key in place is not
// something an object can express.
const toRules = (permission: AgentFileFrontmatter["permission"]): Rule[] =>
  Object.entries(permission ?? {}).map(([key, rule]) =>
    typeof rule === "string"
      ? { key, action: rule }
      : { key, rows: Object.entries(rule).map(([pattern, action]) => ({ id: rowID++, pattern, action })) },
  )

const fromRules = (rules: Rule[]): AgentFileFrontmatter["permission"] => {
  const entries = rules.flatMap<PermissionEntry>((rule) => {
    if (!("rows" in rule)) return [[rule.key, rule.action]]
    // A pattern list with nothing filled in yet is the same as having no rule at all.
    const rows = rule.rows.filter((row) => row.pattern.trim())
    if (!rows.length) return []
    return [[rule.key, Object.fromEntries(rows.map((row) => [row.pattern.trim(), row.action]))]]
  })
  return entries.length ? Object.fromEntries(entries) : undefined
}

const frontmatterOf = (draft: Draft): AgentFileFrontmatter => ({
  ...draft.fields,
  permission: fromRules(draft.permission),
})

const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )

export const SettingsAgentsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const [selected, setSelected] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)

  const sdk = createMemo(() => serverSdk().createClient({ directory: props.directory(), throwOnError: true }))
  const files = useQuery(() => ({
    ...agentFilesQuery(serverSdk().scope, props.directory() ?? "", sdk(), serverSdk().protocol),
    enabled: !!props.directory(),
  }))

  const list = createMemo(() => files.data ?? [])
  const current = createMemo(() => list().find((file) => file.path === selected()))
  const grouped = createMemo(() =>
    SCOPES.flatMap((scope) => {
      const items = list().filter((file) => file.scope === scope)
      return items.length ? [{ scope, items }] : []
    }),
  )

  const remove = async (file: AgentFile) => {
    await deleteAgentFile(sdk(), file.path)
      .then(async () => {
        setSelected(undefined)
        await files.refetch()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.agents.toast.deleted.title", { agent: file.name }),
          description: language.t("settings.agents.toast.saved.description"),
        })
      })
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(error, language.t),
        })
      })
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-agents-header">
        <div class="settings-v2-tab-header-row">
          <Show
            when={current()}
            fallback={<h2 class="settings-v2-tab-title">{language.t("settings.agents.title")}</h2>}
          >
            {(file) => (
              <div class="settings-v2-agents-title">
                <IconButtonV2
                  type="button"
                  variant="ghost-muted"
                  size="small"
                  icon={<IconV2 name="outline-chevron-down" class="rotate-90" />}
                  onClick={() => setSelected(undefined)}
                  aria-label={language.t("common.goBack")}
                />
                <h2 class="settings-v2-tab-title">{file().name}</h2>
              </div>
            )}
          </Show>
          <Show when={!current() && !creating() && props.directory()}>
            <ButtonV2 type="button" size="small" variant="outline" onClick={() => setCreating(true)}>
              {language.t("settings.agents.action.new")}
            </ButtonV2>
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-agents">
        <Show
          when={current()}
          fallback={
            <>
              <Show when={creating()}>
                <AgentCreateForm
                  sdk={sdk}
                  onCancel={() => setCreating(false)}
                  onCreated={async (file) => {
                    setCreating(false)
                    await files.refetch()
                    setSelected(file.path)
                  }}
                />
              </Show>
              <Show
                when={grouped().length > 0}
                fallback={
                  <div class="settings-v2-agents-status">
                    {files.isLoading ? language.t("common.loading") : language.t("settings.agents.empty")}
                  </div>
                }
              >
                <For each={grouped()}>
                  {(group) => (
                    <div class="settings-v2-section">
                      <h3 class="settings-v2-section-title">
                        {group.scope === "project"
                          ? language.t("settings.agents.scope.project")
                          : language.t("settings.agents.scope.global")}
                      </h3>
                      <SettingsListV2>
                        <For each={group.items}>
                          {(file) => (
                            <SettingsRowV2
                              title={
                                <span class="settings-v2-agents-name">
                                  {file.name}
                                  <Show when={file.frontmatter.disable}>
                                    <Tag>{language.t("settings.agents.tag.disabled")}</Tag>
                                  </Show>
                                </span>
                              }
                              description={file.error ?? file.frontmatter.description ?? file.path}
                            >
                              <ButtonV2
                                type="button"
                                size="small"
                                variant="outline"
                                onClick={() => setSelected(file.path)}
                              >
                                {language.t("common.edit")}
                              </ButtonV2>
                            </SettingsRowV2>
                          )}
                        </For>
                      </SettingsListV2>
                    </div>
                  )}
                </For>
              </Show>
            </>
          }
        >
          {(file) => <AgentEditor file={file()} sdk={sdk} onSaved={() => files.refetch()} onDelete={remove} />}
        </Show>
      </div>
    </>
  )
}

const AgentCreateForm: Component<{
  sdk: Accessor<OpencodeClient>
  onCancel: () => void
  onCreated: (file: AgentFile) => Promise<void>
}> = (props) => {
  const language = useLanguage()
  const [form, setForm] = createStore({ name: "", scope: "project" as AgentFileScope, mode: "all" as const })
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    setBusy(true)
    await createAgentFile(props.sdk(), {
      name: form.name,
      scope: form.scope,
      frontmatter: { mode: form.mode },
      prompt: "",
    })
      .then(async (file) => {
        if (!file) return
        await props.onCreated(file)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.agents.toast.created.title", { agent: file.name }),
          description: language.t("settings.agents.toast.saved.description"),
        })
      })
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(error, language.t),
        })
      })
      .finally(() => setBusy(false))
  }

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.agents.action.new")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.agents.new.name")}
          description={language.t("settings.agents.new.name.hint")}
        >
          <TextInputV2
            value={form.name}
            onInput={(event) => setForm("name", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && form.name.trim()) void submit()
            }}
            placeholder={language.t("settings.agents.new.name.placeholder")}
            spellcheck={false}
            autocapitalize="off"
            autocorrect="off"
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.agents.new.scope")}
          description={language.t("settings.agents.new.scope.hint")}
        >
          <SelectV2
            appearance="inline"
            placement="bottom-end"
            gutter={6}
            options={[...SCOPES]}
            current={form.scope}
            value={(scope) => scope}
            label={(scope) => language.t(`settings.agents.scope.${scope}`)}
            onSelect={(scope) => scope && setForm("scope", scope)}
          />
        </SettingsRowV2>
      </SettingsListV2>
      <div class="settings-v2-agents-buttons settings-v2-agents-buttons--end">
        <ButtonV2 type="button" size="small" variant="ghost-muted" disabled={busy()} onClick={props.onCancel}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 type="button" size="small" disabled={busy() || !form.name.trim()} onClick={() => void submit()}>
          {language.t("settings.agents.action.create")}
        </ButtonV2>
      </div>
    </div>
  )
}

const AgentEditor: Component<{
  file: AgentFile
  sdk: Accessor<OpencodeClient>
  onSaved: () => Promise<unknown>
  onDelete: (file: AgentFile) => Promise<void>
}> = (props) => {
  const language = useLanguage()
  const models = useModels()
  const [saving, setSaving] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)

  const saved = (): Draft => {
    const { permission, ...fields } = props.file.frontmatter
    // Cloned through JSON because the file arrives as a reactive proxy that structuredClone rejects.
    return {
      fields: JSON.parse(JSON.stringify(fields)) as Fields,
      permission: toRules(JSON.parse(JSON.stringify(permission ?? {})) as AgentFileFrontmatter["permission"]),
      prompt: props.file.prompt,
    }
  }
  const [draft, setDraft] = createStore(saved())

  const reset = () => {
    setConfirming(false)
    setDraft(reconcile(saved()))
  }
  // The editor is reused across agents, so switching selection has to reload the draft.
  createEffect(on(() => props.file.path, reset, { defer: true }))

  // Stringifying the store proxy (not `unwrap`) is what subscribes this memo to every draft field.
  // Keys are sorted because the server returns frontmatter in schema order while the draft keeps the
  // order the file had, and a pure reordering of keys is not an edit.
  const dirty = createMemo(
    () =>
      stable({ frontmatter: frontmatterOf(draft), prompt: draft.prompt }) !==
      stable({ frontmatter: props.file.frontmatter, prompt: props.file.prompt }),
  )

  const modelOptions = createMemo(() => [
    { id: "", label: language.t("settings.agents.field.inherit") },
    ...models.list().map((model) => ({
      id: `${model.provider.id}/${model.id}`,
      label: `${model.provider.name} / ${model.name}`,
    })),
  ])

  const number = (value: number | undefined) => (value === undefined ? "" : String(value))
  const setNumber = (key: "temperature" | "top_p" | "steps", value: string) => {
    if (!value.trim()) return setDraft("fields", key, undefined)
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    setDraft("fields", key, parsed)
  }

  const ruleIndex = (key: Permission) => draft.permission.findIndex((rule) => rule.key === key)
  const rule = (key: Permission) => draft.permission[ruleIndex(key)]

  const selection = (key: Permission): Selection => {
    const found = rule(key)
    if (!found) return "inherit"
    return "rows" in found ? "patterns" : found.action
  }

  const rows = (key: Permission) => {
    const found = rule(key)
    return found && "rows" in found ? found.rows : undefined
  }

  const select = (key: Permission, next: Selection) => {
    const index = ruleIndex(key)
    if (next === "inherit") {
      if (index !== -1)
        setDraft(
          "permission",
          produce((list) => void list.splice(index, 1)),
        )
      return
    }
    const current = index === -1 ? undefined : draft.permission[index]
    const replacement: Rule =
      next === "patterns"
        ? // Seed from the action it is replacing so switching modes never silently widens access.
          {
            key,
            rows: [{ id: rowID++, pattern: "*", action: current && !("rows" in current) ? current.action : "ask" }],
          }
        : { key, action: next }
    if (index === -1) return setDraft("permission", draft.permission.length, replacement)
    setDraft("permission", index, reconcile(replacement))
  }

  const mutateRows = (key: Permission, mutate: (list: PatternRow[]) => void) => {
    const index = ruleIndex(key)
    if (index === -1) return
    setDraft(
      "permission",
      index,
      produce((value) => {
        if ("rows" in value) mutate(value.rows)
      }),
    )
  }

  const save = async () => {
    setSaving(true)
    await saveAgentFile(props.sdk(), {
      path: props.file.path,
      frontmatter: frontmatterOf(unwrap(draft)),
      prompt: draft.prompt,
    })
      .then(async () => {
        await props.onSaved()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.agents.toast.saved.title", { agent: props.file.name }),
          description: language.t("settings.agents.toast.saved.description"),
        })
      })
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(error, language.t),
        })
      })
      .finally(() => setSaving(false))
  }

  return (
    <>
      <Show when={props.file.error}>
        {(error) => <div class="settings-v2-agents-status settings-v2-agents-error">{error()}</div>}
      </Show>

      <div class="settings-v2-section">
        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.agents.field.description.title")}
            description={language.t("settings.agents.field.description.description")}
          >
            <TextInputV2
              value={draft.fields.description ?? ""}
              onInput={(event) => setDraft("fields", "description", event.currentTarget.value || undefined)}
              placeholder={language.t("settings.agents.field.description.placeholder")}
            />
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.agents.field.mode.title")}
            description={language.t("settings.agents.field.mode.description")}
          >
            <SelectV2
              appearance="inline"
              placement="bottom-end"
              gutter={6}
              options={[...MODES]}
              current={draft.fields.mode ?? "all"}
              value={(mode) => mode}
              label={(mode) => language.t(`settings.agents.mode.${mode}`)}
              onSelect={(mode) => mode && setDraft("fields", "mode", mode)}
            />
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.agents.field.model.title")}
            description={language.t("settings.agents.field.model.description")}
          >
            <SelectV2
              appearance="inline"
              placement="bottom-end"
              gutter={6}
              options={modelOptions()}
              current={modelOptions().find((option) => option.id === (draft.fields.model ?? ""))}
              value={(option) => option.id}
              label={(option) => option.label}
              onSelect={(option) => setDraft("fields", "model", option?.id || undefined)}
            />
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.agents.field.temperature.title")}
            description={language.t("settings.agents.field.temperature.description")}
          >
            <TextInputV2
              numeric
              inputmode="decimal"
              value={number(draft.fields.temperature)}
              onInput={(event) => setNumber("temperature", event.currentTarget.value)}
              placeholder={language.t("settings.agents.field.inherit")}
            />
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.agents.field.topP.title")}
            description={language.t("settings.agents.field.topP.description")}
          >
            <TextInputV2
              numeric
              inputmode="decimal"
              value={number(draft.fields.top_p)}
              onInput={(event) => setNumber("top_p", event.currentTarget.value)}
              placeholder={language.t("settings.agents.field.inherit")}
            />
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.agents.field.steps.title")}
            description={language.t("settings.agents.field.steps.description")}
          >
            <TextInputV2
              numeric
              inputmode="numeric"
              value={number(draft.fields.steps)}
              onInput={(event) => setNumber("steps", event.currentTarget.value)}
              placeholder={language.t("settings.agents.field.inherit")}
            />
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.agents.field.hidden.title")}
            description={language.t("settings.agents.field.hidden.description")}
          >
            <Switch
              hideLabel
              checked={draft.fields.hidden ?? false}
              onChange={(checked) => setDraft("fields", "hidden", checked || undefined)}
            >
              {language.t("settings.agents.field.hidden.title")}
            </Switch>
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.agents.field.disable.title")}
            description={language.t("settings.agents.field.disable.description")}
          >
            <Switch
              hideLabel
              checked={draft.fields.disable ?? false}
              onChange={(checked) => setDraft("fields", "disable", checked || undefined)}
            >
              {language.t("settings.agents.field.disable.title")}
            </Switch>
          </SettingsRowV2>
        </SettingsListV2>
      </div>

      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.agents.section.permissions")}</h3>
        <SettingsListV2>
          <For each={PERMISSIONS}>
            {(permission) => (
              <div class="settings-v2-agents-permission">
                <SettingsRowV2
                  title={language.t(`settings.permissions.tool.${permission.key}.title`)}
                  description={language.t(`settings.permissions.tool.${permission.key}.description`)}
                >
                  <SelectV2
                    appearance="inline"
                    placement="bottom-end"
                    gutter={6}
                    options={
                      permission.patterns
                        ? (["inherit", ...ACTIONS, "patterns"] as Selection[])
                        : (["inherit", ...ACTIONS] as Selection[])
                    }
                    current={selection(permission.key)}
                    value={(item) => item}
                    label={(item) => language.t(`settings.agents.rule.${item}`)}
                    onSelect={(item) => item && select(permission.key, item)}
                  />
                </SettingsRowV2>
                <Show when={rows(permission.key)}>
                  {(list) => (
                    <PatternEditor
                      rows={list}
                      onPattern={(id, value) =>
                        mutateRows(permission.key, (items) => {
                          const row = items.find((item) => item.id === id)
                          if (row) row.pattern = value
                        })
                      }
                      onAction={(id, value) =>
                        mutateRows(permission.key, (items) => {
                          const row = items.find((item) => item.id === id)
                          if (row) row.action = value
                        })
                      }
                      onRemove={(id) =>
                        mutateRows(permission.key, (items) => {
                          const index = items.findIndex((item) => item.id === id)
                          if (index !== -1) items.splice(index, 1)
                        })
                      }
                      onMove={(id, delta) =>
                        mutateRows(permission.key, (items) => {
                          const index = items.findIndex((item) => item.id === id)
                          const next = index + delta
                          if (index === -1 || next < 0 || next >= items.length) return
                          const [row] = items.splice(index, 1)
                          items.splice(next, 0, row)
                        })
                      }
                      onAdd={() =>
                        mutateRows(permission.key, (items) => {
                          items.push({ id: rowID++, pattern: "", action: "ask" })
                        })
                      }
                    />
                  )}
                </Show>
              </div>
            )}
          </For>
        </SettingsListV2>
      </div>

      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.agents.section.prompt")}</h3>
        <TextareaV2
          rows={16}
          value={draft.prompt}
          onInput={(event) => setDraft("prompt", event.currentTarget.value)}
          placeholder={language.t("settings.agents.field.prompt.placeholder")}
          spellcheck={false}
        />
        <Show when={props.file.extra.length > 0}>
          <span class="settings-v2-agents-note">
            {language.t("settings.agents.extraKeys", { keys: props.file.extra.join(", ") })}
          </span>
        </Show>
      </div>

      <div class="settings-v2-agents-actions">
        <span class="settings-v2-agents-path">{props.file.path}</span>
        <div class="settings-v2-agents-buttons">
          <ButtonV2
            type="button"
            size="small"
            variant={confirming() ? "danger" : "ghost-muted"}
            disabled={saving()}
            onClick={() => {
              if (!confirming()) {
                setConfirming(true)
                return
              }
              setConfirming(false)
              void props.onDelete(props.file)
            }}
          >
            {confirming() ? language.t("settings.agents.action.deleteConfirm") : language.t("common.delete")}
          </ButtonV2>
          <ButtonV2 type="button" size="small" variant="ghost-muted" disabled={!dirty() || saving()} onClick={reset}>
            {language.t("common.reset")}
          </ButtonV2>
          <ButtonV2 type="button" size="small" disabled={!dirty() || saving()} onClick={() => void save()}>
            {language.t("common.save")}
          </ButtonV2>
        </div>
      </div>
    </>
  )
}

const PatternEditor: Component<{
  rows: Accessor<PatternRow[]>
  onPattern: (id: number, value: string) => void
  onAction: (id: number, value: Action) => void
  onRemove: (id: number) => void
  onMove: (id: number, delta: 1 | -1) => void
  onAdd: () => void
}> = (props) => {
  const language = useLanguage()

  return (
    <div class="settings-v2-agents-patterns">
      <For each={props.rows()}>
        {(row, index) => (
          <div class="settings-v2-agents-pattern-row">
            <TextInputV2
              class="settings-v2-agents-pattern-input"
              value={row.pattern}
              onInput={(event) => props.onPattern(row.id, event.currentTarget.value)}
              placeholder={language.t("settings.agents.patterns.placeholder")}
              spellcheck={false}
              autocapitalize="off"
              autocorrect="off"
            />
            <SelectV2
              appearance="inline"
              placement="bottom-end"
              gutter={6}
              options={[...ACTIONS]}
              current={row.action}
              value={(item) => item}
              label={(item) => language.t(`settings.agents.rule.${item}`)}
              onSelect={(item) => item && props.onAction(row.id, item)}
            />
            <div class="settings-v2-agents-pattern-actions">
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                icon={<IconV2 name="outline-chevron-down" class="rotate-180" />}
                disabled={index() === 0}
                onClick={() => props.onMove(row.id, -1)}
                aria-label={language.t("settings.agents.patterns.moveUp")}
              />
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                icon={<IconV2 name="outline-chevron-down" />}
                disabled={index() === props.rows().length - 1}
                onClick={() => props.onMove(row.id, 1)}
                aria-label={language.t("settings.agents.patterns.moveDown")}
              />
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                icon={<IconV2 name="close" />}
                onClick={() => props.onRemove(row.id)}
                aria-label={language.t("settings.agents.patterns.remove")}
              />
            </div>
          </div>
        )}
      </For>
      <div class="settings-v2-agents-pattern-footer">
        <span class="settings-v2-agents-note">{language.t("settings.agents.patterns.hint")}</span>
        <ButtonV2 type="button" size="small" variant="outline" onClick={props.onAdd}>
          {language.t("settings.agents.patterns.add")}
        </ButtonV2>
      </div>
    </div>
  )
}
