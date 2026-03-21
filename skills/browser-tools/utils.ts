import puppeteer from "puppeteer-core"
import type { Browser, Page } from "puppeteer-core"

export async function connectBrowser(timeout = 5000): Promise<Browser> {
  const browser = await Promise.race([
    puppeteer.connect({
      browserURL: "http://localhost:9222",
      defaultViewport: null,
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeout).unref()
    }),
  ]).catch((e) => {
    const message = e instanceof Error ? e.message : String(e)
    console.error("✗ Could not connect to browser:", message)
    console.error("  Run: browser-start.ts")
    process.exit(1)
  })
  return browser
}

export async function getActivePage(browser: Browser): Promise<Page> {
  const pages = await browser.pages()
  const page = pages.filter((pg) => pg.url().startsWith("http")).at(-1) || pages.at(-1)
  if (!page) {
    console.error("✗ No active tab found")
    process.exit(1)
  }
  return page
}

export function printResult(result: unknown): void {
  if (typeof result === "object" && result !== null) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(result)
  }
}
