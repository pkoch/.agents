/**
 * Ghostty terminal title + progress integration.
 *
 * - Shows project/session in the terminal title
 * - Shows a braille spinner in the title while the agent is working
 * - Shows a ? marker while an extension prompt is waiting for input
 * - Updates title with the current tool name during tool execution
 * - Pulses Ghostty's native progress bar while working
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "node:fs";
import path from "node:path";

const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMPLETION_FLASH_MS = 800;

let sessionName: string | undefined;
let currentTool: string | undefined;
let isWorking = false;
let frameIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPromptCount = 0;
let latestCtx: ExtensionContext | undefined;

function ghosttyWrite(seq: string): void {
  try {
    writeFileSync("/dev/tty", seq);
  } catch {
    // /dev/tty may be unavailable (e.g. subagent context)
  }
}

function setProgress(state: number, value?: number): void {
  const args = value !== undefined ? `${state};${value}` : `${state}`;
  ghosttyWrite(`\x1b]9;4;${args}\x07`);
}

function buildTitle(extra?: string, marker = "π"): string {
  const segments: string[] = [marker, path.basename(process.cwd())];
  if (sessionName) segments.push(sessionName);
  if (extra) segments.push(extra);
  return segments.join(" · ");
}

function clearSpinnerTimer(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = undefined;
}

function clearCompletionTimer(): void {
  if (!completionTimer) return;
  clearTimeout(completionTimer);
  completionTimer = undefined;
}

function currentFrame(): string {
  return STATUS_SPINNER_FRAMES[frameIndex % STATUS_SPINNER_FRAMES.length];
}

function hasPendingPrompts(): boolean {
  return pendingPromptCount > 0;
}

function renderWorkingTitle(ctx: ExtensionContext): void {
  ctx.ui.setTitle(buildTitle(currentTool, currentFrame()));
}

function renderPromptTitle(ctx: ExtensionContext): void {
  const extra = isWorking ? currentTool : undefined;
  ctx.ui.setTitle(buildTitle(extra, "?"));
}

function renderActiveTitle(ctx: ExtensionContext): void {
  if (hasPendingPrompts()) {
    renderPromptTitle(ctx);
    return;
  }

  if (isWorking) {
    renderWorkingTitle(ctx);
    return;
  }

  ctx.ui.setTitle(buildTitle());
}

function startSpinnerTimer(ctx: ExtensionContext): void {
  clearSpinnerTimer();
  spinnerTimer = setInterval(() => {
    if (!isWorking || hasPendingPrompts()) return;
    frameIndex = (frameIndex + 1) % STATUS_SPINNER_FRAMES.length;
    renderWorkingTitle(ctx);
  }, STATUS_SPINNER_INTERVAL_MS);
}

function startSpinner(ctx: ExtensionContext): void {
  clearSpinnerTimer();
  clearCompletionTimer();

  isWorking = true;
  currentTool = undefined;
  frameIndex = 0;

  setProgress(hasPendingPrompts() ? 0 : 3);
  renderActiveTitle(ctx);

  if (!hasPendingPrompts()) {
    startSpinnerTimer(ctx);
  }
}

function stopSpinner(ctx: ExtensionContext): void {
  isWorking = false;
  currentTool = undefined;
  clearSpinnerTimer();

  if (hasPendingPrompts()) {
    setProgress(0);
    renderActiveTitle(ctx);
    return;
  }

  setProgress(1, 100);
  ctx.ui.setTitle(buildTitle());

  clearCompletionTimer();
  completionTimer = setTimeout(() => {
    setProgress(0);
    completionTimer = undefined;
  }, COMPLETION_FLASH_MS);
}

function handlePromptStart(ctx: ExtensionContext): void {
  clearCompletionTimer();
  clearSpinnerTimer();
  setProgress(0);
  renderActiveTitle(ctx);
}

function handlePromptEnd(ctx: ExtensionContext): void {
  if (hasPendingPrompts()) {
    renderActiveTitle(ctx);
    return;
  }

  clearCompletionTimer();

  if (isWorking) {
    setProgress(3);
    renderWorkingTitle(ctx);
    startSpinnerTimer(ctx);
    return;
  }

  renderActiveTitle(ctx);
}

function syncSessionTitle(ctx: ExtensionContext): void {
  renderActiveTitle(ctx);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    sessionName = pi.getSessionName();
    syncSessionTitle(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    sessionName = pi.getSessionName();
    syncSessionTitle(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    startSpinner(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    stopSpinner(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    currentTool = event.toolName;
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    if (!isWorking) return;
    renderActiveTitle(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    currentTool = undefined;
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    if (!isWorking) return;
    renderActiveTitle(ctx);
  });

  pi.events.on("ui:prompt_start", () => {
    pendingPromptCount += 1;

    const ctx = latestCtx;
    if (!ctx || !ctx.hasUI) return;
    handlePromptStart(ctx);
  });

  pi.events.on("ui:prompt_end", () => {
    if (pendingPromptCount === 0) return;
    pendingPromptCount -= 1;

    const ctx = latestCtx;
    if (!ctx || !ctx.hasUI) return;
    handlePromptEnd(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    clearSpinnerTimer();
    clearCompletionTimer();
    isWorking = false;
    currentTool = undefined;
    pendingPromptCount = 0;
    latestCtx = undefined;
    setProgress(0);
  });
}
