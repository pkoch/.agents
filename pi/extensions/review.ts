/**
 * Unified /review + /fix extension.
 *
 * What this extension does:
 * - /review runs multiple parallel focuses (general, reuse, quality, efficiency),
 *   then emits a single findings report.
 * - /fix applies findings from the review report. If the latest message is not a
 *   valid/stale review payload, /fix runs a fresh review first and then fixes.
 *
 * Key behavior:
 * - /review is findings-only (no direct edits).
 * - Focus outputs are strict JSON; final review output is human-readable markdown plus
 *   a typed custom message payload (customType: "review").
 * - /fix staleness checks use a repo fingerprint: HEAD SHA + branch + tracked diff hash + untracked content hash.
 *
 * Commands:
 * - /review [mode] [models=...] [context=...]
 * - /fix [mode] [models=...] [context=...]
 *
 * Modes supported by both commands:
 * - auto (default)
 * - uncommitted
 * - branch <name>
 * - commit <sha>
 * - pr <number|url>
 * - folder <paths...>
 * - custom "<instructions>"
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

// --- Types ---

type Priority = "P0" | "P1" | "P2" | "P3";
type FocusName = "general" | "reuse" | "quality" | "efficiency";
type FocusDefinition = { suffix: string; qualifier: string; context: string };
type ReviewRunSource = "review" | "fix";
type ReviewRunOutcome = "success" | "failed" | "cancelled";

type ReviewTarget =
	| { type: "auto" }
	| { type: "uncommitted" }
	| { type: "branch"; branch: string }
	| { type: "commit"; sha: string }
	| { type: "pr"; ref: string }
	| { type: "folder"; paths: string[] }
	| { type: "custom"; instructions: string };

type ReviewRequestMode =
	| "auto"
	| "uncommitted"
	| `branch:${string}`
	| `commit:${string}`
	| `pr:${string}`
	| `folder:${string}`
	| "custom";

type ParsedRequest = {
	target: ReviewTarget;
	mode: ReviewRequestMode;
	models: string[];
	rawArgs: string;
	additionalContext?: string;
};

type ReviewFingerprint = {
	headSha: string;
	branch: string;
	trackedDiffHash: string;
	untrackedHash: string;
};

type FocusFinding = {
	priority: Priority;
	location: string;
	finding: string;
	fix_suggestion: string;
};

type FocusOutput = {
	focus: FocusName;
	model: string;
	findings: FocusFinding[];
};

type FocusTask = {
	focus: FocusName;
	modelArg: string | undefined;
	modelLabel: string;
	prompt: string;
};

type FocusTaskErrorKind = "lock_contention" | "missing_api_key" | "model_not_found" | "other";

type FocusTaskResult = {
	focus: FocusName;
	model: string;
	ok: boolean;
	output?: FocusOutput;
	error?: string;
	errorKind?: FocusTaskErrorKind;
	missingApiProvider?: string;
};

type ReviewReportFinding = {
	priority: Priority;
	location: string;
	finding: string;
	fix_suggestion: string;
	focus: string;
	model: string;
};

type ReviewMessageDetails = {
	kind: "findings";
	version: 1;
	reviewId: string;
	generatedAt: string;
	request: {
		mode: ReviewRequestMode;
		models: string[];
		userArgs: string;
	};
	scope: {
		mode: ResolvedScope["kind"];
		description: string;
	};
	fingerprint: ReviewFingerprint;
	focusStatus: Array<{
		focus: FocusName;
		model: string;
		ok: boolean;
		error?: string;
	}>;
	findings: ReviewReportFinding[];
};

type ReviewRunResult =
	| { ok: false; error: string }
	| { ok: true; details: ReviewMessageDetails };

type ResolvedScope =
	| {
			kind: "working-tree";
			trackedFiles: string[];
			untrackedFiles: string[];
			hasHead: boolean;
			description: string;
	  }
	| {
			kind: "branch-diff";
			baseBranch: string;
			mergeBase: string;
			diffFiles: string[];
			description: string;
	  }
	| {
			kind: "commit";
			sha: string;
			description: string;
	  }
	| {
			kind: "folder";
			paths: string[];
			description: string;
	  }
	| {
			kind: "custom";
			instructions: string;
			description: string;
	  };

type ReviewExecutionControl = {
	isCancelled: () => boolean;
	registerProcess: (proc: ChildProcess) => () => void;
};

type PiJsonTaskStatus = "ok" | "cancelled" | "timeout" | "spawn_error" | "non_zero_exit";

type PiJsonTaskResult = {
	status: PiJsonTaskStatus;
	assistantOutput: string;
	stderr: string;
	exitCode?: number;
	error?: string;
};

type PiJsonTaskOptions = {
	args: string[];
	prompt: string;
	cwd: string;
	timeoutMs: number;
	control?: ReviewExecutionControl;
};

type PreparedReviewRun = {
	scope: ResolvedScope;
	includeUntracked: boolean;
	baselineFingerprint: ReviewFingerprint;
	models: Array<{ modelArg: string | undefined; modelLabel: string }>;
	tasks: FocusTask[];
};

// --- Constants & prompts ---

const REVIEW_FOCUS_TOOLS = "read,bash,grep,find,ls";
const REVIEW_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const REVIEW_STARTUP_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;
const REVIEW_STARTUP_RETRY_JITTER_RATIO = 0.2;
const REVIEW_UNTRACKED_HASH_DISABLED = "__disabled__";
const REVIEW_CANCELLED_ERROR = "Review aborted";
const REVIEW_EVENT_START = "review:start";
const REVIEW_EVENT_END = "review:end";
const REVIEW_MODE_HINTS = ["help", "auto", "uncommitted", "branch", "commit", "pr", "folder", "custom"] as const;
const STATUS_KEY = "review";
const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const REVIEW_RUBRIC_PROMPT = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Call out newly added dependencies explicitly and explain why they're needed.
11. Apply system-level thinking; flag changes that increase operational risk or on-call burden.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.`;

const REVIEW_FOCUSES: Record<FocusName, FocusDefinition> = {
	general: {
		suffix: "",
		qualifier: "",
		context: REVIEW_RUBRIC_PROMPT,
	},
	reuse: {
		suffix: " specializing in reuse analysis",
		qualifier: " reuse",
		context: `For each change:
1. Search for existing utilities and helpers that could replace newly written code. Start with ripgrep-style searches (use the grep tool first), then inspect utility directories, shared modules, and adjacent files.
2. Flag any new function that duplicates existing functionality. Suggest the existing function to use instead.
3. Flag any inline logic that could use an existing utility — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.`,
	},
	quality: {
		suffix: " specializing in quality analysis",
		qualifier: " quality",
		context: `Review the changes for:
1. Redundant state: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls.
2. Parameter sprawl: adding new parameters to a function instead of generalizing or restructuring existing ones.
3. Copy-paste with slight variation: near-duplicate code blocks that should be unified with a shared abstraction.
4. Leaky abstractions: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries.
5. Stringly-typed code: using raw strings where constants, enums (string unions), or branded types already exist in the codebase.
6. Simplicity: prefer simple, direct solutions over wrappers or abstractions without clear reuse value.
7. Fail-fast: favor explicit failures over logging-and-continue patterns that hide errors. Prefer predictable failure modes over silent degradation.
8. Error classification: ensure errors are checked against codes or stable identifiers, never error message strings.`,
	},
	efficiency: {
		suffix: " specializing in efficiency analysis",
		qualifier: " efficiency",
		context: `Review the changes for:
1. Unnecessary work: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns.
2. Missed concurrency: independent operations run sequentially when they could run in parallel.
3. Hot-path bloat: new blocking work added to startup or per-request/per-render hot paths.
4. Unnecessary existence checks: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error.
5. Memory: unbounded data structures, missing cleanup, event listener leaks.
6. Overly broad operations: reading entire files when only a portion is needed, loading all items when filtering for one.
7. Backpressure: treat backpressure handling as critical to system stability; flag unbounded queues, missing flow control, or producer-consumer imbalances.`,
	},
};

const REVIEW_ADDITIONAL_CONTEXT_SECTION_PROMPT = `Additional context from user:
{ADDITIONAL_CONTEXT}
`;

const REVIEW_PROJECT_GUIDELINES_SECTION_PROMPT = `Project-specific review guidelines:
{PROJECT_GUIDELINES}
`;

const REVIEW_JSON_OUTPUT_CONTRACT_PROMPT = `Output requirements:
- Return valid JSON only (no markdown, no prose outside JSON).
- Do not wrap output in code fences.
- Use this exact shape:
  {
    "findings": [
      {
        "priority": "P0|P1|P2|P3",
        "location": "path/to/file:line or path/to/file",
        "finding": "what is wrong and why it matters",
        "fix_suggestion": "actionable suggestion"
      }
    ],
    "note": "optional"
  }
- If no issues are found, return findings: [].
- If uncertain, return findings: [] with a note instead of prose.
- Before sending, self-check that JSON.parse(output) would succeed.`;

const REVIEW_FOCUS_PROMPT = `You are an expert code reviewer{FOCUS_SUFFIX}.

Objective:
- Find concrete, high-confidence{FOCUS_QUALIFIER} issues introduced by the scoped changes.
- Output every finding the author would fix if they were made aware of it. Do not stop at the first qualifying finding — continue until you have listed every qualifying finding.
- Do not flag issues the author would not fix. If there is no finding that a person would definitely want to see and fix, prefer outputting no findings.

{SCOPE_INSTRUCTIONS}

{FOCUS_CONTEXT}

Important:
- Focus only on issues introduced in the reviewed scope.
- Keep each finding independent, discrete, and actionable.
- Assign each finding a priority P0..P3.
- This is a read-only review focus. Do not modify files or repository state; do not run mutating commands.

{ADDITIONAL_CONTEXT_SECTION}{PROJECT_GUIDELINES_SECTION}
{OUTPUT_CONTRACT}`;


const FIX_PROMPT = `You are an expert software engineer applying fixes and improvements from a completed code review.

Use ONLY the findings in the review payload below as your worklist.
You are the decision-maker: if a finding is invalid, duplicate, too risky, or clearly not worth fixing, skip it with a brief reason and continue.

Process:
1) Work findings one by one in priority order: P0, P1, P2, P3.
2) For each finding:
   - Validate against current code.
   - If valid and worthwhile, implement the minimal correct fix.
   - If not, skip with a short reason.
3) Run relevant verification for touched code (targeted tests/checks preferred; avoid unnecessary full-suite runs).
4) Keep changes focused; avoid unrelated refactors.
5) Do not stop at first fix; continue through the whole list.

Output formatting requirements:
- In Verification, prefer plain text. If you cite executed commands, append them after a semicolon and wrap only the command snippet in inline backticks.
- In Notes, use plain prose. Use inline backticks sparingly when they improve clarity, such as for exact identifiers, paths, or command snippets.
- Do not use code fences.
- Do not include the pipe character in any cell text (including inside backticks). Avoid regex alternation patterns like (a|b); rewrite checks without pipes and separate multiple checks with semicolons.
- Decision values must be exactly fixed or skipped.

Review findings worklist JSON (authoritative):
{REVIEW_FINDINGS_JSON}

At the end, output only this table (no section headings, no summary):

| # | Location | Finding | Decision | Verification | Notes |
|---|---|---|---|---|---|`;

const REVIEW_FOCUS_NAMES = Object.keys(REVIEW_FOCUSES) as FocusName[];

// --- Helpers ---

const runtimeState = {
	activeReviewRuns: new Set<string>(),
	activeReviewCancels: new Map<string, () => void>(),
	activePromptCount: 0,
};

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, type);
}

function getReviewSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `session:${ctx.sessionManager.getSessionId()}`;
}

async function withSpinner<T>(
	ctx: ExtensionContext,
	buildStatusText: () => string,
	run: () => Promise<T>,
): Promise<T> {
	if (!ctx.hasUI) return run();

	let frame = 0;
	const render = () => {
		const spinner = STATUS_SPINNER_FRAMES[frame % STATUS_SPINNER_FRAMES.length];
		ctx.ui.setStatus(STATUS_KEY, `${spinner} ${buildStatusText()}`);
	};

	render();
	const timer = setInterval(() => {
		frame = (frame + 1) % STATUS_SPINNER_FRAMES.length;
		render();
	}, STATUS_SPINNER_INTERVAL_MS);

	try {
		return await run();
	} finally {
		clearInterval(timer);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}


function priorityRank(priority: Priority): number {
	return priority.charCodeAt(1) - 48; // '0' = 48
}

function hashString(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function withJitter(baseMs: number): number {
	const range = Math.max(0, Math.floor(baseMs * REVIEW_STARTUP_RETRY_JITTER_RATIO));
	if (range === 0) return baseMs;
	const offset = Math.floor((Math.random() * (range * 2 + 1)) - range);
	return Math.max(0, baseMs + offset);
}

// --- Command parsing ---

function isHelpRequest(args: string | undefined): boolean {
	const tokens = tokenizeArgs(args?.trim() ?? "");
	if (tokens.length === 0) return false;
	const first = unquoteToken(tokens[0]).toLowerCase();
	return first === "help";
}

function getReviewArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
	const trimmed = prefix.trim().toLowerCase();
	if (trimmed.includes(" ")) return null;

	const matches = REVIEW_MODE_HINTS.filter((value) => value.startsWith(trimmed));
	if (matches.length === 0) return null;
	return matches.map((value) => ({ value, label: value }));
}

function showReviewHelp(pi: ExtensionAPI) {
	pi.sendMessage({
		customType: "review-help",
		display: true,
		details: { version: 1 },
		content: `## /review help

Run findings-only code review in 4 parallel focuses (general, reuse, quality, efficiency).

### Syntax
- \`/review [mode] [models=<a,b>] [context=<text>]\`
- \`/fix [mode] [models=<a,b>] [context=<text>]\`

### Modes
- \`auto\` (default): working tree first, then branch diff vs base branch.
- \`uncommitted\`: review tracked + untracked local changes.
- \`branch <name>\`: review diff from merge-base(name)..HEAD.
- \`commit <sha>\`: review one commit.
- \`pr <number|url>\`: checkout PR branch and review against PR base.
- \`folder <paths...>\`: snapshot review of files/folders (no git diff).
- \`custom "<instructions>"\`: custom scoped review instructions.

### Options
- \`models=<a,b>\`: run all review focuses for each listed model.
- \`context=<text>\`: add extra guidance to every review focus.
  - For spaces, quote the value, e.g. \`context="security and backpressure"\`.

### Examples
- \`/review\`
- \`/review help\`
- \`/review branch main\`
- \`/review pr 123 models=sonnet,gpt-5\`
- \`/review uncommitted context="security and error handling"\`
- \`/fix\`
- \`/fix help\`
- \`/fix branch main models=sonnet\`

### /fix behavior
- Uses only the latest \`customType: "review"\` message payload.
- If payload is missing or stale, runs a fresh \`/review\` first.
- Skips execution when there are zero findings.`,
	});
}

function tokenizeArgs(input: string): string[] {
	return input.match(/[^\s"'=]+=(?:"[^"]*"|'[^']*')|"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquoteToken(token: string): string {
	const quoted = token.match(/^(['"])([\s\S]*)\1$/);
	if (!quoted) return token;
	return quoted[2] ?? "";
}

function parseKeyValueOption(token: string, key: "models" | "model" | "context"): string | undefined {
	const pattern = new RegExp(`^${key}=(?:\"([\\s\\S]*)\"|'([\\s\\S]*)'|(\\S+))$`);
	const match = token.match(pattern);
	if (!match) return undefined;
	const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
	return value;
}

function parseRequestArgs(args: string | undefined): ParsedRequest {
	const raw = args?.trim() ?? "";
	if (!raw) {
		return { target: { type: "auto" }, mode: "auto", models: [], rawArgs: raw };
	}

	const tokens = tokenizeArgs(raw);
	const rawModels: string[] = [];
	const rawContext: string[] = [];
	const modeTokens: string[] = [];

	for (const token of tokens) {
		const modelsValue = parseKeyValueOption(token, "models") ?? parseKeyValueOption(token, "model");
		if (modelsValue !== undefined) {
			if (!modelsValue) continue;
			for (const model of modelsValue.split(",")) {
				const trimmed = model.trim();
				if (trimmed) rawModels.push(trimmed);
			}
			continue;
		}

		const contextValue = parseKeyValueOption(token, "context");
		if (contextValue !== undefined) {
			if (contextValue) rawContext.push(contextValue);
			continue;
		}

		modeTokens.push(unquoteToken(token));
	}

	const models = Array.from(new Set(rawModels));
	const additionalContextJoined = rawContext.map((c) => c.trim()).filter(Boolean).join("\n\n");
	const additionalContext = additionalContextJoined.length > 0 ? additionalContextJoined : undefined;
	const toMode = (target: ReviewTarget): ReviewRequestMode => {
		switch (target.type) {
			case "auto": return "auto";
			case "uncommitted": return "uncommitted";
			case "branch": return `branch:${target.branch}`;
			case "commit": return `commit:${target.sha}`;
			case "pr": return `pr:${target.ref}`;
			case "folder": return `folder:${target.paths.join(",")}`;
			case "custom": return "custom";
		}
	};
	const withMeta = (target: ReviewTarget): ParsedRequest => ({
		target,
		mode: toMode(target),
		models,
		rawArgs: raw,
		additionalContext,
	});

	if (modeTokens.length === 0) {
		return withMeta({ type: "auto" });
	}

	const mode = modeTokens[0].toLowerCase();
	const rest = modeTokens.slice(1);

	if (mode === "auto" || mode === "uncommitted") {
		if (rest.length > 0) throw new Error(`${mode} mode does not accept positional args. Use models=... and/or context=...`);
		return withMeta({ type: mode });
	}

	if (mode === "branch" || mode === "commit" || mode === "pr") {
		if (!rest[0]) {
			if (mode === "branch") throw new Error("branch mode requires a branch name (e.g. /review branch main)");
			if (mode === "commit") throw new Error("commit mode requires a commit SHA (e.g. /review commit abc1234)");
			throw new Error("pr mode requires a PR number or URL (e.g. /review pr 123)");
		}
		if (rest.length > 1) {
			const valueLabel = mode === "branch" ? "branch name" : mode === "commit" ? "SHA" : "reference";
			throw new Error(`${mode} mode accepts one ${valueLabel}. Use models=... and/or context=... for options.`);
		}

		if (mode === "branch") return withMeta({ type: "branch", branch: rest[0] });
		if (mode === "commit") return withMeta({ type: "commit", sha: rest[0] });
		return withMeta({ type: "pr", ref: rest[0] });
	}
	if (mode === "folder") {
		if (rest.length === 0) throw new Error("folder mode requires at least one path (e.g. /review folder src docs)");
		return withMeta({ type: "folder", paths: rest.map((p) => p.trim()).filter(Boolean) });
	}
	if (mode === "custom") {
		const instructions = rest.join(" ").trim();
		if (!instructions) throw new Error("custom mode requires instructions (e.g. /review custom \"focus on auth\")");
		return withMeta({ type: "custom", instructions });
	}

	throw new Error(
		`Unknown mode "${mode}". Supported modes: auto, uncommitted, branch, commit, pr, folder, custom.`,
	);
}

// --- Git & fingerprinting ---

async function runGit(pi: ExtensionAPI, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	const { stdout, stderr, code } = await pi.exec("git", args);
	return { stdout, stderr, code };
}

async function isGitRepo(pi: ExtensionAPI): Promise<boolean> {
	const result = await runGit(pi, ["rev-parse", "--git-dir"]);
	return result.code === 0;
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await runGit(pi, ["branch", "--show-current"]);
	if (code !== 0) return null;
	const branch = stdout.trim();
	return branch.length > 0 ? branch : null;
}

async function resolveHeadSha(pi: ExtensionAPI): Promise<string | null> {
	const { code, stdout } = await runGit(pi, ["rev-parse", "--verify", "HEAD"]);
	if (code !== 0) return null;
	const sha = stdout.trim();
	return sha.length > 0 ? sha : null;
}

async function hasHeadCommit(pi: ExtensionAPI): Promise<boolean> {
	return (await resolveHeadSha(pi)) !== null;
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const remoteHead = await runGit(pi, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
		return remoteHead.stdout.trim().replace(/^origin\//, "");
	}

	const branches = await runGit(pi, ["branch", "--format=%(refname:short)"]);
	if (branches.code === 0) {
		const names = parseGitFileList(branches.stdout);
		if (names.includes("main")) return "main";
		if (names.includes("master")) return "master";
		if (names.length > 0) return names[0];
	}

	return "main";
}

async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	const { stdout, code } = await runGit(pi, ["merge-base", "HEAD", branch]);
	if (code !== 0) return null;
	const sha = stdout.trim();
	return sha.length > 0 ? sha : null;
}

function parseGitFileList(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function getTrackedChangedFiles(pi: ExtensionAPI, hasHead?: boolean): Promise<string[]> {
	const headAvailable = hasHead ?? (await hasHeadCommit(pi));
	if (!headAvailable) {
		const [staged, unstaged] = await Promise.all([
			runGit(pi, ["diff", "--cached", "--name-only"]),
			runGit(pi, ["diff", "--name-only"]),
		]);

		const files = new Set<string>([
			...(staged.code === 0 ? parseGitFileList(staged.stdout) : []),
			...(unstaged.code === 0 ? parseGitFileList(unstaged.stdout) : []),
		]);
		return Array.from(files).sort((a, b) => a.localeCompare(b));
	}

	const { stdout, code } = await runGit(pi, ["diff", "HEAD", "--name-only"]);
	if (code !== 0) return [];
	return parseGitFileList(stdout);
}

async function getUntrackedFiles(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await runGit(pi, ["ls-files", "--others", "--exclude-standard"]);
	if (code !== 0) return [];
	return parseGitFileList(stdout);
}

async function getDiffFilesInRange(pi: ExtensionAPI, range: string): Promise<string[]> {
	const { stdout, code } = await runGit(pi, ["diff", "--name-only", range]);
	if (code !== 0) return [];
	return parseGitFileList(stdout);
}

async function hasPendingTrackedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await runGit(pi, ["status", "--porcelain"]);
	if (code !== 0) return false;
	const lines = stdout.split("\n").filter((line) => line.length > 0);
	return lines.some((line) => !line.startsWith("??"));
}

function parsePrReference(ref: string): number | null {
	const trimmed = ref.trim();
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

	const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
	if (!urlMatch?.[1]) return null;
	return Number.parseInt(urlMatch[1], 10);
}

async function getPrInfo(pi: ExtensionAPI, prNumber: number): Promise<{ baseBranch: string; headBranch: string } | null> {
	const { stdout, code } = await pi.exec("gh", ["pr", "view", String(prNumber), "--json", "baseRefName,headRefName"]);
	if (code !== 0) return null;
	try {
		const data = JSON.parse(stdout);
		if (
			typeof data?.baseRefName === "string" &&
			typeof data?.headRefName === "string"
		) {
			return {
				baseBranch: data.baseRefName,
				headBranch: data.headRefName,
			};
		}
		return null;
	} catch {
		return null;
	}
}

async function checkoutPr(pi: ExtensionAPI, prNumber: number): Promise<{ ok: boolean; error?: string }> {
	const { stdout, stderr, code } = await pi.exec("gh", ["pr", "checkout", String(prNumber)]);
	if (code !== 0) {
		return { ok: false, error: (stderr || stdout || "Failed to checkout PR").trim() };
	}
	return { ok: true };
}

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			try {
				const content = await fs.readFile(guidelinesPath, "utf8");
				const trimmed = content.trim();
				return trimmed.length > 0 ? trimmed : null;
			} catch {
				return null;
			}
		}

		const parent = path.dirname(currentDir);
		if (parent === currentDir) return null;
		currentDir = parent;
	}
}

async function hashGitDiff(pi: ExtensionAPI): Promise<string> {
	const head = await runGit(pi, ["diff", "--no-ext-diff", "HEAD"]);
	if (head.code === 0) return hashString(head.stdout);

	const [staged, unstaged] = await Promise.all([
		runGit(pi, ["diff", "--no-ext-diff", "--cached"]),
		runGit(pi, ["diff", "--no-ext-diff"]),
	]);
	const stagedHash = staged.code === 0 ? hashString(staged.stdout) : null;
	const unstagedHash = unstaged.code === 0 ? hashString(unstaged.stdout) : null;
	if (!stagedHash && !unstagedHash) return hashString("");
	return hashString(`${stagedHash ?? ""}\n${unstagedHash ?? ""}`);
}

async function computeUntrackedContentHash(
	pi: ExtensionAPI,
	cwd: string,
	precomputedUntrackedFiles?: string[],
): Promise<string> {
	const untrackedFiles = [...(precomputedUntrackedFiles ?? (await getUntrackedFiles(pi)))].sort((a, b) =>
		a.localeCompare(b),
	);
	if (untrackedFiles.length === 0) return hashString("");

	const hashes = await hashObjectBatch(cwd, untrackedFiles);
	const entries = untrackedFiles.map((file, i) => `${file}\0${hashes[i] ?? "missing"}`);
	return hashString(entries.join("\n"));
}

function hashObjectBatch(cwd: string, files: string[]): Promise<string[]> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["hash-object", "--stdin-paths"], {
			cwd,
			stdio: ["pipe", "pipe", "ignore"],
		});
		let stdout = "";
		proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		proc.on("error", () => resolve([]));
		proc.on("close", (code) => {
			resolve(code === 0 ? stdout.trim().split("\n") : []);
		});
		proc.stdin.on("error", () => { /* ignore broken pipe */ });
		proc.stdin.end(files.join("\n"));
	});
}

