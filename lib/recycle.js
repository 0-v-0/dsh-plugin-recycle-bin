// Recycle-bin implementation helpers. Host-side helper functions used by the
// plugin: detecting Windows, resolving a PowerShell executable, measuring free
// space on a volume, and deleting a file/directory into the Windows Recycle Bin
// through Microsoft.VisualBasic.FileIO.FileSystem (which always sends to the
// recycle bin and never performs a permanent erase).
//
// No third-party dependency is required. `pwsh` (or Windows PowerShell 5.1) is
// spawned from the host process for the recycle operation; the actual deletion
// is performed out-of-process with `RecycleOption.SendToRecycleBin`.
import { statfsSync, statSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, parse } from "node:path";

/** True when running on a Windows host (the platform this plugin targets). */
export function isWindows(platform = process.platform) {
	return platform === "win32";
}

/** Determine whether a path points at a directory (using an lstat-safe stat). */
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Resolve a PowerShell executable to use for the recycle operation. Mirrors the
 * well-known locations first (PowerShell 7 install, then a PATH entry, then
 * Windows PowerShell 5.1) and falls back to a bare `pwsh` / `powershell` for
 * PATH resolution.
 */
export function resolvePwsh(configured, env = process.env, platform = process.platform) {
	if (configured !== void 0 && configured.length > 0) return configured;
	if (platform === "win32") {
		const programFiles = env.ProgramFiles ?? "C:\\Program Files";
		const systemRoot = env.SystemRoot ?? "C:\\Windows";
		const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];
		for (const entry of (env.PATH ?? "").split(";")) {
			const trimmed = entry.trim().replace(/^"|"$/g, "");
			if (trimmed.length === 0) continue;
			candidates.push(join(trimmed, "pwsh.exe"));
		}
		candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
		for (const candidate of candidates) {
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// candidate does not exist; keep probing.
			}
		}
	}
	return platform === "win32" ? "powershell" : "pwsh";
}

/** Volume root (e.g. `C:\\`) of an absolute path, or the path itself. */
function volumeRoot(path) {
	try {
		const root = parse(path).root;
		return root !== void 0 && root.length > 0 ? root : path;
	} catch {
		return path;
	}
}

/**
 * Measure free and total bytes on the volume hosting `path`. Prefers
 * `fs.statfsSync` (native, available on Node 18.15+/24); on a failure falls back
 * to a PowerShell `Get-PSDrive` query. Returns `{ free, total, source }` in
 * bytes, or `null` when neither source succeeded.
 */
export async function freeBytesOn(path, pwshPath) {
	try {
		const stat = statfsSync(volumeRoot(path));
		if (stat !== void 0 && stat.bavail !== void 0) {
			return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize, source: "statfs" };
		}
	} catch {
		// fall through to the PowerShell probe.
	}
	return freeBytesViaPwsh(path, pwshPath);
}

