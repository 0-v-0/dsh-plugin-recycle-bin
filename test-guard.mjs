// self-contained unit tests for guard.js and extract.js.
import { guardCommand } from "./lib/guard.js";
import { extractPaths } from "./lib/extract.js";

// ---- extractPaths tests: [command, expectedPaths] ----
const extractCases = [
  // simple deletes
  ["del C:\\a.txt", ["C:\\a.txt"]],
  ["del a.txt", ["a.txt"]],
  ["rm -rf dir/", ["dir/"]],
  ["rm dir1/ dir2/", ["dir1/", "dir2/"]],
  ["Remove-Item C:\\a.txt", ["C:\\a.txt"]],
  ["Remove-Item .\\a,.\\b", [".\\a", ".\\b"]],
  ["Remove-Item -Recurse -Force .\\a,.\\b", [".\\a", ".\\b"]],
  ["Remove-Item -Path C:\\a.txt", ["C:\\a.txt"]],
  ["Remove-Item -LiteralPath C:\\a.txt", ["C:\\a.txt"]],
  ["Remove-Item \"C:\\Program Files\\file.txt\"", ["C:\\Program Files\\file.txt"]],
  ["rm --recursive --force dir/", ["dir/"]],
  ["cmd /c del C:\\x.txt", ["C:\\x.txt"]],
  ["cmd /c erase C:\\x.txt", ["C:\\x.txt"]],
  ["cmd /k del C:\\x.txt", ["C:\\x.txt"]],
  ["unlink C:\\a.txt", ["C:\\a.txt"]],
  ["rmdir C:\\a", ["C:\\a"]],
  ["rd C:\\a", ["C:\\a"]],
  ["deltree C:\\a", ["C:\\a"]],
  // null: variables
  ["Remove-Item $t\\a.txt", null],
  ["del %TEMP%\\foo", null],
  // null: pipes
  ["Get-ChildItem | Remove-Item", null],
  ["find . -name *.tmp -delete", null],
  // null: semicolons / multi-command
  ["Remove-Item x; del y", null],
  // null: WhatIf / Confirm
  ["Remove-Item -WhatIf foo", null],
  ["Remove-Item -Confirm foo", null],
  // null: Exclude / Include / Filter
  ["Remove-Item -Exclude '*.log' foo/*", null],
  ["Remove-Item -Include *.md foo", null],
  // null: globs
  ["Remove-Item -Path *.md", null],
  ["Remove-Item C:\\*", null],
  // null: command substitution
  ["rm -rf $(find .)", null],
  // null: not a delete
  ["", null],
  ["echo hello", null],
  ["Get-Command Remove-Item", null],
  // null: empty args
  ["Remove-Item", null],
];

// ---- guardCommand tests: [command, expectBlocked, expectKind] ----
const guardCases = [
  // false positives (not blocked)
  ["Get-Command Remove-Item", false, null],
  ["help Remove-Item", false, null],
  ["Get-Command rmdir", false, null],
  ["Test-Path $recycle.bin", false, null],
  ["Write-Output form", false, null],
  ["Get-ChildItem | Where unlink", false, null],
  ["Get-Command rm", false, null],
  ["Get-Command -Name del", false, null],
  ["Get-Command -Name Remove-Item | Format-List", false, null],
  ["echo 'remove-item is not a command here'", false, null],
  ["$rm = 'hello'; Write-Output $rm", false, null],
  ["Select-String -Pattern 'del' file.txt", false, null],
  // real deletes with extractable paths (blocked: false, kind: delete)
  ["rm -rf dir/", false, "delete"],
  ["del C:\\a.txt", false, "delete"],
  ["Remove-Item .\\a,.\\b", false, "delete"],
  ["del a.txt", false, "delete"],
  ["cmd /c del C:\\x.txt", false, "delete"],
  ["Remove-Item alias:foo", false, "delete"],
  ["Remove-Item C:\\a.txt", false, "delete"],
  // real deletes with non-extractable paths (blocked: true, kind: delete)
  ["Remove-Item $t\\a.txt", true, "delete"],
  ["find . -name *.tmp -delete", true, "delete"],
  ["Get-ChildItem | Remove-Item", true, "delete"],
  ["Remove-Item x; del y", true, "delete"],
  ["Remove-Item -WhatIf foo", true, "delete"],
  // wipe (blocked: true, kind: wipe)
  ["sdelete C:\\", true, "wipe"],
  ["cipher /w:C:\\", true, "wipe"],
  // empty recycle (blocked: true, kind: empty-recycle)
  ["Clear-RecycleBin -Force", true, "empty-recycle"],
  ["Remove-Item C:\\$Recycle.Bin", true, "empty-recycle"],
];

let fail = 0;

console.log("=== extractPaths tests ===");
for (const [cmd, expected] of extractCases) {
  const result = extractPaths(cmd);
  const ok = JSON.stringify(result) === JSON.stringify(expected);
  if (!ok) fail++;
  const label = result ? `[${result.join(", ")}]` : "null";
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${label} | ${cmd}`);
}

console.log("\n=== guardCommand tests ===");
for (const [cmd, expectBlocked, expectKind] of guardCases) {
  const v = guardCommand(cmd, {});
  const okBlocked = v.blocked === expectBlocked;
  const okKind = (v.kind ?? null) === expectKind;
  const ok = okBlocked && okKind;
  if (!ok) fail++;
  const kind = v.kind ?? "-";
  const block = v.blocked ? "BLOCK" : "pass ";
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${block} | ${kind} | ${cmd}`);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