async function computeCurrentFingerprint(
	pi: ExtensionAPI,
	cwd: string,
	includeUntracked: boolean,
	precomputedUntrackedFiles?: string[],
): Promise<ReviewFingerprint> {
	const [headSha, branch, trackedDiffHash, untrackedHash] = await Promise.all([
		resolveHeadSha(pi).then((sha) => sha ?? ""),
		getCurrentBranch(pi).then((branch) => branch ?? ""),
		hashGitDiff(pi),
		includeUntracked
			? computeUntrackedContentHash(pi, cwd, precomputedUntrackedFiles)
			: Promise.resolve(REVIEW_UNTRACKED_HASH_DISABLED),
	]);

	return { headSha, branch, trackedDiffHash, untrackedHash };
}

function fingerprintsEqual(a: ReviewFingerprint, b: ReviewFingerprint): boolean {
	return (
		a.headSha === b.headSha &&
		a.branch === b.branch &&
		a.trackedDiffHash === b.trackedDiffHash &&
		a.untrackedHash === b.untrackedHash
	);
}

// --- Scope resolution ---

type BranchDiffScopeOptions = {
	baseBranch: string;
	description: (diffFileCount: number) => string;
	mergeBaseError: string;
	emptyDiffError: string;
};

async function resolveBranchDiffScope(
	pi: ExtensionAPI,
	options: BranchDiffScopeOptions,
): Promise<{ scope?: ResolvedScope; error?: string }> {
	const mergeBase = await getMergeBase(pi, options.baseBranch);
	if (!mergeBase) {
		return { error: options.mergeBaseError };
	}

	const range = `${mergeBase}..HEAD`;
	const diffFiles = await getDiffFilesInRange(pi, range);
	if (diffFiles.length === 0) {
		return { error: options.emptyDiffError };
	}

	return {
		scope: {
			kind: "branch-diff",
			baseBranch: options.baseBranch,
			mergeBase,
			diffFiles,
			description: options.description(diffFiles.length),
		},
	};
}

