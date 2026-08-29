// dsh-plugin-recycle-bin
//
// Enforce recycle-bin-only deletion on Windows:
//   1. Direct disk-delete commands (del, rm, Remove-Item, erase, rd, rmdir,
//      deltree, find -delete, unlink) are BLOCKED at the shell seam.
//   2. Secure-erase/wipe commands and recycle-bin emptying are BLOCKED.
//   3. Every deletion goes through the `file_trash` tool, which sends items to
//      the Windows Recycle Bin (Microsoft.VisualBasic FileSystem, SendToRecycleBin).
//   4. When the recycle bin or the disk is full, the tool stops, surfaces the
//      reason to the user, and waits for the user's instruction before deleting.
//
// The plugin wraps `ctx.shell` (so both the pwsh and bash tools are covered)
// and registers the `file_trash` / `trash_status` tools and a system-prompt
// section. It has no third-party dependency.
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { guardCommand, blockedRunResult, blockedProc } from "./guard.js";
import { isWindows, resolvePwsh, freeBytesOn, pathSize, recycleDelete, classifyCapacity, bytesLabel } from "./recycle.js";
import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";

const name = "plugin-recycle-bin";
const inject = ["shell", "tools", "systemPrompt"];

/** Dedicated prompt-section order, after the tool sections (2900+) and before TOOLS_SDK. */
const PROMPT_ORDER = 2905;
const PROMPT_SECTION = "safety:recycle-bin";

/** Runtime configuration schema for the plugin. */
const Config = z.object({
	/** Total switch. Set to false to load the plugin without enforcing anything. */
	enabled: z.boolean().default(true),
	/** Block direct disk-delete commands at the shell seam. */
	blockDestructiveCommands: z.boolean().default(true),
	/** Forbid automatic emptying of the recycle bin (Clear-RecycleBin, deleting $Recycle.Bin). */
	forbidEmptyRecycleBin: z.boolean().default(true),
	/** Forbid secure-erase / wipe tools (sdelete, shred, srm, cipher /w). */
	forbidWipe: z.boolean().default(true),
	/** Free-space safety threshold, in bytes, below which a delete is stopped. */
	minFreeBytes: z.number().default(100 * 1024 * 1024),
	/** Reserved free bytes that must remain after a recycle, in bytes. */
	reserveBytes: z.number().default(50 * 1024 * 1024),
	/** Optional explicit pwsh executable path used for the recycle operation. */
	pwshPath: z.string().default("")
});

function promptText() {
	return [
		"SAFE-DELETE POLICY (mandatory):",
		"- Never run direct disk-delete commands: del, rm, Remove-Item, erase, rd, rmdir, deltree, find -delete, unlink, or any secure-erase/wipe tool (sdelete, shred, srm, cipher /w). They are disabled.",
		"- Never empty the Recycle Bin (Clear-RecycleBin or deleting C:\\$Recycle.Bin); it is forbidden.",
		"- Use the `file_trash` tool for EVERY deletion. It sends items to the Windows Recycle Bin and never erases them permanently.",
		"- You may still read/list the Recycle Bin; only deletion and emptying are restricted.",
		"- If `file_trash` reports a full Recycle Bin or insufficient disk space, STOP the deletion, explain to the user, and wait for the user's instruction before deleting anything."
	].join("\n");
}

