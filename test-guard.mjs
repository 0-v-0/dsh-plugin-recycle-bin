// self-contained unit test for the DELETE_RULES semantics in lib/guard.js.
import { guardCommand } from "./lib/guard.js";

const cases = [
  // ---- false positives must now PASS (not blocked) ----
  ["Get-Command Remove-Item", false],
  ["help Remove-Item", false],
  ["Get-Command rmdir", false],
  ["Test-Path $recycle.bin", false],
  ["Write-Output form", false],
  ["Get-ChildItem | Where unlink", false],
  ["Get-Command rm", false],
  ["Get-Command -Name del", false],
  ["Get-Command -Name Remove-Item | Format-List", false],
  ["echo 'remove-item is not a command here'", false],
  ["$rm = 'hello'; Write-Output $rm", false],
  ["Select-String -Pattern 'del' file.txt", false],
  // ---- real deletes must still BLOCK ----
  ["Remove-Item $t\\a.txt", true],
  ["rm -rf dir/", true],
  ["del C:\\a.txt", true],
  ["Remove-Item -Recurse -Force .\\a,.\\b", true],
  ["find . -name *.tmp -delete", true],
  ["Remove-Item alias:foo", true],
  ["cmd /c del C:\\x.txt", true],
  ["Get-ChildItem | Remove-Item", true],          // after pipe
  ["Remove-Item x; del y", true],                // second after ;
  ["del a.txt", true],                           // bare at start
];

let fail = 0;
for (const [cmd, expect] of cases) {
  const v = guardCommand(cmd, {});
  const ok = v.blocked === expect;
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + " | " + (v.blocked ? "BLOCK" : "pass ") + " | " + cmd);
}
console.log(fail === 0 ? "ALL PASS" : fail + " FAILURES");
process.exit(fail === 0 ? 0 : 1);