async function resolveScope(pi: ExtensionAPI, ctx: ExtensionContext, target: ReviewTarget): Promise<{ scope?: ResolvedScope; error?: string }> {
	switch (target.type) {
		case "auto":
		case "uncommitted": {
			const untrackedPromise = getUntrackedFiles(pi);
			const headSha = await resolveHeadSha(pi);
			const hasHead = headSha !== null;
			const [trackedFiles, untrackedFiles] = await Promise.all([
				getTrackedChangedFiles(pi, hasHead),
				untrackedPromise,
			]);
			if (trackedFiles.length > 0 || untrackedFiles.length > 0) {
				return {
					scope: {
						kind: "working-tree",
						trackedFiles,
						untrackedFiles,
						hasHead,
						description: `working tree (tracked: ${trackedFiles.length}, untracked: ${untrackedFiles.length})`,
					},
				};
			}

			if (target.type === "uncommitted") {
				return { error: "No uncommitted changes to review." };
			}

			const baseBranch = await getDefaultBranch(pi);
			return resolveBranchDiffScope(pi, {
				baseBranch,
				description: (diffFileCount) => `branch diff vs ${baseBranch} (${diffFileCount} files)`,
				mergeBaseError: `Could not determine merge-base against ${baseBranch}`,
				emptyDiffError: `No reviewable changes found (clean working tree and no branch diff vs ${baseBranch}). Use an explicit mode (branch/commit/pr/folder/custom).`,
			});
		}
		case "branch": {
			return resolveBranchDiffScope(pi, {
				baseBranch: target.branch,
				description: (diffFileCount) => `branch diff vs ${target.branch} (${diffFileCount} files)`,
				mergeBaseError: `Could not determine merge-base against ${target.branch}`,
				emptyDiffError: `No differences found against branch ${target.branch}.`,
			});
		}
		case "commit": {
			return {
				scope: {
					kind: "commit",
					sha: target.sha,
					description: `commit ${target.sha}`,
				},
			};
		}
		case "pr": {
			if (await hasPendingTrackedChanges(pi)) {
				return { error: "Cannot checkout PR with pending tracked changes. Commit or stash first." };
			}

			const prNumber = parsePrReference(target.ref);
			if (!prNumber) {
				return { error: `Invalid PR reference: ${target.ref}` };
			}

			notify(ctx, `Fetching PR #${prNumber} information...`, "info");
			const prInfo = await getPrInfo(pi, prNumber);
			if (!prInfo) {
				return { error: `Could not load PR #${prNumber}. Ensure gh is authenticated and PR exists.` };
			}

			if (await hasPendingTrackedChanges(pi)) {
				return { error: "Cannot checkout PR with pending tracked changes. Commit or stash first." };
			}

			notify(ctx, `Checking out PR #${prNumber}...`, "info");
			const checkout = await checkoutPr(pi, prNumber);
			if (!checkout.ok) {
				return { error: `Failed to checkout PR #${prNumber}: ${checkout.error ?? "unknown error"}` };
			}
			notify(ctx, `Checked out PR #${prNumber} (${prInfo.headBranch}).`, "info");

			return resolveBranchDiffScope(pi, {
				baseBranch: prInfo.baseBranch,
				description: (diffFileCount) => `PR #${prNumber} diff vs ${prInfo.baseBranch} (${diffFileCount} files)`,
				mergeBaseError: `Could not determine merge-base against PR base branch ${prInfo.baseBranch}.`,
				emptyDiffError: `No differences found for PR #${prNumber} against ${prInfo.baseBranch}.`,
			});
		}
		case "folder": {
			if (target.paths.length === 0) return { error: "No folder/file paths provided." };
			return {
				scope: {
					kind: "folder",
					paths: target.paths,
					description: `snapshot review for ${target.paths.join(", ")}`,
				},
			};
		}
		case "custom": {
			if (!target.instructions.trim()) return { error: "Custom instructions are empty." };
			return {
				scope: {
					kind: "custom",
					instructions: target.instructions.trim(),
					description: "custom review instructions",
				},
			};
		}
	}
}

