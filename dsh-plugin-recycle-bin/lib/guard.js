// Guard rules: detect destructive / wipe / recycle-bin-emptying commands that
// must NOT be executed as disk erases. The plugin blocks them at the shell seam
// and routes all deletion through the `file_trash` tool (recycle bin only).
//
// The matcher is deliberately conservative — it only flags command-position
// delete tokens so a variable like `$rm` or a word like "form" is never
// mistaken for a delete command.

const CMD_POS = "(?:^|[;|&()\r\n\\s])";

/** Rules that must never run because they erase disk data directly. */
const DELETE_RULES = [
	/\bremove-item\b/i,
	/\bremove\s+-item\b/i,
	/\bdeltree\b/i,
	/\brmdir\b/i,
	/\bunlink\b/i,
	/\bfind\b[^;&|\r\n]*-delete\b/i,
	new RegExp(`${CMD_POS}\\s*del\\b`, "i"),
	new RegExp(`${CMD_POS}\\s*erase\\b`, "i"),
	new RegExp(`${CMD_POS}\\s*rm\\b`, "i"),
	new RegExp(`${CMD_POS}\\s*rd\\b`, "i")
];

/** Rules that securely wipe free space or data (permanent, unrecoverable). */
const WIPE_RULES = [
	/\bsdelete\b/i,
	/\bshred\b/i,
	/\bsrm\b/i,
	/\bwipe\b/i,
	/\bcipher\s+\/w\b/i,
	/\bcipher\s+\/w:\S+/i
];

/** Rules that empty the recycle bin — explicitly forbidden by this plugin. */
const EMPTY_RECYCLE_RULES = [
	/\bclear-recyclebin\b/i,
	/\bclear\s+-recyclebin\b/i,
	/\bclear\s+recyclebin\b/i,
	/remove-item[^\n;&|]*\$recycle\.bin/i,
	/remove[^\n;&|]*\$recycle\.bin/i,
	/rd\b[^\n;&|]*\$recycle\.bin/i,
	/rmdir\b[^\n;&|]*\$recycle\.bin/i,
	/del\b[^\n;&|]*\$recycle\.bin/i,
	/remove-item[^\n;&|]*recycler/i,
	/rd\b[^\n;&|]*recycler/i
];

function matchesAny(command, rules) {
	for (const rule of rules) if (rule.test(command)) return true;
	return false;
}

/**
 * Classify a candidate shell command. A command that is not destructive returns
 * `{ blocked: false }`. A destructive command returns a blocked classification
 * with a human-readable reason the model surfaces to the user.
 * @param command - the shell command text (PowerShell or bash dialect).
 * @param options - optional `{ allowWipe: false }` etc.
 * @returns the guard verdict.
 */
export function guardCommand(command, options = {}) {
	if (typeof command !== "string" || command.length === 0) return { blocked: false };
	const text = command;
	if (options.allowEmptyRecycle !== true && matchesAny(text, EMPTY_RECYCLE_RULES)) {
		return {
			blocked: true,
			kind: "empty-recycle",
			reason: "Emptying the Recycle Bin is disabled by the safe-delete policy. Files already in the recycle bin are permanently removed by this action; no disk-delete command may empty it. Use the `file_trash` tool to delete new items instead."
		};
	}
	if (options.allowWipe !== true && matchesAny(text, WIPE_RULES)) {
		return {
			blocked: true,
			kind: "wipe",
			reason: "Secure-erase / wipe commands (sdelete, shred, srm, cipher /w, wipe) are disabled by the safe-delete policy: they permanently destroy data and bypass the recycle bin. Use the `file_trash` tool to send items to the recycle bin instead."
		};
	}
	if (matchesAny(text, DELETE_RULES)) {
		return {
			blocked: true,
			kind: "delete",
			reason: "Direct disk-delete commands (del, rm, Remove-Item, erase, rd, rmdir, deltree, find -delete, unlink) are disabled by the safe-delete policy. Delete files/directories through the `file_trash` tool instead, which sends them to the Windows Recycle Bin and never erases them permanently."
		};
	}
	return { blocked: false };
}

/**
 * Build a model-facing `ShellRunResult` for a blocked command. Matches the shape
 * the pwsh/bash tool renderers consume (stderr plus a non-zero exit marker).
 */
export function blockedRunResult(spec, verdict) {
	return {
		exitCode: 2,
		signal: null,
		timedOut: false,
		aborted: false,
		timeoutMs: spec?.timeoutMs ?? 120000,
		stdout: { text: "", truncated: false },
		stderr: { text: verdict.reason, truncated: false }
	};
}

/**
 * Build a fake background process handle for a blocked command. Exposes the
 * `proc` surface the tool's background adaptation reads (`done`, `readOutput`,
 * `kill`, `status`, `exitCode`, `signal`).
 */
export function blockedProc(_spec, verdict) {
	return {
		status: "completed",
		exitCode: 2,
		signal: null,
		sandbox: void 0,
		done: Promise.resolve(),
		readOutput: () => ({ delta: `[stderr]\n${verdict.reason}\n[exit code: 2]`, lossy: false }),
		kill: () => false
	};
}
