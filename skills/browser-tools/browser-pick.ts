#!/usr/bin/env bun

import { connectBrowser, getActivePage, printResult } from "./utils.ts"

const message = process.argv.slice(2).join(" ")
if (!message) {
  console.log("Usage: browser-pick.ts 'message'")
  console.log("\nExample:")
  console.log('  browser-pick.ts "Click the submit button"')
  process.exit(1)
}

const browser = await connectBrowser()
const page = await getActivePage(browser)

// Inject pick() helper into current page
await page.evaluate(() => {
  type ElementInfo = {
    tag: string
    id: string | null
    class: string | null
    text: string | null
    html: string
    parents: string
  }

  type PickResult = ElementInfo | ElementInfo[] | null
  type PickWindow = Window &
    typeof globalThis & {
      pick?: (message: string) => Promise<PickResult>
    }

  const pickWindow = window as PickWindow

  if (!pickWindow.pick) {
    pickWindow.pick = async (message: string) => {
      if (!message) {
        throw new Error("pick() requires a message parameter")
      }
      return new Promise<PickResult>((resolve) => {
        const selections: ElementInfo[] = []
        const selectedElements = new Set<HTMLElement>()

        const overlay = document.createElement("div")
        overlay.style.cssText =
          "position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none"

        const highlight = document.createElement("div")
        highlight.style.cssText =
          "position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s"
        overlay.appendChild(highlight)

        const banner = document.createElement("div")
        banner.style.cssText =
          "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 24px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto;z-index:2147483647"

        const updateBanner = () => {
          banner.textContent = `${message} (${selections.length} selected, Cmd/Ctrl+click to add, Enter to finish, ESC to cancel)`
        }
        updateBanner()

        document.body.append(banner, overlay)

        const cleanup = () => {
          document.removeEventListener("mousemove", onMove, true)
          document.removeEventListener("click", onClick, true)
          document.removeEventListener("keydown", onKey, true)
          overlay.remove()
          banner.remove()
          selectedElements.forEach((el) => {
            el.style.outline = ""
          })
        }

        const onMove = (e: MouseEvent) => {
          const el = document.elementFromPoint(e.clientX, e.clientY)
          if (!(el instanceof HTMLElement) || overlay.contains(el) || banner.contains(el)) return
          const r = el.getBoundingClientRect()
          highlight.style.cssText = `position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px`
        }

        const buildElementInfo = (el: HTMLElement): ElementInfo => {
          const parents: string[] = []
          let current = el.parentElement
          while (current && current !== document.body) {
            const parentInfo = current.tagName.toLowerCase()
            const id = current.id ? `#${current.id}` : ""
            const className = typeof current.className === "string" ? current.className : ""
            const cls = className ? `.${className.trim().split(/\s+/).join(".")}` : ""
            parents.push(parentInfo + id + cls)
            current = current.parentElement
          }

          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            class: el.className || null,
            text: el.textContent?.trim().slice(0, 200) || null,
            html: el.outerHTML.slice(0, 500),
            parents: parents.join(" > "),
          }
        }

        const onClick = (e: MouseEvent) => {
          if (e.target instanceof Node && banner.contains(e.target)) return
          e.preventDefault()
          e.stopPropagation()
          const el = document.elementFromPoint(e.clientX, e.clientY)
          if (!(el instanceof HTMLElement) || overlay.contains(el) || banner.contains(el)) return

          if (e.metaKey || e.ctrlKey) {
            if (!selectedElements.has(el)) {
              selectedElements.add(el)
              el.style.outline = "3px solid #10b981"
              selections.push(buildElementInfo(el))
              updateBanner()
            }
          } else {
            cleanup()
            const info = buildElementInfo(el)
            resolve(selections.length > 0 ? selections : info)
          }
        }

        const onKey = (e: KeyboardEvent) => {
          if (e.key === "Escape") {
            e.preventDefault()
            cleanup()
            resolve(null)
          } else if (e.key === "Enter" && selections.length > 0) {
            e.preventDefault()
            cleanup()
            resolve(selections)
          }
        }

        document.addEventListener("mousemove", onMove, true)
        document.addEventListener("click", onClick, true)
        document.addEventListener("keydown", onKey, true)
      })
    }
  }
})

const result = await page.evaluate((msg) => {
  type ElementInfo = {
    tag: string
    id: string | null
    class: string | null
    text: string | null
    html: string
    parents: string
  }

  type PickResult = ElementInfo | ElementInfo[] | null
  type PickWindow = Window &
    typeof globalThis & {
      pick?: (message: string) => Promise<PickResult>
    }

  const pickWindow = window as PickWindow
  return pickWindow.pick?.(msg) ?? null
}, message)

printResult(result)

await browser.disconnect()
