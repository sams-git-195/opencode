import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"
import { agentConfigStatusQuery, reloadInstance } from "@/utils/agent-config"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"

/** Directory whose agent config the current view is running against. */
export function useActiveDirectory() {
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()

  return createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })
}

/**
 * Appears only while the agent markdown files on disk differ from the ones the running instance
 * loaded, so editing `.opencode/agent/*.md` no longer needs an app restart to take effect.
 */
export function TitlebarAgentRefresh(props: { variant: "v2" | "legacy" }) {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const queryClient = useQueryClient()
  const directory = useActiveDirectory()
  const [reloading, setReloading] = createSignal(false)

  const sdk = createMemo(() => serverSdk().createClient({ directory: directory(), throwOnError: true }))
  const status = useQuery(() => ({
    ...agentConfigStatusQuery(serverSdk().scope, directory() ?? "", sdk(), serverSdk().protocol),
    enabled: !!directory(),
  }))

  const label = () => language.t("titlebar.agentRefresh.label")

  const reload = async () => {
    const dir = directory()
    if (!dir) return
    setReloading(true)
    const key = pathKey(dir)
    await reloadInstance(sdk())
      .then(async () => {
        // The disposed event re-bootstraps the directory on its own, but dropping the cached
        // per-directory queries keeps the panels correct if the event stream is down.
        await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === key })
        await status.refetch()
      })
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(error, language.t),
        })
      })
      .finally(() => setReloading(false))
  }

  return (
    <Show when={status.data?.stale}>
      <Show
        when={props.variant === "v2"}
        fallback={
          <Tooltip placement="bottom" value={label()}>
            <IconButton
              icon="reset"
              variant="ghost"
              class="titlebar-icon rounded-md"
              disabled={reloading()}
              onClick={() => void reload()}
              aria-label={label()}
            />
          </Tooltip>
        }
      >
        <TooltipV2 placement="bottom" value={label()} class="shrink-0">
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            class="shrink-0"
            icon={<IconV2 name="reset" />}
            disabled={reloading()}
            onClick={() => void reload()}
            aria-label={label()}
          />
        </TooltipV2>
      </Show>
    </Show>
  )
}