async function freeBytesViaPwsh(path, pwshPath) {
	if (!isWindows()) return null;
	const executable = pwshPath ?? resolvePwsh();
	const root = volumeRoot(path);
	const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $d = (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq $env:RECYCLE_VOLUME } | Select-Object -First 1); if ($null -ne $d) { '{0}|{1}' -f $d.Free, ($d.Used + $d.Free) }`;
	const run = await runPwsh(executable, script, { RECYCLE_VOLUME: root });
	if (run.exitCode !== 0 || run.stdout.trim().length === 0) return null;
	const parts = run.stdout.trim().split("|");
	if (parts.length !== 2) return null;
	const free = Number(parts[0]);
	const total = Number(parts[1]);
	if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null;
	return { free, total, source: "pwsh" };
}

/** Compute a bounded recursive size for a directory (or a file's own size). */
export function pathSize(path, cap = 4 * 1024 * 1024 * 1024) {
	try {
		const stat = statSync(path);
		if (!stat.isDirectory()) return stat.size;
		let total = 0;
		const seen = new Set();
		const stack = [path];
		while (stack.length > 0) {
			const current = stack.pop();
			if (seen.has(current)) continue;
			seen.add(current);
			let entries;
			try {
				entries = readdirSync(current, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const child = join(current, entry.name);
				try {
					const childStat = statSync(child);
					if (childStat.isDirectory()) stack.push(child);
					else total += childStat.size;
				} catch {
					// unreadable entry; skip it (never fatal).
				}
				if (total >= cap) return total;
			}
		}
		return total;
	} catch {
		return 0;
	}
}

/**
 * Delete `path` into the Windows Recycle Bin. Returns:
 * - `{ ok: true }` on success;
 * - `{ ok: false, tooLarge: boolean, error: string }` on failure, with
 *   `tooLarge` set when the recycle bin refused the item (it is too large or
 *   there is not enough free space to recycle).
 */
export async function recycleDelete(path, pwshPath) {
	if (!isWindows()) {
		return { ok: false, tooLarge: false, error: "recycle-bin is only supported on Windows (current platform: " + process.platform + ")" };
	}
	const executable = pwshPath ?? resolvePwsh();
	const directory = isDirectory(path);
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName Microsoft.VisualBasic",
		"$p = $env:RECYCLE_TARGET",
		"$dir = ($env:RECYCLE_DIRECTORY -eq '1')",
		"if ($dir) {",
		"  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
		"} else {",
		"  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
		"}",
		"Write-Output 'RECYCLED'"
	].join("; ");
	const run = await runPwsh(executable, script, { RECYCLE_TARGET: path, RECYCLE_DIRECTORY: directory ? "1" : "0" });
	if (run.exitCode === 0 && /\bRECYCLED\b/.test(run.stdout)) return { ok: true };
	const text = `${run.stderr}\n${run.stdout}`;
	const tooLarge = /(too large|exceed|recycle bin|insufficient|disk full|space|无法|空间不足|过大|没有足够)/i.test(text);
	return { ok: false, tooLarge, error: text.trim() || `recycle delete failed (exit ${run.exitCode ?? "?"})` };
}

const MAX_CAPTURE_BYTES = 1024 * 1024;
const RUN_TIMEOUT_MS = 120000;

/** Spawn pwsh once, capture bounded output, never throw. */
function runPwsh(executable, command, env) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode, stdout, stderr });
		};
		let child;
		try {
			child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
				env: { ...process.env, ...env },
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"]
			});
		} catch (error) {
			stderr = String(error);
			clearTimeout(timer);
			resolve({ exitCode: 1, stdout, stderr });
			return;
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				// ignore
			}
			finish(1);
		}, RUN_TIMEOUT_MS);
		let captured = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.length > MAX_CAPTURE_BYTES) {
				stdout = stdout.slice(0, MAX_CAPTURE_BYTES);
				captured = true;
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			if (stderr.length > MAX_CAPTURE_BYTES) {
				stderr = stderr.slice(0, MAX_CAPTURE_BYTES);
				captured = true;
			}
		});
		child.on("error", (error) => {
			stderr = String(error);
			finish(1);
		});
		child.on("close", (code) => {
			finish(code ?? (timedOut ? 1 : 0));
		});
	});
}

/**
 * Classify a capacity situation for a pending delete. `freeBytes` is the
 * measured free space on the volume; `targetBytes` is the size the deletion
 * must fit. Returns one of:
 * - `ok`   — there is enough free space to recycle safely;
 * - `low`  — free space is below the configured safety threshold;
 * - `full` — free space cannot hold the target plus the configured reserve, or
 *            the target is itself too large to guarantee a safe recycle.
 */
export function classifyCapacity(freeBytes, totalBytes, targetBytes, options = {}) {
	const minFree = options.minFreeBytes ?? 100 * 1024 * 1024;
	const reserve = options.reserveBytes ?? 50 * 1024 * 1024;
	if (freeBytes === null || freeBytes === void 0 || !Number.isFinite(freeBytes)) {
		// Could not measure free space; defer to the runtime recycle operation,
		// which will surface a "too large / no space" refusal if it cannot recycle.
		return { kind: "ok", freeBytes, totalBytes, targetBytes, reason: null };
	}
	if (freeBytes < minFree) {
		return { kind: "low", freeBytes, totalBytes, targetBytes, reason: `only ${bytesLabel(freeBytes)} free on this volume (below the ${bytesLabel(minFree)} safety threshold)` };
	}
	if (freeBytes - reserve < targetBytes) {
		return { kind: "full", freeBytes, totalBytes, targetBytes, reason: `not enough free space to recycle this item (need ${bytesLabel(targetBytes)}, only ${bytesLabel(freeBytes)} available with ${bytesLabel(reserve)} reserved)` };
	}
	return { kind: "ok", freeBytes, totalBytes, targetBytes, reason: null };
}

/** Human-readable byte label. */
export function bytesLabel(bytes) {
	if (bytes === null || bytes === void 0 || !Number.isFinite(bytes)) return "unknown";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
