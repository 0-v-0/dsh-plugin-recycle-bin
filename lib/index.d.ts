// Type declarations for dsh-plugin-recycle-bin.
// These mirror the runtime exports loosely so TypeScript consumers can
// reference the plugin and its helpers.

/** Runtime configuration for the plugin (schemastery schema). */
export interface RecycleBinConfig {
	enabled?: boolean;
	blockDestructiveCommands?: boolean;
	forbidEmptyRecycleBin?: boolean;
	forbidWipe?: boolean;
	minFreeBytes?: number;
	reserveBytes?: number;
	pwshPath?: string;
	/** Register the `file_trash` tool. Default: true. */
	fileTrashTool?: boolean;
	/** How extractable deletes are handled. Default: "auto". */
	autoRecycle?: "auto" | "ask" | "deny";
}

/** Output value of the `file_trash` tool. */
export interface FileTrashResult {
	deleted: Array<{ path: string; recycled: boolean; size?: number }>;
	skipped: Array<{ path: string; reason: string }>;
	blockedFull: boolean;
	message: string;
}

/** A guard verdict for a shell command. */
export interface GuardVerdict {
	blocked: boolean;
	kind?: "delete" | "wipe" | "empty-recycle";
	reason?: string;
	/** Present when blocked is false and kind is "delete": extracted literal paths. */
	paths?: string[];
}

export function guardCommand(command: string, options?: { allowEmptyRecycle?: boolean; allowWipe?: boolean }): GuardVerdict;

/** Extract literal paths from a delete command, or null if extraction is unsafe. */
export function extractPaths(command: string): string[] | null;

export function isWindows(platform?: NodeJS.Platform): boolean;
export function resolvePwsh(configured?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export function freeBytesOn(path: string, pwshPath?: string): Promise<{ free: number; total: number; source: string } | null>;
export function pathSize(path: string, cap?: number): number;
export function recycleDelete(path: string, pwshPath?: string): Promise<{ ok: true } | { ok: false; tooLarge: boolean; error: string }>;
export function classifyCapacity(freeBytes: number, totalBytes: number, targetBytes: number, options?: { minFreeBytes?: number; reserveBytes?: number }): { kind: "ok" | "low" | "full"; freeBytes: number; totalBytes: number; targetBytes: number; reason: string | null };
export function bytesLabel(bytes: number): string;
