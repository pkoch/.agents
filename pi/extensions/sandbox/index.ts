/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show command help
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool } from "@mariozechner/pi-coding-agent";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

const STATUS_KEY = "sandbox";

type UiLevel = "info" | "warning" | "error";

type ListOp = "add" | "remove";
type NetworkList = "allow" | "deny";
type FilesystemList = "deny-read" | "allow-write" | "deny-write";

function clearSandboxStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function setSandboxEnabledStatus(ctx: ExtensionContext, runtimeConfig: SandboxRuntimeConfig): void {
	if (!ctx.hasUI) return;
	const networkCount = runtimeConfig.network?.allowedDomains?.length ?? 0;
	const writeCount = runtimeConfig.filesystem?.allowWrite?.length ?? 0;
	const text = `sandbox: enabled (${networkCount} domains, ${writeCount} write paths)`;
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
}

function notify(ctx: ExtensionContext, text: string, level: UiLevel = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}

	if (level === "error" || level === "warning") console.error(text);
	else console.log(text);
}

function showHelp(ctx: ExtensionContext): void {
	const lines = [
		"Usage:",
		"  /sandbox enable",
		"  /sandbox disable",
		"  /sandbox show",
		"  /sandbox reset",
		"  /sandbox network <allow|deny> <add|remove> <domain>",
		"  /sandbox filesystem <deny-read|allow-write|deny-write> <add|remove> <path>",
	];
	notify(ctx, lines.join("\n"), "info");
}

function parseCommandArgs(args?: string): string[] {
	if (!args?.trim()) return [];
	return args
		.trim()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");
	const globalConfigPath = join(homedir(), ".pi", "agent", "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}
	if (overrides.ignoreViolations) {
		result.ignoreViolations = overrides.ignoreViolations;
	}
	if (overrides.enableWeakerNestedSandbox !== undefined) {
		result.enableWeakerNestedSandbox = overrides.enableWeakerNestedSandbox;
	}
	if (overrides.enableWeakerNetworkIsolation !== undefined) {
		result.enableWeakerNetworkIsolation = overrides.enableWeakerNetworkIsolation;
	}

	return result;
}

function toRuntimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
	return {
		network: config.network,
		filesystem: config.filesystem,
		ignoreViolations: config.ignoreViolations,
		enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
		enableWeakerNetworkIsolation: config.enableWeakerNetworkIsolation,
	};
}

