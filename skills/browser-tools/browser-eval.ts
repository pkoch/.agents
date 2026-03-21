#!/usr/bin/env bun

import { connectBrowser, getActivePage, printResult } from "./utils.ts"

const code = process.argv.slice(2).join(" ")
if (!code) {
  console.log("Usage: browser-eval.ts 'code'")
  console.log("\nExamples:")
  console.log('  browser-eval.ts "document.title"')
  console.log("  browser-eval.ts \"document.querySelectorAll('a').length\"")
  process.exit(1)
}

const browser = await connectBrowser()
const page = await getActivePage(browser)

const result = await page.evaluate((c) => {
  const AsyncFunction = (async () => {}).constructor as new (
    body: string,
  ) => (...args: unknown[]) => Promise<unknown>
  return new AsyncFunction(`return (${c})`)()
}, code)

printResult(result)

await browser.disconnect()