function buildScopeInstructions(scope: ResolvedScope): string {
	switch (scope.kind) {
		case "working-tree": {
			const trackedCommand = scope.hasHead
				? "`git diff HEAD`"
				: "`git diff --cached` and `git diff`";
			const tracked =
				scope.trackedFiles.length > 0
					? `- First capture the full tracked diff with: ${trackedCommand} (treat this diff as mandatory review context).\n- Tracked files (${scope.trackedFiles.length}):\n${scope.trackedFiles.map((f) => `  - ${f}`).join("\n")}`
					: "- There are no tracked-file diffs.";
			const untracked =
				scope.untrackedFiles.length > 0
					? `- Also review untracked files as snapshots by reading them directly.\n- Untracked files (${scope.untrackedFiles.length}):\n${scope.untrackedFiles.map((f) => `  - ${f}`).join("\n")}`
					: "- There are no untracked files.";
			return `Scope: working tree review.\n${tracked}\n${untracked}`;
		}
		case "branch-diff": {
			return `Scope: branch diff review against base branch ${scope.baseBranch}.\n- Merge base: ${scope.mergeBase}\n- First capture the full diff with: \`git diff ${scope.mergeBase}..HEAD\` (treat this diff as mandatory review context).\n- Files in diff (${scope.diffFiles.length}):\n${scope.diffFiles.map((f) => `  - ${f}`).join("\n")}`;
		}
		case "commit": {
			return `Scope: commit review for ${scope.sha}.\n- First capture the full commit patch with: \`git show --stat --patch ${scope.sha}\` (treat this patch as mandatory review context).\n- Focus only on changes introduced by this commit.`;
		}
		case "folder": {
			return `Scope: snapshot review of selected paths (not a diff).\n- Paths:\n${scope.paths
				.map((p) => `  - ${p}`)
				.join("\n")}\n- Read files directly from these paths and review what exists currently.`;
		}
		case "custom": {
			return `Scope: custom review instructions.\n- Additional user instruction: ${scope.instructions}`;
		}
	}
}

