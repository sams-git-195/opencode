import { useParams } from "@solidjs/router"
import { onCleanup } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"

export function useSettingsDialog(defaultValue?: string) {
  const dialog = useDialog()
  const params = useParams<{ id?: string }>()
  let run = 0
  let dead = false

  onCleanup(() => {
    dead = true
  })

  return () => {
    const current = ++run
    const sessionID = params.id
    void import("@/components/settings-v2").then((module) => {
      if (dead || run !== current) return
      void dialog.show(() => <module.DialogSettings sessionID={sessionID} defaultValue={defaultValue} />)
    })
  }
}

export function useSettingsCommand() {
  const command = useCommand()
  const language = useLanguage()
  const show = useSettingsDialog()
  // Reachable from both layouts: useSettingsDialog always opens the v2 dialog, which owns the editor.
  const showAgents = useSettingsDialog("agents")

  command.register("settings", () => [
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: show,
    },
    {
      id: "settings.agents",
      title: language.t("command.settings.agents"),
      category: language.t("command.category.agent"),
      onSelect: showAgents,
    },
  ])

  return show
}