function cloneRuntimeConfig(config: SandboxRuntimeConfig): SandboxRuntimeConfig {
	return structuredClone(config);
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

function ensureRuntimeConfig(
	ctx: ExtensionContext,
	sandboxInitialized: boolean,
	runtimeConfig: SandboxRuntimeConfig | null,
): SandboxRuntimeConfig | null {
	if (!sandboxInitialized || !runtimeConfig) {
		notify(ctx, "Sandbox is not initialized", "info");
		return null;
	}
	return runtimeConfig;
}

function refreshSandboxStatus(ctx: ExtensionContext, enabled: boolean, runtimeConfig: SandboxRuntimeConfig): void {
	if (enabled) setSandboxEnabledStatus(ctx, runtimeConfig);
	else clearSandboxStatus(ctx);
}

function mutateStringList(values: string[], op: ListOp, value: string): boolean {
	if (op === "add") {
		if (values.includes(value)) return false;
		values.push(value);
		return true;
	}

	const index = values.indexOf(value);
	if (index === -1) return false;
	values.splice(index, 1);
	return true;
}

function getNetworkList(config: SandboxRuntimeConfig, list: NetworkList): string[] {
	return list === "allow" ? config.network.allowedDomains : config.network.deniedDomains;
}

function getFilesystemList(config: SandboxRuntimeConfig, list: FilesystemList): string[] {
	if (list === "deny-read") return config.filesystem.denyRead;
	if (list === "allow-write") return config.filesystem.allowWrite;
	return config.filesystem.denyWrite;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;
	let baseRuntimeConfig: SandboxRuntimeConfig | null = null;
	let activeRuntimeConfig: SandboxRuntimeConfig | null = null;

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		clearSandboxStatus(ctx);

		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			sandboxInitialized = false;
			baseRuntimeConfig = null;
			activeRuntimeConfig = null;
			notify(ctx, "Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			sandboxInitialized = false;
			baseRuntimeConfig = null;
			activeRuntimeConfig = null;
			notify(ctx, "Sandbox disabled via config", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			sandboxInitialized = false;
			baseRuntimeConfig = null;
			activeRuntimeConfig = null;
			notify(ctx, `Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			const runtimeConfig = toRuntimeConfig(config);
			await SandboxManager.initialize(runtimeConfig);

			sandboxEnabled = true;
			sandboxInitialized = true;
			baseRuntimeConfig = cloneRuntimeConfig(runtimeConfig);
			activeRuntimeConfig = cloneRuntimeConfig(runtimeConfig);

			setSandboxEnabledStatus(ctx, runtimeConfig);
			notify(ctx, "Sandbox initialized", "info");
		} catch (err) {
			sandboxEnabled = false;
			sandboxInitialized = false;
			baseRuntimeConfig = null;
			activeRuntimeConfig = null;
			clearSandboxStatus(ctx);
			notify(ctx, `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearSandboxStatus(ctx);
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
		sandboxEnabled = false;
		sandboxInitialized = false;
		baseRuntimeConfig = null;
		activeRuntimeConfig = null;
	});

	pi.registerCommand("sandbox", {
		description: "Manage sandbox runtime overrides",
		handler: async (args, ctx) => {
			const tokens = parseCommandArgs(args);
			const subcommand = tokens[0]?.toLowerCase();

			if (!subcommand || subcommand === "help") {
				showHelp(ctx);
				return;
			}

			if (subcommand === "enable") {
				if (tokens.length > 1) {
					notify(ctx, "Usage: /sandbox enable", "warning");
					return;
				}

				if (sandboxEnabled) {
					notify(ctx, "Sandbox is already enabled", "info");
					return;
				}

				if (!sandboxInitialized || !activeRuntimeConfig) {
					const platform = process.platform;
					if (platform !== "darwin" && platform !== "linux") {
						notify(ctx, `Sandbox not supported on ${platform}`, "warning");
						return;
					}

					try {
						const runtimeConfig = toRuntimeConfig(loadConfig(ctx.cwd));
						await SandboxManager.initialize(runtimeConfig);
						sandboxInitialized = true;
						baseRuntimeConfig = cloneRuntimeConfig(runtimeConfig);
						activeRuntimeConfig = cloneRuntimeConfig(runtimeConfig);
					} catch (err) {
						notify(ctx, `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
						return;
					}
				}

				const runtimeConfig = ensureRuntimeConfig(ctx, sandboxInitialized, activeRuntimeConfig);
				if (!runtimeConfig) return;

				sandboxEnabled = true;
				SandboxManager.updateConfig(runtimeConfig);
				refreshSandboxStatus(ctx, sandboxEnabled, runtimeConfig);
				notify(ctx, "Sandbox enabled for this session", "info");
				return;
			}

			if (subcommand === "disable") {
				if (tokens.length > 1) {
					notify(ctx, "Usage: /sandbox disable", "warning");
					return;
				}

				const runtimeConfig = ensureRuntimeConfig(ctx, sandboxInitialized, activeRuntimeConfig);
				if (!runtimeConfig) return;

				if (!sandboxEnabled) {
					notify(ctx, "Sandbox is already disabled", "info");
					return;
				}

				sandboxEnabled = false;
				refreshSandboxStatus(ctx, sandboxEnabled, runtimeConfig);
				notify(ctx, "Sandbox disabled for this session", "info");
				return;
			}

			if (subcommand === "show") {
				if (tokens.length > 1) {
					notify(ctx, "Usage: /sandbox show", "warning");
					return;
				}

				const runtimeConfig = ensureRuntimeConfig(ctx, sandboxInitialized, activeRuntimeConfig);
				if (!runtimeConfig) return;

				const lines = [
					"Sandbox Configuration (session):",
					`State: ${sandboxEnabled ? "enabled" : "disabled"}`,
					"",
					"Network:",
					`  Allowed: ${runtimeConfig.network.allowedDomains.join(", ") || "(none)"}`,
					`  Denied: ${runtimeConfig.network.deniedDomains.join(", ") || "(none)"}`,
					"",
					"Filesystem:",
					`  Deny Read: ${runtimeConfig.filesystem.denyRead.join(", ") || "(none)"}`,
					`  Allow Write: ${runtimeConfig.filesystem.allowWrite.join(", ") || "(none)"}`,
					`  Deny Write: ${runtimeConfig.filesystem.denyWrite.join(", ") || "(none)"}`,
				];
				notify(ctx, lines.join("\n"), "info");
				return;
			}

			if (subcommand === "reset") {
				if (tokens.length > 1) {
					notify(ctx, "Usage: /sandbox reset", "warning");
					return;
				}

				if (!ensureRuntimeConfig(ctx, sandboxInitialized, activeRuntimeConfig) || !baseRuntimeConfig) return;

				activeRuntimeConfig = cloneRuntimeConfig(baseRuntimeConfig);
				SandboxManager.updateConfig(activeRuntimeConfig);
				refreshSandboxStatus(ctx, sandboxEnabled, activeRuntimeConfig);
				notify(ctx, "Sandbox runtime configuration reset for this session", "info");
				return;
			}

			if (subcommand === "network") {
				const runtimeConfig = ensureRuntimeConfig(ctx, sandboxInitialized, activeRuntimeConfig);
				if (!runtimeConfig) return;

				const list = tokens[1]?.toLowerCase() as NetworkList | undefined;
				const op = tokens[2]?.toLowerCase() as ListOp | undefined;
				const domain = tokens.slice(3).join(" ").trim();

				if ((list !== "allow" && list !== "deny") || (op !== "add" && op !== "remove") || !domain) {
					notify(ctx, "Usage: /sandbox network <allow|deny> <add|remove> <domain>", "warning");
					return;
				}

				const values = getNetworkList(runtimeConfig, list);
				const changed = mutateStringList(values, op, domain);
				if (!changed) {
					notify(ctx, `No change: network ${list} list already ${op === "add" ? "contains" : "omits"} ${domain}`);
					return;
				}

				SandboxManager.updateConfig(runtimeConfig);
				refreshSandboxStatus(ctx, sandboxEnabled, runtimeConfig);
				notify(ctx, `Updated network ${list} list (${op}: ${domain})`, "info");
				return;
			}

			if (subcommand === "filesystem") {
				const runtimeConfig = ensureRuntimeConfig(ctx, sandboxInitialized, activeRuntimeConfig);
				if (!runtimeConfig) return;

				const list = tokens[1]?.toLowerCase() as FilesystemList | undefined;
				const op = tokens[2]?.toLowerCase() as ListOp | undefined;
				const targetPath = tokens.slice(3).join(" ").trim();

				if (
					(list !== "deny-read" && list !== "allow-write" && list !== "deny-write") ||
					(op !== "add" && op !== "remove") ||
					!targetPath
				) {
					notify(
						ctx,
						"Usage: /sandbox filesystem <deny-read|allow-write|deny-write> <add|remove> <path>",
						"warning",
					);
					return;
				}

				const values = getFilesystemList(runtimeConfig, list);
				const changed = mutateStringList(values, op, targetPath);
				if (!changed) {
					notify(
						ctx,
						`No change: filesystem ${list} list already ${op === "add" ? "contains" : "omits"} ${targetPath}`,
					);
					return;
				}

				SandboxManager.updateConfig(runtimeConfig);
				refreshSandboxStatus(ctx, sandboxEnabled, runtimeConfig);
				notify(ctx, `Updated filesystem ${list} list (${op}: ${targetPath})`, "info");
				return;
			}

			notify(ctx, `Unknown subcommand: ${subcommand}. Use /sandbox for help`, "error");
		},
	});
}