function apply(ctx, config = {}) {
	if (config.enabled === false) return;
	const windows = isWindows();
	const pwshPath = config.pwshPath !== void 0 && config.pwshPath.length > 0 ? config.pwshPath : resolvePwsh();
	const options = {
		allowEmptyRecycle: config.forbidEmptyRecycleBin === false,
		allowWipe: config.forbidWipe === false
	};

	// 1. Wrap the shell executor so destructive commands never reach the disk.
	const shell = ctx.shell;
	if (shell !== void 0 && config.blockDestructiveCommands !== false) {
		const originalRun = typeof shell.run === "function" ? shell.run.bind(shell) : void 0;
		const originalStart = typeof shell.start === "function" ? shell.start.bind(shell) : void 0;
		shell.run = async (spec) => {
			const verdict = guardCommand(spec?.command, options);
			if (verdict.blocked) return blockedRunResult(spec, verdict);
			if (originalRun === void 0) throw new Error("recycle-bin-plugin: no shell.run executor is mounted");
			return originalRun(spec);
		};
		shell.start = (spec) => {
			const verdict = guardCommand(spec?.command, options);
			if (verdict.blocked) return blockedProc(spec, verdict);
			if (originalStart === void 0) throw new Error("recycle-bin-plugin: no shell.start executor is mounted");
			return originalStart(spec);
		};
	}

	// 2. System-prompt guidance.
	ctx.systemPrompt.section({ name: PROMPT_SECTION, order: PROMPT_ORDER, text: promptText() });

	// 3. Tools.
	ctx.tools.register(defineTool({
		name: "file_trash",
		description: "Delete files or directories into the Windows Recycle Bin. This is the ONLY permitted delete operation. The items are moved to the recycle bin and can be restored; they are never permanently erased. If the recycle bin or the disk is full, the tool stops and asks you/the user before deleting anything.",
		parameters: {
			paths: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Absolute or workspace-relative paths to delete into the Recycle Bin."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					deleted: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string", required: true },
								recycled: { type: "boolean", required: true },
								size: { type: "number" }
							}
						}
					},
					skipped: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string", required: true },
								reason: { type: "string", required: true }
							}
						}
					},
					blockedFull: { type: "boolean", required: true },
					message: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: fileTrashRender(value)
			}]
		},
		async execute(args, exec) {
			return fileTrashExecute(ctx, args, exec, { pwshPath, options, config });
		}
	}));

	ctx.tools.register(defineTool({
		name: "trash_status",
		description: "Report whether recycle-bin deletion is supported, the free/total space on a volume, and the configured safety thresholds. Use it before large deletions to check capacity.",
		parameters: {
			path: {
				type: "string",
				description: "An optional path whose volume should be measured. Defaults to the session working directory."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					supported: { type: "boolean", required: true },
					freeBytes: { type: "number", required: true },
					totalBytes: { type: "number", required: true },
					freeLabel: { type: "string", required: true },
					totalLabel: { type: "string", required: true },
					minFreeBytes: { type: "number", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `recycle-bin supported: ${value.supported}\nfree: ${value.freeLabel} of ${value.totalLabel}\nsafety threshold: ${bytesLabel(value.minFreeBytes)}`
			}]
		},
		async execute(args, exec) {
			const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
			const target = args.path !== void 0 && args.path.length > 0 ? args.path : cwd;
			const abs = isAbsolute(target) ? target : resolve(cwd, target);
			const free = await freeBytesOn(abs, pwshPath);
			return {
				supported: windows,
				freeBytes: free?.free ?? 0,
				totalBytes: free?.total ?? 0,
				freeLabel: bytesLabel(free?.free ?? 0),
				totalLabel: bytesLabel(free?.total ?? 0),
				minFreeBytes: config.minFreeBytes
			};
		}
	}));
}

function fileTrashRender(value) {
	const lines = [];
	lines.push(value.deleted.length > 0 ? `${value.deleted.length} item(s) moved to the Recycle Bin:` : "no items were moved to the Recycle Bin.");
	for (const entry of value.deleted) lines.push(`  - ${entry.path}`);
	if (value.skipped.length > 0) {
		lines.push(`${value.skipped.length} item(s) skipped:`);
		for (const entry of value.skipped) lines.push(`  - ${entry.path}: ${entry.reason}`);
	}
	if (value.blockedFull) lines.push("STOPPED: recycle bin / disk capacity issue detected. No permanent deletion occurred.");
	if (value.message.length > 0) lines.push(value.message);
	return lines.join("\n");
}

