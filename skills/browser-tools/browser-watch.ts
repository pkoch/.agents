#!/usr/bin/env bun

/**
 * Background logging for browser-tools.
 *
 * Logs console output, page errors, and network activity to JSONL.
 *
 * Default log root:
 *   $TMPDIR/agent-browser-tools/logs
 *
 * Override with:
 *   BROWSER_TOOLS_LOG_ROOT=/some/dir
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import puppeteer from "puppeteer-core"
import type { Browser, Page, Target } from "puppeteer-core"

const DEFAULT_TMP = process.platform === "win32" ? tmpdir() : "/tmp"

const LOG_ROOT =
  process.env.BROWSER_TOOLS_LOG_ROOT || join(DEFAULT_TMP, "agent-browser-tools", "logs")

const PID_FILE = join(LOG_ROOT, ".watch.pid")

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function getDateDir(): string {
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  const dd = String(now.getDate()).padStart(2, "0")
  return join(LOG_ROOT, `${yyyy}-${mm}-${dd}`)
}

function safeFileName(value: unknown): string {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_")
}

function nowIso(): string {
  return new Date().toISOString()
}

async function connectBrowser(timeout = 5000): Promise<Browser> {
  return Promise.race([
    puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeout).unref()
    }),
  ])
}

ensureDir(LOG_ROOT)

// Prevent duplicate watchers.
if (existsSync(PID_FILE)) {
  try {
    const existing = Number(readFileSync(PID_FILE, "utf8").trim())
    if (existing && isProcessAlive(existing)) {
      console.log("✓ watch already running")
      process.exit(0)
    }
  } catch {
    // ignore stale pid
  }
}

writeFileSync(PID_FILE, String(process.pid))

const dateDir = getDateDir()
ensureDir(dateDir)

// targetId -> { stream, filepath }
const targetState = new Map<
  string,
  { stream: ReturnType<typeof createWriteStream>; filepath: string }
>()
const requestIds = new WeakMap<object, string>()
const pageToTarget = new WeakMap<Page, string>()
const instrumentedPages = new WeakSet<Page>()
let nextSyntheticPageId = 1

function getOrCreateTargetState(targetId: string) {
  let state = targetState.get(targetId)
  if (state) return state

  const filename = `${safeFileName(targetId)}.jsonl`
  const filepath = join(dateDir, filename)
  const stream = createWriteStream(filepath, { flags: "a" })

  state = { stream, filepath }
  targetState.set(targetId, state)
  return state
}

function writeLog(targetId: string, payload: Record<string, unknown>): void {
  const state = getOrCreateTargetState(targetId)
  const record = {
    ts: nowIso(),
    targetId,
    ...payload,
  }
  state.stream.write(`${JSON.stringify(record)}\n`)
}

function internalTargetId(page: Page): string | null {
  try {
    const target = page.target() as Target & {
      _targetId?: string
      _targetInfo?: { targetId?: string }
      _id?: string
    }
    return target._targetId || target._targetInfo?.targetId || target._id || null
  } catch {
    return null
  }
}

function ensureTargetId(page: Page): string {
  const existing = pageToTarget.get(page)
  if (existing) return existing

  const internal = internalTargetId(page)
  const chosen = internal ? String(internal) : `page-${nextSyntheticPageId++}`
  pageToTarget.set(page, chosen)
  return chosen
}

function ensureRequestId(targetId: string, request: object): string {
  const existing = requestIds.get(request)
  if (existing) return existing
  const id = `${targetId}-${Math.random().toString(16).slice(2)}-${Date.now()}`
  requestIds.set(request, id)
  return id
}

function closeTarget(targetId: string): void {
  const state = targetState.get(targetId)
  if (!state) return
  try {
    state.stream.end()
  } catch {
    // ignore
  }
  targetState.delete(targetId)
}

async function instrumentPage(page: Page): Promise<void> {
  if (instrumentedPages.has(page)) return
  instrumentedPages.add(page)

  const targetId = ensureTargetId(page)

  // Do not double-instrument.
  if (targetState.has(targetId)) {
    // Note: this assumes a 1:1 mapping between targetId and page.
    // That’s fine for our usage.
  }

  writeLog(targetId, {
    type: "target.attached",
    url: page.url?.() || null,
  })

  page.on("console", (msg) => {
    try {
      writeLog(targetId, {
        type: "console",
        level: msg.type?.() || null,
        text: msg.text?.() || null,
        args: (msg.args?.() || []).map((a) => a.toString()),
      })
    } catch {
      // ignore
    }
  })

  page.on("pageerror", (err) => {
    writeLog(targetId, {
      type: "exception",
      text: err?.message || String(err),
      stack: err?.stack || null,
    })
  })

  page.on("error", (err) => {
    writeLog(targetId, {
      type: "page.crash",
      text: err?.message || String(err),
      stack: err?.stack || null,
    })
  })

  page.on("request", (req) => {
    const requestId = ensureRequestId(targetId, req)
    writeLog(targetId, {
      type: "network.request",
      requestId,
      method: req.method?.() || null,
      url: req.url?.() || null,
      resourceType: req.resourceType?.() || null,
      isNavigationRequest: !!req.isNavigationRequest?.(),
      hasPostData: !!req.postData?.(),
    })
  })

  page.on("response", (res) => {
    try {
      const req = res.request()
      const requestId = ensureRequestId(targetId, req)
      const headers = res.headers?.() || {}
      const contentType = headers["content-type"] || headers["Content-Type"] || null

      writeLog(targetId, {
        type: "network.response",
        requestId,
        url: res.url?.() || null,
        status: res.status?.(),
        statusText: res.statusText?.() || null,
        mimeType: contentType,
        fromDiskCache: !!res.fromCache?.(),
        fromServiceWorker: !!res.fromServiceWorker?.(),
      })
    } catch (e) {
      writeLog(targetId, {
        type: "network.response",
        requestId: null,
        url: null,
        status: null,
        statusText: null,
        mimeType: null,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })

  page.on("requestfailed", (req) => {
    const requestId = ensureRequestId(targetId, req)
    writeLog(targetId, {
      type: "network.failure",
      requestId,
      url: req.url?.() || null,
      errorText: req.failure?.()?.errorText || null,
      canceled: req.failure?.()?.errorText === "net::ERR_ABORTED",
    })
  })

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      writeLog(targetId, {
        type: "page.navigated",
        url: frame.url?.() || null,
      })
    }
  })

  page.on("close", () => {
    writeLog(targetId, { type: "target.closed" })
    closeTarget(targetId)
  })
}

function cleanupAndExit(code = 0): never {
  try {
    for (const targetId of targetState.keys()) {
      closeTarget(targetId)
    }
    try {
      unlinkSync(PID_FILE)
    } catch {
      // ignore
    }
  } finally {
    process.exit(code)
  }
}

process.on("SIGINT", () => cleanupAndExit(0))
process.on("SIGTERM", () => cleanupAndExit(0))

async function main(): Promise<void> {
  const browser = await connectBrowser(5000).catch((e) => {
    const message = e instanceof Error ? e.message : String(e)
    console.error("✗ Could not connect to browser:", message)
    console.error("  Run: browser-start.ts")
    process.exit(1)
  })

  // Existing pages.
  const pages = await browser.pages()
  for (const page of pages) {
    await instrumentPage(page)
  }

  // New pages.
  browser.on("targetcreated", async (target) => {
    try {
      if (target.type?.() !== "page") return
      const page = await target.page()
      if (page) await instrumentPage(page)
    } catch {
      // ignore
    }
  })

  console.log(`✓ watch started (logs: ${dateDir})`)
}

await main()
