// Path extraction from shell delete commands.
// Returns an array of literal paths, or null when the command is too
// complex to safely redirect (variables, globs, pipes, subexpressions,
// interactive/what-if flags, etc.). Callers must treat null as "block".
//
// Supported verbs: Remove-Item, del, erase, rd, rmdir, deltree, rm, unlink,
// and the `cmd /c <verb>` wrapper. Bash `find ... -delete` is intentionally
// not extracted (its targets are determined at runtime).

const BLOCK_FLAGS = /\-\w*[Ww]hatIf\b|\-\w*[Cc]onfirm\b|\-\w*[Ee]xclude\b|\-\w*[Ii]nclude\b|\-\w*[Ff]ilter\b/;

/** Tokenize a PowerShell / bash / cmd argument string, respecting quotes. */
function tokenizeArgs(args) {
	const tokens = [];
	let current = "";
	let inQuote = false;
	let quoteChar = "";
	for (const ch of args) {
		if (inQuote) {
			if (ch === quoteChar) inQuote = false;
			else current += ch;
		} else {
			if (ch === '"' || ch === "'") {
				inQuote = true;
				quoteChar = ch;
			} else if (ch === " " || ch === "\t" || ch === ",") {
				if (current) {
					tokens.push(current);
					current = "";
				}
			} else {
				current += ch;
			}
		}
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Extract path tokens from an argument string, dropping flag tokens. */
function extractPathTokens(args) {
	const tokens = tokenizeArgs(args);
	const end = tokens.indexOf("--");
	const pool = end === -1 ? tokens : tokens.slice(0, end);
	const rest = end === -1 ? [] : tokens.slice(end + 1);
	return [...pool.filter((t) => !t.startsWith("-")), ...rest];
}

/** True when `text` contains a glob metacharacter outside quotes. */
function hasGlob(text) {
	return /\*/.test(text.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " "));
}

/** True when `text` references a shell variable outside quotes ($var or %VAR%). */
function hasVariable(text) {
	const unquoted = text.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
	return /\$[a-zA-Z_]/.test(unquoted) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(unquoted);
}

const DELETE_VERBS = new Set([
	"remove-item",
	"del",
	"erase",
	"rd",
	"rmdir",
	"deltree",
	"unlink",
	"rm"
]);

const CMD_INNER_VERBS = new Set(["del", "erase", "rd", "rmdir", "deltree"]);

/**
 * Extract literal file/directory paths from a single-command delete string.
 * @param command - the shell command text.
 * @returns array of path strings, or null if extraction is not safe.
 */
export function extractPaths(command) {
	if (typeof command !== "string" || command.length === 0) return null;
	const text = command.trim();

	// Structural blockers: multi-command, pipe, substitution, subexpression.
	if (/;/.test(text)) return null;
	if (/\|/.test(text)) return null;
	if (/\$\(/.test(text)) return null;
	if (/`/.test(text)) return null;
	if (/\(/.test(text) && /\)/.test(text)) return null;

	// Flag blockers: interactive / what-if / confirm / filter semantics.
	if (BLOCK_FLAGS.test(text)) return null;

	// Find the verb at the start of the (single) command.
	const m = text.match(/^([A-Za-z][\w-]*)\b\s*(.*)$/);
	if (!m) return null;
	let verb = m[1].toLowerCase();
	let rest = m[2].trim();
	if (!rest) return null;

	// cmd /c <inner-verb> <args>
	if (verb === "cmd") {
		const tokens = tokenizeArgs(rest);
		const innerIdx = tokens.findIndex((t) => CMD_INNER_VERBS.has(t.toLowerCase()));
		if (innerIdx === -1) return null;
		verb = tokens[innerIdx].toLowerCase();
		rest = tokens.slice(innerIdx + 1).join(" ");
	}

	// bash rm -i (interactive) is not a simple delete.
	if (verb === "rm" && /\s-i\b/.test(rest)) return null;

	if (!DELETE_VERBS.has(verb)) return null;

	// Glob / variable checks on the unquoted remainder.
	if (hasGlob(rest)) return null;
	if (hasVariable(rest)) return null;

	// Extract path tokens.
	const paths = extractPathTokens(rest);
	if (paths.length === 0) return null;
	return paths;
}