function buildFocusPrompt(
	focus: FocusName,
	scopeInstructions: string,
	projectGuidelines: string | null,
	additionalContext: string | undefined,
): string {
	const additionalContextSection = additionalContext?.trim()
		? REVIEW_ADDITIONAL_CONTEXT_SECTION_PROMPT.replace("{ADDITIONAL_CONTEXT}", () => additionalContext.trim())
		: "";
	const projectGuidelinesSection = projectGuidelines
		? REVIEW_PROJECT_GUIDELINES_SECTION_PROMPT.replace("{PROJECT_GUIDELINES}", () => projectGuidelines)
		: "";

	const def = REVIEW_FOCUSES[focus];

	return REVIEW_FOCUS_PROMPT
		.replace("{FOCUS_SUFFIX}", () => def.suffix)
		.replace("{FOCUS_QUALIFIER}", () => def.qualifier)
		.replace("{SCOPE_INSTRUCTIONS}", () => scopeInstructions)
		.replace("{FOCUS_CONTEXT}", () => def.context)
		.replace("{ADDITIONAL_CONTEXT_SECTION}", () => additionalContextSection)
		.replace("{PROJECT_GUIDELINES_SECTION}", () => projectGuidelinesSection)
		.replace("{OUTPUT_CONTRACT}", () => REVIEW_JSON_OUTPUT_CONTRACT_PROMPT);
}

// --- Focus task execution ---

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (typeof item !== "object" || item === null) return "";
			if (!("type" in item) || item.type !== "text") return "";
			if (!("text" in item) || typeof item.text !== "string") return "";
			return item.text;
		})
		.filter(Boolean)
		.join("\n");
}

function extractAssistantTextFromEvent(event: unknown): string {
	if (!event || typeof event !== "object") return "";
	// In pi --mode json, message_end contains the complete assistant message content.
	if (!("type" in event) || event.type !== "message_end") return "";
	if (!("message" in event) || !event.message || typeof event.message !== "object") return "";
	const message = event.message;
	if (!("role" in message) || message.role !== "assistant") return "";
	if (!("content" in message)) return "";
	return extractTextContent(message.content);
}

function parsePossiblyWrappedJson(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("Empty output");

	const codeFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = codeFenceMatch?.[1]?.trim() || trimmed;

	try {
		return JSON.parse(candidate);
	} catch {
		const firstBrace = candidate.indexOf("{");
		const lastBrace = candidate.lastIndexOf("}");
		if (firstBrace >= 0 && lastBrace > firstBrace) {
			const sliced = candidate.slice(firstBrace, lastBrace + 1);
			return JSON.parse(sliced);
		}
		throw new Error("Output is not valid JSON");
	}
}

function validateFocusOutput(parsed: unknown): FocusFinding[] {
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Focus output must be a JSON object.");
	}

	if (!("findings" in parsed) || !Array.isArray(parsed.findings)) {
		throw new Error('Focus output is missing required "findings" array.');
	}

	const findings: FocusFinding[] = [];
	for (const finding of parsed.findings) {
		if (typeof finding !== "object" || finding === null) continue;
		const rec = finding as Record<string, unknown>;
		const priority = String(rec.priority ?? "").toUpperCase().match(/^P[0-3]$/)?.[0] ?? "";
		const location = String(rec.location ?? "").trim();
		const findingText = String(rec.finding ?? "").trim();
		const fixSuggestion = String(rec.fix_suggestion ?? "").trim();
		if (!priority || !location || !findingText || !fixSuggestion) continue;
		findings.push({ priority: priority as Priority, location, finding: findingText, fix_suggestion: fixSuggestion });
	}

	if (findings.length === 0 && parsed.findings.length > 0) {
		throw new Error("All findings in focus output are malformed.");
	}
	return findings;
}

// These classifiers intentionally rely on current pi CLI stderr wording.
// If stderr text changes upstream, retry behavior may need to be updated.
function classifyFocusError(errorText: string): { errorKind: FocusTaskErrorKind; missingApiProvider?: string } {
	if (/Lock file is already being held/i.test(errorText)) {
		return { errorKind: "lock_contention" };
	}

	const apiKeyMatch = errorText.match(/No API key found for\s+([\w.-]+)/i);
	if (apiKeyMatch?.[1]) {
		return { errorKind: "missing_api_key", missingApiProvider: apiKeyMatch[1] };
	}

	if (/No models match pattern/i.test(errorText)) {
		return { errorKind: "model_not_found" };
	}

	return { errorKind: "other" };
}

function createCancelledFocusResult(task: FocusTask): FocusTaskResult {
	return {
		focus: task.focus,
		model: task.modelLabel,
		ok: false,
		error: REVIEW_CANCELLED_ERROR,
		errorKind: "other",
	};
}


async function runPiJsonTask({
	args,
	prompt,
	cwd,
	timeoutMs,
	control,
}: PiJsonTaskOptions): Promise<PiJsonTaskResult> {
	if (control?.isCancelled()) {
		return {
			status: "cancelled",
			assistantOutput: "",
			stderr: "",
		};
	}

	return new Promise<PiJsonTaskResult>((resolve) => {
		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		const unregisterProcess = control?.registerProcess(proc);

		let stdoutBuffer = "";
		let latestAssistantOutput = "";
		let stderr = "";
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: PiJsonTaskResult) => {
			if (settled) return;
			settled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = undefined;
			}
			unregisterProcess?.();
			resolve(result);
		};

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const event = JSON.parse(trimmed);
				const text = extractAssistantTextFromEvent(event);
				if (text) latestAssistantOutput = text;
			} catch {
				// Ignore non-JSON lines.
			}
		};

		if (control?.isCancelled()) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Best effort.
			}
			finish({
				status: "cancelled",
				assistantOutput: latestAssistantOutput,
				stderr,
			});
			return;
		}

		proc.stdin.on("error", () => {
			// Ignore broken pipe errors if process exits early.
		});

		try {
			proc.stdin.end(prompt);
		} catch {
			// Best effort; close/error handlers will resolve.
		}

		timeoutId = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Best effort.
			}
			finish({
				status: "timeout",
				assistantOutput: latestAssistantOutput,
				stderr,
			});
		}, timeoutMs);

		proc.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("error", (error) => {
			finish({
				status: "spawn_error",
				assistantOutput: latestAssistantOutput,
				stderr,
				error: error.message,
			});
		});

		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) {
				processLine(stdoutBuffer);
			}

			if ((code ?? 1) !== 0) {
				finish({
					status: "non_zero_exit",
					assistantOutput: latestAssistantOutput,
					stderr,
					exitCode: code ?? 1,
				});
				return;
			}

			finish({
				status: "ok",
				assistantOutput: latestAssistantOutput,
				stderr,
				exitCode: 0,
			});
		});
	});
}

