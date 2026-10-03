// dsh-plugin-recycle-bin — guard rules
//
// DELETE_RULES anchor every delete verb to a true command position via a
// variable-length lookbehind: a delete verb is flagged only when it directly
// follows a command separator (start-of-string, `;`, `|`, `&`, `(`, `)`, or
// newline), ignoring intervening whitespace. Bare `\b` word boundaries — or a
// left-anchor that also matches whitespace after an identifier — would let
// benign commands that merely *reference* a delete name
// (`Get-Command Remove-Item`, `help rmdir`, `Get-ChildItem | Where unlink`,
// `Get-Command -Name del`, `echo 'remove-item ...'`) through as false
// positives. Real delete invocations (bare, after a pipe / `;` / newline) are
// still blocked.
//
// Guard rules: detect destructive / wipe / recycle-bin-emptying commands that
// must NOT be executed as disk erases. The plugin blocks them at the shell seam
// and routes all deletion through the `file_trash` tool (recycle bin only).

import { extractPaths } from "./extract.js";

// True command position: start of string, or after a command separator
// (ignoring whitespace). A delete verb must sit here to be treated as an
// *executed* command rather than a command name mentioned as an argument.
const CMD_POS_LOOKBEHIND = "(?<=^|[;|&()\\r\\n]\\s*)";

const DELETE_VERB = (verb) => new RegExp(`${CMD_POS_LOOKBEHIND}${verb}\\b`, "i");

// cmd.exe wrapper: `cmd /c del ...` / `cmd.exe /k rm ...` executes the delete
// even though the verb follows whitespace after an identifier.
const CMD_WRAPPER = (verb) => new RegExp(`(?:^|[;|&()\\r\\n]\\s*)cmd(?:\\.exe)?\\s+/(?:c|k)\\s+${verb}\\b`, "i");

/** Rules that must never run because they erase disk data directly. */
const DELETE_RULES = [
	DELETE_VERB("remove-item"),
	DELETE_VERB("remove\\s+-item"),
	DELETE_VERB("deltree"),
	DELETE_VERB("rmdir"),
	DELETE_VERB("unlink"),
	// `find ... -delete`: `find` must be the executed command (anchored), not
	// a name mentioned as an argument. `-delete` itself stays a substring
	// match — it is a `find`-specific flag that is meaningless outside a
	// `find` invocation, so a conservative substring match is the right call.
	new RegExp(`${CMD_POS_LOOKBEHIND}find\\b[^;&|\\r\\n]*-delete\\b`, "i"),
	DELETE_VERB("del"),
	DELETE_VERB("erase"),
	DELETE_VERB("rm"),
	DELETE_VERB("rd"),
	CMD_WRAPPER("del"),
	CMD_WRAPPER("erase"),
	CMD_WRAPPER("rm"),
	CMD_WRAPPER("rd"),
	CMD_WRAPPER("rmdir"),
	CMD_WRAPPER("remove-item")
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
	DELETE_VERB("clear-recyclebin"),
	new RegExp(`${CMD_POS_LOOKBEHIND}clear\\s+-recyclebin\\b`, "i"),
	new RegExp(`${CMD_POS_LOOKBEHIND}clear\\s+recyclebin\\b`, "i"),
	/remove-item[^\n;&|]*\$recycle\.bin/i,
	/remove[^\n;&|]*\$recycle\.bin/i,
	/rd\\b[^\n;&|]*\$recycle\.bin/i,
	/rmdir\\b[^\n;&|]*\$recycle\.bin/i,
	/del\\b[^\n;&|]*\$recycle\.bin/i,
	/remove-item[^\n;&|]*recycler/i,
	/rd\\b[^\n;&|]*recycler/i
];

function matchesAny(command, rules) {
	for (const rule of rules) if (rule.test(command)) return true;
	return false;
}

/**
 * Classify a candidate shell command. A command that is not destructive returns
 * `{ blocked: false }`. A destructive command returns either a blocked verdict
 * (when paths cannot be safely extracted) or an unblocked verdict carrying the
 * extracted paths (when the caller should auto-recycle them).
 *
 * @param command - the command text (PowerShell or bash dialect).
 * @param options - optional `{ allowWipe: false }` etc.
 * @returns the guard verdict: `{ blocked, kind, reason, paths }`.
 */
export function guardCommand(command, options = {}) {
	if (typeof command !== "string" || command.length === 0) return { blocked: false };
	const text = command;
	if (options.allowEmptyRecycle !== true && matchesAny(text, EMPTY_RECYCLE_RULES)) {
		return {
			blocked: true,
			kind: "empty-recycle",
			reason: "Emptying the Recycle Bin is forbidden."
		};
	}
	if (options.allowWipe !== true && matchesAny(text, WIPE_RULES)) {
		return {
			blocked: true,
			kind: "wipe",
			reason: "Secure-erase commands are forbidden."
		};
	}
	if (matchesAny(text, DELETE_RULES)) {
		const paths = extractPaths(command);
		if (paths) return { blocked: false, kind: "delete", paths };
		return {
			blocked: true,
			kind: "delete",
			reason:
				"Cannot safely redirect this deletion. Run the discovery command " +
				"first (e.g. Get-ChildItem ...), then call file_trash with explicit paths."
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