async function fileTrashExecute(ctx, args, exec, deps) {
	const { pwshPath, config } = deps;
	const windows = isWindows();
	const result = { deleted: [], skipped: [], blockedFull: false, message: "" };
	if (!windows) {
		result.skipped.push({ path: "<all>", reason: "recycle-bin deletion is only supported on Windows" });
		result.message = "SAFE-DELETE: recycle-bin deletion is unavailable on this platform; no deletion was performed.";
		return result;
	}
	const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
	for (const raw of args.paths) {
		const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
		let stat;
		try {
			stat = statSync(abs);
		} catch {
			result.skipped.push({ path: abs, reason: "not found" });
			continue;
		}
		const targetSize = pathSize(abs);
		const free = await freeBytesOn(abs, pwshPath);
		const capacity = classifyCapacity(free?.free ?? Number.NaN, free?.total ?? Number.NaN, targetSize, {
			minFreeBytes: config.minFreeBytes,
			reserveBytes: config.reserveBytes
		});
		if (capacity.kind !== "ok") {
			result.blockedFull = true;
			const decision = await askUserDeleteChoice(ctx, exec, abs, capacity);
			if (decision === "proceed") {
				const out = await recycleDelete(abs, pwshPath);
				applyDeleteOutcome(result, abs, targetSize, out);
			} else if (decision === "cancel") {
				result.skipped.push({ path: abs, reason: `cancelled by user (${capacity.reason})` });
			} else {
				result.skipped.push({ path: abs, reason: `stopped (${capacity.reason})` });
				result.message = `Deletion STOPPED: ${capacity.reason}. No file was deleted. Waiting for user instruction.`;
				break;
			}
			continue;
		}
		const out = await recycleDelete(abs, pwshPath);
		applyDeleteOutcome(result, abs, targetSize, out);
	}
	if (result.message.length === 0) {
		const failed = result.skipped.filter((entry) => entry.reason !== "not found" && !/cancelled|stopped/.test(entry.reason));
		result.message = result.deleted.length > 0 ? `Moved ${result.deleted.length} item(s) to the Recycle Bin.` : (failed.length > 0 ? "No items were recycled; see skipped entries." : "Nothing was deleted.");
	}
	return result;
}

function applyDeleteOutcome(result, path, size, out) {
	if (out.ok) {
		result.deleted.push({ path, recycled: true, size });
		return;
	}
	if (out.tooLarge) {
		result.blockedFull = true;
		result.skipped.push({ path, reason: out.error || "recycle bin refused the item (too large / no space)" });
		result.message = `STOPPED: ${out.error || "the recycle bin refused the item"}. No permanent deletion occurred.`;
		return;
	}
	result.skipped.push({ path, reason: out.error });
}

async function askUserDeleteChoice(ctx, exec, path, capacity) {
	const service = typeof ctx.get === "function" ? ctx.get("userQuestions") : void 0;
	if (service?.ask) {
		try {
			const answer = await service.ask({
				questions: [{
					id: "recycle-full",
					question: `Recycle Bin / disk capacity is not safe for deleting "${path}". Reason: ${capacity.reason}. No file has been deleted yet. Choose how to proceed.`,
					header: "Recycle Bin Full",
					options: [
						{ label: "Free up space first (Recommended)", description: "Pause the deletion so you can free disk/recycle-bin space, then retry." },
						{ label: "Proceed with recycle delete anyway", description: "Attempt to send to the recycle bin; it may still be refused if the bin is full." },
						{ label: "Cancel this deletion", description: "Keep the file(s); nothing is deleted." }
					]
				}],
				...(exec?.agent !== void 0 ? { agent: exec.agent } : {}),
				signal: exec?.signal
			});
			const selected = answer?.answers?.[0]?.selected?.[0] ?? "";
			if (/^proceed/i.test(selected)) return "proceed";
			if (/^cancel/i.test(selected)) return "cancel";
			return "stop";
		} catch {
			// Could not ask; fail closed -> stop the deletion.
			return "stop";
		}
	}
	return "stop";
}

export { Config, apply, inject, name };