async function runFocusTaskAttempt(task: FocusTask, cwd: string, control?: ReviewExecutionControl): Promise<FocusTaskResult> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--tools",
		REVIEW_FOCUS_TOOLS,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
	];
	if (task.modelArg) {
		args.push("--model", task.modelArg, "--models", task.modelArg);
	}

	const taskResult = await runPiJsonTask({
		args,
		prompt: task.prompt,
		cwd,
		timeoutMs: REVIEW_TASK_TIMEOUT_MS,
		control,
	});

	if (taskResult.status === "cancelled") {
		return createCancelledFocusResult(task);
	}

	if (taskResult.status === "timeout") {
		return {
			focus: task.focus,
			model: task.modelLabel,
			ok: false,
			error: "Review timed out after 20 minutes.",
			errorKind: "other",
		};
	}

	if (taskResult.status === "spawn_error") {
		const error = `Failed to start focus process: ${taskResult.error ?? "unknown error"}`;
		return {
			focus: task.focus,
			model: task.modelLabel,
			ok: false,
			error,
			...classifyFocusError(error),
		};
	}

	if (taskResult.status === "non_zero_exit") {
		const stderr = taskResult.stderr.trim();
		const error = `Focus exited with code ${taskResult.exitCode ?? 1}${stderr ? `: ${stderr}` : ""}`;
		return {
			focus: task.focus,
			model: task.modelLabel,
			ok: false,
			error,
			...classifyFocusError(`${taskResult.stderr}\n${error}`),
		};
	}

	const assistantOutput = taskResult.assistantOutput;
	if (!assistantOutput.trim()) {
		return {
			focus: task.focus,
			model: task.modelLabel,
			ok: false,
			error: "Focus returned no assistant output.",
			errorKind: "other",
		};
	}

	try {
		const parsed = parsePossiblyWrappedJson(assistantOutput);
		const findings = validateFocusOutput(parsed);
		return {
			focus: task.focus,
			model: task.modelLabel,
			ok: true,
			output: { focus: task.focus, model: task.modelLabel, findings },
		};
	} catch (error) {
		return {
			focus: task.focus,
			model: task.modelLabel,
			ok: false,
			error: `Focus output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			errorKind: "other",
		};
	}
}


async function runFocusTask(task: FocusTask, cwd: string, control?: ReviewExecutionControl): Promise<FocusTaskResult> {
	if (control?.isCancelled()) {
		return createCancelledFocusResult(task);
	}

	for (let attempt = 0; ; attempt += 1) {
		const result = await runFocusTaskAttempt(task, cwd, control);
		if (result.ok || attempt >= REVIEW_STARTUP_RETRY_DELAYS_MS.length) return result;

		const retryable = result.errorKind === "lock_contention" || result.errorKind === "missing_api_key";
		if (!retryable) return result;
		if (control?.isCancelled()) return createCancelledFocusResult(task);

		const baseDelayMs =
			REVIEW_STARTUP_RETRY_DELAYS_MS[attempt] ??
			REVIEW_STARTUP_RETRY_DELAYS_MS[REVIEW_STARTUP_RETRY_DELAYS_MS.length - 1];
		await new Promise((resolve) => setTimeout(resolve, withJitter(baseDelayMs)));
	}
}

// --- Model resolution & output ---

function pickPreferredModelCandidate<T extends { id: string; provider: string }>(
	candidates: T[],
	currentProvider: string | undefined,
): T {
	const preferredProviderCandidates = currentProvider
		? candidates.filter((candidate) => candidate.provider.toLowerCase() === currentProvider.toLowerCase())
		: [];
	const pool = preferredProviderCandidates.length > 0 ? preferredProviderCandidates : candidates;

	const aliases = pool.filter((candidate) => candidate.id.endsWith("-latest") || !/-\d{8}$/.test(candidate.id));
	const ranked = (aliases.length > 0 ? aliases : pool).slice();
	ranked.sort((a, b) => b.id.localeCompare(a.id));
	return ranked[0];
}

function resolveUnqualifiedModelPattern(
	modelPattern: string,
	availableModels: Array<{ id: string; name?: string; provider: string }>,
	currentProvider: string | undefined,
): { modelArg: string; modelLabel: string } | undefined {
	const normalizedPattern = modelPattern.toLowerCase();
	const exactMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedPattern);
	const candidates =
		exactMatches.length > 0
			? exactMatches
			: availableModels.filter((model) => {
				const byId = model.id.toLowerCase().includes(normalizedPattern);
				const byName = model.name?.toLowerCase().includes(normalizedPattern) ?? false;
				return byId || byName;
			});
	if (candidates.length === 0) return undefined;

	const preferred = pickPreferredModelCandidate(candidates, currentProvider);
	return {
		modelArg: `${preferred.provider}/${preferred.id}`,
		modelLabel: modelPattern,
	};
}

async function resolveModels(
	ctx: ExtensionContext,
	requestedModels: string[],
): Promise<Array<{ modelArg: string | undefined; modelLabel: string }>> {
	const currentProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined;
	const currentModelId = ctx.model?.id;
	const availableModels = ctx.modelRegistry.getAvailable();

	const resolveRequestedModel = (modelPattern: string): { modelArg: string; modelLabel: string } => {
		const slash = modelPattern.indexOf("/");
		const explicitProvider = slash > 0 ? modelPattern.slice(0, slash).trim() : "";
		if (explicitProvider) {
			return { modelArg: modelPattern, modelLabel: modelPattern };
		}

		const hasWildcard = modelPattern.includes("*") || modelPattern.includes("?") || modelPattern.includes("[");
		if (!hasWildcard) {
			const resolved = resolveUnqualifiedModelPattern(modelPattern, availableModels, currentProvider);
			if (resolved) return resolved;
		}

		return {
			modelArg: modelPattern,
			modelLabel: modelPattern,
		};
	};

	if (requestedModels.length > 0) {
		return requestedModels.map(resolveRequestedModel);
	}

	const modelArg = currentModelId
		? currentProvider ? `${currentProvider}/${currentModelId}` : currentModelId
		: undefined;
	return [{ modelArg, modelLabel: currentModelId ?? "default" }];
}


function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);

	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (totalMinutes > 0) return `${totalMinutes}m${seconds}s`;
	return `${seconds}s`;
}

function buildReviewedScopeLine(scope: ResolvedScope, durationMs: number): string {
	const scopeText =
		scope.kind === "working-tree"
			? `working tree (${scope.trackedFiles.length} tracked, ${scope.untrackedFiles.length} untracked)`
			: scope.kind === "branch-diff"
				? `branch diff vs ${scope.baseBranch} (${scope.diffFiles.length} files)`
				: scope.kind === "commit"
					? `commit ${scope.sha}`
					: scope.kind === "folder"
						? `snapshot for ${scope.paths.join(", ")}`
						: "custom scope";
	return `Reviewed ${scopeText} in ${formatDuration(durationMs)}.`;
}

function buildReviewFindingsMarkdown(
	reviewedScopeLine: string,
	findings: ReviewReportFinding[],
	completedReviews: number,
	totalReviews: number,
): string {
	const reviewWord = totalReviews === 1 ? "review" : "reviews";
	const completionLine =
		completedReviews === totalReviews
			? `All ${totalReviews} ${reviewWord} completed`
			: `${completedReviews} of ${totalReviews} ${reviewWord} completed`;

	if (findings.length === 0) {
		return `${reviewedScopeLine}\n\n${completionLine}.\n\nNo findings.\n`;
	}

	let table = "| # | Focus | Model | Priority | Location | Finding | Fix suggestion |\n";
	table += "|---|---|---|---|---|---|---|\n";
	findings.forEach((finding, index) => {
		table += `| ${index + 1} | ${escapeCell(finding.focus)} | ${escapeCell(finding.model)} | ${escapeCell(
			finding.priority,
		)} | ${escapeCell(finding.location)} | ${escapeCell(finding.finding)} | ${escapeCell(finding.fix_suggestion)} |\n`;
	});
	return `${reviewedScopeLine}\n\n${completionLine}:\n\n${table}\n`;
}

function buildReviewFailuresMarkdown(failedFocuses: FocusTaskResult[]): string {
	const reviewWord = failedFocuses.length === 1 ? "review" : "reviews";
	let table = "| Focus | Model | Error |\n";
	table += "|---|---|---|\n";
	for (const focus of failedFocuses) {
		table += `| ${escapeCell(focus.focus)} | ${escapeCell(focus.model)} | ${escapeCell(focus.error ?? "Unknown failure")} |\n`;
	}
	return `${failedFocuses.length} ${reviewWord} failed:\n\n${table}\n`;
}

const SCOPE_MODES = new Set(["working-tree", "branch-diff", "commit", "folder", "custom"]);

function isScopeMode(value: unknown): value is ResolvedScope["kind"] {
	return typeof value === "string" && SCOPE_MODES.has(value);
}

const REQUEST_MODE_PREFIXES = ["branch:", "commit:", "pr:", "folder:"];

function isReviewRequestMode(value: unknown): value is ReviewRequestMode {
	if (typeof value !== "string") return false;
	if (value === "auto" || value === "uncommitted" || value === "custom") return true;
	return REQUEST_MODE_PREFIXES.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);
}

function parseReviewMessageDetails(value: unknown): ReviewMessageDetails | null {
	if (!value || typeof value !== "object") return null;
	const details = value as ReviewMessageDetails;
	if (details.kind !== "findings" || details.version !== 1) return null;
	if (!isReviewRequestMode(details.request?.mode)) return null;
	if (!isScopeMode(details.scope?.mode)) return null;
	if (
		!details.fingerprint ||
		typeof details.fingerprint !== "object" ||
		typeof details.fingerprint.headSha !== "string" ||
		typeof details.fingerprint.branch !== "string" ||
		typeof details.fingerprint.trackedDiffHash !== "string" ||
		typeof details.fingerprint.untrackedHash !== "string"
	) {
		return null;
	}
	if (!Array.isArray(details.focusStatus) || !Array.isArray(details.findings)) return null;
	return details;
}

function getLastReviewDetails(ctx: ExtensionContext): ReviewMessageDetails | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== "review") continue;

		const details = parseReviewMessageDetails(entry.details);
		if (!details) continue;

		return details;
	}

	return null;
}

// --- Review pipeline ---

function buildReviewTasks(
	scope: ResolvedScope,
	guidelines: string | null,
	additionalContext: string | undefined,
	models: Array<{ modelArg: string | undefined; modelLabel: string }>,
): FocusTask[] {
	const scopeInstructions = buildScopeInstructions(scope);
	const tasks: FocusTask[] = [];

	for (const model of models) {
		for (const focus of REVIEW_FOCUS_NAMES) {
			tasks.push({
				focus,
				modelArg: model.modelArg,
				modelLabel: model.modelLabel,
				prompt: buildFocusPrompt(focus, scopeInstructions, guidelines, additionalContext),
			});
		}
	}

	return tasks;
}

async function prepareReviewRun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	request: ParsedRequest,
): Promise<{ ok: false; error: string } | { ok: true; data: PreparedReviewRun }> {
	if (!(await isGitRepo(pi))) {
		return { ok: false, error: "Not a git repository." };
	}

	const resolved = await resolveScope(pi, ctx, request.target);
	if (!resolved.scope) {
		return { ok: false, error: resolved.error ?? "Failed to resolve review scope." };
	}

	const scope = resolved.scope;
	const includeUntracked = scope.kind === "working-tree" || scope.kind === "folder";
	const scopeUntrackedFiles = scope.kind === "working-tree" ? scope.untrackedFiles : undefined;
	const [baselineFingerprint, guidelines, models] = await Promise.all([
		computeCurrentFingerprint(pi, ctx.cwd, includeUntracked, scopeUntrackedFiles),
		loadProjectReviewGuidelines(ctx.cwd),
		resolveModels(ctx, request.models),
	]);

	return {
		ok: true,
		data: {
			scope,
			includeUntracked,
			baselineFingerprint,
			models,
			tasks: buildReviewTasks(scope, guidelines, request.additionalContext, models),
		},
	};
}

async function runFocusTasks(
	ctx: ExtensionCommandContext,
	cwd: string,
	tasks: FocusTask[],
	control: ReviewExecutionControl,
): Promise<FocusTaskResult[]> {
	let completed = 0;
	return withSpinner(
		ctx,
		() => `Reviewing (completed ${completed}/${tasks.length})`,
		() => Promise.all(tasks.map(async (task) => {
			try {
				if (control.isCancelled()) return createCancelledFocusResult(task);
				return await runFocusTask(task, cwd, control);
			} finally {
				completed = Math.min(tasks.length, completed + 1);
			}
		})),
	);
}

function parseLocationList(value: string): string[] {
	return Array.from(new Set(
		value
			.replace(/\s+(?:and|&)\s+/gi, ", ")
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	));
}

function normalizeSummaryText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function sortReviewFindings(findings: ReviewReportFinding[]): void {
	findings.sort((a, b) => {
		const prio = priorityRank(a.priority) - priorityRank(b.priority);
		if (prio !== 0) return prio;

		const locationCmp = a.location.localeCompare(b.location);
		if (locationCmp !== 0) return locationCmp;

		if (a.focus !== b.focus) return a.focus.localeCompare(b.focus);
		return a.model.localeCompare(b.model);
	});
}

function exactDedupKey(finding: ReviewReportFinding): string {
	const normalizedLocation = parseLocationList(finding.location).join(", ").toLowerCase();
	const normalizedFinding = normalizeSummaryText(finding.finding).toLowerCase();
	return `${normalizedLocation}\u0000${normalizedFinding}`;
}

function deduplicateExactFindings(findings: ReviewReportFinding[]): ReviewReportFinding[] {
	const groups = new Map<string, ReviewReportFinding[]>();
	for (const finding of findings) {
		const key = exactDedupKey(finding);
		const group = groups.get(key);
		if (group) {
			group.push(finding);
		} else {
			groups.set(key, [finding]);
		}
	}

	const result: ReviewReportFinding[] = [];
	for (const group of groups.values()) {
		const representative = group[0];
		if (group.length === 1) {
			result.push(representative);
			continue;
		}
		const focuses = Array.from(new Set(group.map((f) => f.focus))).join(", ");
		const models = Array.from(new Set(group.map((f) => f.model))).join(", ");
		const priorities = group.map((f) => f.priority).sort((a, b) => priorityRank(a) - priorityRank(b));
		const locations = Array.from(new Set(group.flatMap((f) => parseLocationList(f.location))));
		result.push({
			...representative,
			priority: priorities[0],
			location: locations.join(", "),
			focus: focuses,
			model: models,
		});
	}
	return result;
}

function buildReviewFindings(
	successfulFocuses: Array<FocusTaskResult & { output: FocusOutput }>,
): ReviewReportFinding[] {
	const rawFindings = successfulFocuses.flatMap((focus) =>
		focus.output.findings.map((finding) => ({
			...finding,
			focus: focus.focus,
			model: focus.model,
		})),
	);
	const findings = rawFindings.length > 1 ? deduplicateExactFindings(rawFindings) : rawFindings;

	sortReviewFindings(findings);
	return findings;
}


async function runReviewPipeline(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	request: ParsedRequest,
	source: ReviewRunSource,
): Promise<ReviewRunResult> {
	const sessionKey = getReviewSessionKey(ctx);
	const startedAtMs = Date.now();

	const activeFocusProcesses = new Set<ChildProcess>();
	let cancelRequested = false;
	let reviewOutcome: ReviewRunOutcome = "failed";

	const cancelActiveFocusProcesses = () => {
		for (const proc of activeFocusProcesses) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Best effort.
			}
		}
		activeFocusProcesses.clear();
	};

	const requestCancellation = () => {
		if (cancelRequested) return;
		cancelRequested = true;
		cancelActiveFocusProcesses();
	};

	const executionControl: ReviewExecutionControl = {
		isCancelled: () => cancelRequested,
		registerProcess: (proc) => {
			activeFocusProcesses.add(proc);
			return () => {
				activeFocusProcesses.delete(proc);
			};
		},
	};

	let unsubscribeInterrupt: (() => void) | undefined;
	let reviewStarted = false;

	try {
		const prepared = await prepareReviewRun(pi, ctx, request);
		if (!prepared.ok) {
			return { ok: false, error: prepared.error };
		}

		pi.events.emit(REVIEW_EVENT_START, { sessionKey, source });
		reviewStarted = true;
		runtimeState.activeReviewCancels.set(sessionKey, requestCancellation);
		unsubscribeInterrupt =
			ctx.hasUI
				? ctx.ui.onTerminalInput((data) => {
					if (!matchesKey(data, "escape")) return;
					if (runtimeState.activePromptCount > 0) return;
					requestCancellation();
				})
				: undefined;

		const { scope, includeUntracked, baselineFingerprint, models, tasks } = prepared.data;
		if (source === "review") {
			const modelsText = models.map((model) => model.modelArg ?? model.modelLabel).join(", ");
			notify(ctx, `Review focus: ${REVIEW_FOCUS_NAMES.join(", ")} · models: ${modelsText}.`, "info");
		}

		const focusResults = await runFocusTasks(ctx, ctx.cwd, tasks, executionControl);
		if (cancelRequested) {
			reviewOutcome = "cancelled";
			return { ok: false, error: REVIEW_CANCELLED_ERROR };
		}

		const failedFocuses = focusResults.filter((focus) => !focus.ok);
		const failedCount = failedFocuses.length;
		const totalReviews = focusResults.length;
		const completedReviews = totalReviews - failedCount;
		const successfulFocuses = focusResults.filter((result): result is FocusTaskResult & { output: FocusOutput } =>
			Boolean(result.ok && result.output),
		);
		if (successfulFocuses.length === 0) {
			if (failedCount > 0) {
				const reviewedScopeLine = buildReviewedScopeLine(scope, Date.now() - startedAtMs);
				const failureReport = `${reviewedScopeLine}\n\n${buildReviewFailuresMarkdown(failedFocuses)}`;
				pi.sendMessage(
					{
						customType: "review-errors",
						content: failureReport,
						display: true,
						details: { version: 1, failedCount, totalReviews },
					},
					{ deliverAs: "followUp" },
				);
			}

			const missingApiProvider = failedFocuses.find(
				(focus) => focus.errorKind === "missing_api_key" && Boolean(focus.missingApiProvider),
			)?.missingApiProvider;
			if (missingApiProvider) {
				return {
					ok: false,
					error: `All reviews failed. Missing API key for provider '${missingApiProvider}'. Use /login or configure credentials for that provider.`,
				};
			}

			const sampleError = focusResults.find((focus) => focus.error)?.error ?? "Unknown focus failure";
			return {
				ok: false,
				error: `All reviews failed. ${sampleError}`,
			};
		}

		const findings = buildReviewFindings(successfulFocuses);

		const endingFingerprint = await computeCurrentFingerprint(pi, ctx.cwd, includeUntracked);
		if (!fingerprintsEqual(baselineFingerprint, endingFingerprint)) {
			return {
				ok: false,
				error: "Review became stale while running (repository changed). Rerun /review.",
			};
		}

		if (cancelRequested) {
			reviewOutcome = "cancelled";
			return { ok: false, error: REVIEW_CANCELLED_ERROR };
		}

		if (failedCount > 0) {
			pi.sendMessage(
				{
					customType: "review-errors",
					content: buildReviewFailuresMarkdown(failedFocuses),
					display: true,
					details: { version: 1, failedCount, totalReviews },
				},
				{ deliverAs: "followUp" },
			);
		}

		const reviewedScopeLine = buildReviewedScopeLine(scope, Date.now() - startedAtMs);
		const findingsMarkdown = buildReviewFindingsMarkdown(
			reviewedScopeLine,
			findings,
			completedReviews,
			totalReviews,
		);
		const details: ReviewMessageDetails = {
			kind: "findings",
			version: 1,
			reviewId: randomUUID(),
			generatedAt: new Date().toISOString(),
			request: {
				mode: request.mode,
				models: models.map((model) => model.modelLabel),
				userArgs: request.rawArgs,
			},
			scope: {
				mode: scope.kind,
				description: scope.description,
			},
			fingerprint: endingFingerprint,
			focusStatus: focusResults.map((focus) => ({
				focus: focus.focus,
				model: focus.model,
				ok: focus.ok,
				error: focus.error,
			})),
			findings,
		};

		pi.sendMessage(
			{
				customType: "review",
				content: findingsMarkdown,
				display: true,
				details,
			},
			{ deliverAs: "followUp" },
		);

		if (failedCount > 0) {
			const failedLabel = `review${failedCount === 1 ? "" : "s"}`;
			notify(ctx, `Review completed with partial results: ${failedCount} ${failedLabel} failed.`, "warning");
		} else {
			notify(ctx, `Review completed: ${findings.length} finding(s).`, "info");
		}

		reviewOutcome = "success";
		return { ok: true, details };
	} finally {
		unsubscribeInterrupt?.();
		cancelActiveFocusProcesses();
		if (runtimeState.activeReviewCancels.get(sessionKey) === requestCancellation) {
			runtimeState.activeReviewCancels.delete(sessionKey);
		}
		if (reviewStarted) {
			pi.events.emit(REVIEW_EVENT_END, { sessionKey, source, outcome: reviewOutcome });
		}
	}
}

// --- Command handlers ---

function buildFixPrompt(reviewMessageDetails: ReviewMessageDetails): string {
	const worklistPayload = JSON.stringify(
		{
			review_id: reviewMessageDetails.reviewId,
			generated_at: reviewMessageDetails.generatedAt,
			scope: reviewMessageDetails.scope,
			findings: reviewMessageDetails.findings,
		},
		null,
		2,
	);

	return FIX_PROMPT.replace("{REVIEW_FINDINGS_JSON}", () => worklistPayload);
}

function parseCommandRequest(pi: ExtensionAPI, args: string | undefined, ctx: ExtensionCommandContext): ParsedRequest | null {
	if (isHelpRequest(args)) {
		showReviewHelp(pi);
		return null;
	}

	try {
		return parseRequestArgs(args);
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "error");
		return null;
	}
}

function acquireReviewRunLock(ctx: ExtensionContext, busyMessage: string): string | null {
	const sessionKey = getReviewSessionKey(ctx);
	if (runtimeState.activeReviewRuns.has(sessionKey)) {
		notify(ctx, busyMessage, "warning");
		return null;
	}

	runtimeState.activeReviewRuns.add(sessionKey);
	return sessionKey;
}

function releaseReviewRunLock(sessionKey: string): void {
	runtimeState.activeReviewRuns.delete(sessionKey);
}

export default function reviewExtension(pi: ExtensionAPI) {
	pi.events.on("ui:prompt_start", () => {
		runtimeState.activePromptCount += 1;
	});

	pi.events.on("ui:prompt_end", () => {
		runtimeState.activePromptCount = Math.max(0, runtimeState.activePromptCount - 1);
	});

	pi.on("session_switch", async (_event, ctx) => {
		const sessionKey = getReviewSessionKey(ctx);
		for (const [key, cancel] of runtimeState.activeReviewCancels) {
			if (key !== sessionKey) cancel();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionKey = getReviewSessionKey(ctx);
		runtimeState.activeReviewCancels.get(sessionKey)?.();
		runtimeState.activeReviewCancels.delete(sessionKey);
		runtimeState.activeReviewRuns.delete(sessionKey);
		runtimeState.activePromptCount = 0;
	});

	pi.registerCommand("review", {
		description:
			"Run findings-only review across 4 focuses (general/reuse/quality/efficiency). Use /review help for full usage.",
		getArgumentCompletions: getReviewArgumentCompletions,
		handler: async (args, ctx) => {
			const request = parseCommandRequest(pi, args, ctx);
			if (!request) return;

			const sessionKey = acquireReviewRunLock(ctx, "A /review run is already active in this session.");
			if (!sessionKey) return;

			notify(ctx, "Starting review in background...", "info");
			void (async () => {
				try {
					const result = await runReviewPipeline(pi, ctx, request, "review");
					if (!result.ok) {
						notify(ctx, result.error, "error");
					}
				} catch (error) {
					notify(ctx, `Review run failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				} finally {
					releaseReviewRunLock(sessionKey);
				}
			})();
		},
	});

	pi.registerCommand("fix", {
		description:
			"Fix findings from latest valid /review message. If missing/stale, runs review first then fixes. Use /review help for modes/options.",
		getArgumentCompletions: getReviewArgumentCompletions,
		handler: async (args, ctx) => {
			const request = parseCommandRequest(pi, args, ctx);
			if (!request) return;

			const sessionKey = acquireReviewRunLock(
				ctx,
				"A /review run is active in this session. Wait for it to finish before /fix.",
			);
			if (!sessionKey) return;

			try {
				const hasExplicitArgs = (args?.trim().length ?? 0) > 0;
				let reviewDetails: ReviewMessageDetails | null = null;
				let shouldRunFreshReview = hasExplicitArgs;

				if (!shouldRunFreshReview) {
					reviewDetails = getLastReviewDetails(ctx);
					if (!reviewDetails) {
						shouldRunFreshReview = true;
					} else {
						const includeUntracked =
							reviewDetails.scope.mode === "working-tree" ||
							reviewDetails.scope.mode === "folder";
						const currentFingerprint = await computeCurrentFingerprint(pi, ctx.cwd, includeUntracked);
						if (!fingerprintsEqual(reviewDetails.fingerprint, currentFingerprint)) {
							shouldRunFreshReview = true;
							notify(ctx, "Previous review is stale (repository changed). Running a fresh review.", "info");
						}
					}
				}

				if (shouldRunFreshReview) {
					const reviewResult = await runReviewPipeline(pi, ctx, request, "fix");
					if (!reviewResult.ok) {
						if (reviewResult.error === REVIEW_CANCELLED_ERROR) {
							notify(ctx, REVIEW_CANCELLED_ERROR, "error");
						} else {
							notify(ctx, `Cannot continue to /fix: ${reviewResult.error}`, "error");
						}
						return;
					}
					reviewDetails = reviewResult.details;
				}

				if (!reviewDetails) {
					notify(ctx, "No review payload available for fixing.", "error");
					return;
				}

				if (reviewDetails.findings.length === 0) {
					const failedFocusCount = reviewDetails.focusStatus.filter((focus) => !focus.ok).length;
					if (failedFocusCount > 0) {
						notify(
							ctx,
							`Latest review had ${failedFocusCount} failed focus run(s) and no findings. Rerun /review before /fix.`,
							"warning",
						);
						return;
					}

					notify(ctx, "Review produced no findings. Nothing to fix.", "info");
					return;
				}

				const fixPrompt = buildFixPrompt(reviewDetails);
				if (ctx.isIdle()) {
					pi.sendUserMessage(fixPrompt);
				} else {
					pi.sendUserMessage(fixPrompt, { deliverAs: "followUp" });
				}
				notify(ctx, "Queued autonomous fix pass from review findings.", "info");
			} finally {
				releaseReviewRunLock(sessionKey);
			}
		},
	});
}
