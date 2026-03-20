/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

type PromptStatus = "completed" | "error"

async function withPromptSignal<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
  pi.events.emit("ui:prompt_start", { source: "git-checkpoint" })

  let status: PromptStatus = "completed"
  try {
    return await run()
  } catch (error) {
    status = "error"
    throw error
  } finally {
    pi.events.emit("ui:prompt_end", { source: "git-checkpoint", status })
  }
}

export default function (pi: ExtensionAPI) {
  const checkpoints = new Map<string, string>()
  let currentEntryId: string | undefined

  // Track the current entry ID when user messages are saved
  pi.on("tool_result", async (_event, ctx) => {
    const leaf = ctx.sessionManager.getLeafEntry()
    if (leaf) currentEntryId = leaf.id
  })

  pi.on("turn_start", async () => {
    // Create a git stash entry before LLM makes changes
    const { stdout } = await pi.exec("git", ["stash", "create"])
    const ref = stdout.trim()
    if (ref && currentEntryId) {
      checkpoints.set(currentEntryId, ref)
    }
  })

  pi.on("session_before_fork", async (event, ctx) => {
    const ref = checkpoints.get(event.entryId)
    if (!ref) return

    if (!ctx.hasUI) {
      // In non-interactive mode, don't restore automatically
      return
    }

    const choice = await withPromptSignal(pi, () =>
      ctx.ui.select("Restore code state?", [
        "Yes, restore code to that point",
        "No, keep current code",
      ]),
    )

    if (choice?.startsWith("Yes")) {
      await pi.exec("git", ["stash", "apply", ref])
      ctx.ui.notify("Code restored to checkpoint", "info")
    }
  })

  pi.on("agent_end", async () => {
    // Clear checkpoints after agent completes
    checkpoints.clear()
  })
}
