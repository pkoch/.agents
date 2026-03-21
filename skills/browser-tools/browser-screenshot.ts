#!/usr/bin/env bun

import { tmpdir } from "node:os"
import { join } from "node:path"

import { connectBrowser, getActivePage } from "./utils.ts"

const browser = await connectBrowser()
const page = await getActivePage(browser)

const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const filename = `screenshot-${timestamp}.png`
const filepath = join(tmpdir(), filename)

await page.screenshot({ path: filepath })

console.log(filepath)

await browser.disconnect()
