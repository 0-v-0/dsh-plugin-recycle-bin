# dsh-plugin-recycle-bin

> **DSH 安全删除守卫**：在 Windows 上强制所有删除走回收站，禁用 `del`/`rm`/`Remove-Item` 等磁盘删除命令，禁止自动清空回收站；回收站或硬盘已满时停止删除、提醒用户并等待指令。

![platform](https://img.shields.io/badge/platform-Windows-blue)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-plugin-orange)
![license](https://img.shields.io/badge/license-MIT-green)

## 功能特性

- 🗑️ **删除一律进回收站**：经 `file_trash` 工具，用 `Microsoft.VisualBasic` `SendToRecycleBin` 移入系统回收站，可恢复、绝不永久擦除。
- 🚫 **禁用磁盘删除**：拦截 `del`、`rm`、`Remove-Item`、`erase`、`rd`、`rmdir`、`deltree`、`find -delete`、`unlink`。
- 🛡️ **禁止安全擦除**：拦截 `sdelete`、`shred`、`srm`、`cipher /w`、`wipe`。
- 🚯 **禁止清空回收站**：拦截 `Clear-RecycleBin` 及针对 `C:\$Recycle.Bin` / `Recycler` 的删除。
- ⛔ **满则停手**：删除前检查剩余空间，不足时不删，用 `ctx.userQuestions` 停顿询问用户（放空间后重试 / 坚持回收 / 取消）。
- 💡 **低误判**：只在命令位置匹配删除 token，`$rm`、`form`、`Get-Command Remove-Item`、`help rmdir` 等引用性提及不会误判（详见 [变更记录](#变更记录)）。
- 🔍 **容量查看**：`trash_status` 工具报告回收站支持情况、剩余/总空间与安全阈值。
- 🧠 **模型教育**：向系统提示注入 `safety:recycle-bin` 区段，引导模型只用 `file_trash`、不空回收站、满时询问。

## 实现方式

分三层：

1. **Shell 接缝拦截**：包装 `ctx.shell.run` / `start`，因此覆盖 PowerShell 与 bash 工具的前台/后台命令。`guardCommand()` 以「命令位置」正则匹配破坏性命令，命中即返回阻断结果（`[exit code: 2]`），命令不会 spawn。
2. **回收站删除**：`file_trash` 将目标交给 `lib/recycle.js`，经 `pwsh` 调用 PowerShell 以 `SendToRecycleBin` 移入回收站。经本插件删除，永久擦除在机制上不可行。
3. **容量判定**：`fs.statfsSync`（失败回退 `Get-PSDrive`）测剩余空间，`classifyCapacity()` 给出 `ok | low | full`；非 `ok` 时经 `ctx.userQuestions` 停顿等待用户（该服务缺失则安全失败、停止删除）。

> 依赖策略：不声明任何 `peerDependencies` / `dependencies`，运行时所需 `@deepseek-ai/*` 由 DSH 宿主解析提供。

## 安装

用 DSH 插件管理器导入发布包，并确保组合存在该插件：

```yaml
# cordis.patch.yml
- insert:
    - id: recycle-bin
      name: 'dsh-plugin-recycle-bin'
      config:
        enabled: true
        blockDestructiveCommands: true
        forbidEmptyRecycleBin: true
        forbidWipe: true
        minFreeBytes: 104857600
        reserveBytes: 52428800
        pwshPath: ''
```

需要 `ctx.shell` 执行器、`tools`、`systemPrompt`。`ctx.userQuestions` 可选，缺失时「已满」会安全失败。

## 配置

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 总开关。 |
| `blockDestructiveCommands` | `boolean` | `true` | 阻断硬盘删除命令。 |
| `forbidEmptyRecycleBin` | `boolean` | `true` | 禁止清空回收站。 |
| `forbidWipe` | `boolean` | `true` | 禁止安全擦除器。 |
| `minFreeBytes` | `number` | `104857600` | 剩余空间低于此值停止删除。 |
| `reserveBytes` | `number` | `52428800` | 回收后保留的剩余空间。 |
| `pwshPath` | `string` | `""` | 可选：显式 pwsh 路径。 |

## 使用

```text
file_trash(paths: ["C:\\Project\\draft.md", "C:\\Project\\old-temp"])
trash_status(path: "C:\\Project")    # path 可选
```

- `file_trash` 返回 `deleted` / `skipped` / `blockedFull` / `message`；满则暂停询问。
- `trash_status` 返回回收站支持情况、剩余/总空间与安全阈值。

## 安全边界

**强约束**（正常模型工具路径内，无法绕过）：标准 `pwsh`/`bash` 工具的删除与擦除命令在执行前被拦截；后台删除、子代理同样覆盖；经 `file_trash` 必进回收站，满则停手。

**已知边界**（可绕过/覆盖不到）：

- 持久 shell（`dsh-tool-*-persistent`）会话内命令不经过 `ctx.shell` 包装。
- PTC / `run_code` 模型代码里直接调宿主 `child_process.exec("del …")` 不走 shell 接缝。
- 第三方 / MCP / 自注册工具若直接用 Node `fs` 删除，本插件管不到。
- `enabled: false` 或 `blockDestructiveCommands: false` 可关闭（策略，非不可逆）。
- 人类 / 外部程序手动删除不受此约束。

如需更强保证，建议叠加：工具注册表层拦截、Windows ACL 受限令牌沙箱 + ConstrainedLanguage、PowerShell 全局别名把 `Remove-Item`/`del`/`rm` 映射到回收站、或在文件系统层禁止 `DELETE` 权限。

## 开发与测试

纯 JS、无构建。语法检查：`node --check lib/index.js lib/guard.js lib/recycle.js`。守卫匹配器（`lib/guard.js`，无外部依赖）可独立验证覆盖清单与误判场景，跑 `npm test`（`node test-guard.mjs`）即可回放 23 例回归矩阵。

## 结构

```
lib/
├─ index.js    # 插件入口：shell 守卫、file_trash/trash_status、提示区段
├─ guard.js    # 破坏性命令匹配器 + 被阻断结果构造
├─ recycle.js  # Windows 回收站删除、空间测量、容量判定
└─ index.d.ts  # 类型声明
cordis.patch.yml / cordis.example.yml   # 组合接线
test-guard.mjs                            # 守卫规则回归测试（npm test）
```

## 变更记录

- **0.1.4** — `lib/guard.js` 删除动词改用「真命令位置」lookbehind 锚定，修掉 `Get-Command Remove-Item`、`help rmdir`、`Get-Command -Name del`、`$rm = ...`、`Select-String -Pattern 'del'` 等引用性提及被误拦的假阳性；`find ... -delete` 规则同步锚定；新增 `test-guard.mjs` 23 例回归矩阵与 `scripts.test`。

## 许可

[MIT](./LICENSE)
