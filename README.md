# aiflow — 本机 AI 编程 CLI 编排器

自动识别电脑上装的 AI 编程 CLI（Claude Code / Codex / Antigravity agy / Gemini / OpenCode …），
按你定义的**工作流**让它们分工协作：交叉理解需求 → 主控整合 → **你拍板** → 分工编码 → 审核 → 修复。

零依赖，Node.js ≥ 18，Windows / macOS / Linux 通用。

## 安装

```powershell
cd aiflow
npm link          # 之后任意目录可用 aiflow 命令
```

> 前提：各 AI CLI 自己先登录过一次（交互模式跑一下 `claude`、`agy`、`codex`），aiflow 用它们缓存的凭据。

## 快速开始

```powershell
aiflow detect                 # 扫描本机工具，自动选主工具
aiflow main claude            # 设主工具
aiflow wf show default        # 看默认工作流的分工
cd 你的项目
aiflow run default --task "给后台加一个用户导出 Excel 的功能"
aiflow run default --task-file 需求.md --dry-run   # 只看每步会调用什么，不真正执行
```

在拍板步骤可以：`y` 通过 ｜ `e` 用记事本改方案再通过 ｜ `r` 写意见，让 AI 重做上一步 ｜ `n` 终止。

所有提示词和各工具输出都存在项目下 `.aiflow/runs/<时间>/`，方案落地在 `docs/aiflow/PLAN.md`。

## 桌面版（Windows 11）

三种用法，任选其一：

| 方式 | 怎么做 | 说明 |
|---|---|---|
| 安装包 | 双击 `build-desktop.bat`（构建桌面版），完成后到 `release\` 运行安装版或便携版 | 首次需下载 Electron（约 100MB），脚本可选国内镜像 |
| 直接运行 | 双击 `run-desktop.bat`（直接运行） | 不打包，适合自己改代码后立即试 |
| 网页版 | 双击 `web-ui.bat`（网页版），或命令行 `aiflow ui` | 不需要 Electron，在浏览器里用同一套界面；只监听 127.0.0.1 并带随机令牌 |

桌面版和命令行共用同一个引擎和同一份配置（`%USERPROFILE%\.aiflow\`），工作流文件也通用。

- 前台子 agent（如需求访谈）会在一个**新的终端窗口**里打开真实的 claude / agy，和直接使用一样；窗口关闭后自动继续，也可以点"我已完成"。
- 后台子 agent 每个工具一个日志标签页，实时显示输出和 🔧 工具/Skill 调用。
- 需要你拍板、回答或确认时会弹窗；窗口不在前台时任务栏会闪烁并发系统通知。
- 拍板时可直接在弹窗里编辑方案再通过，不需要记事本。

## 同时运行多个任务

- 桌面版"任务"页每个任务单独选项目文件夹，可以连续提交多个：**不同项目同时运行**，**同一项目自动排队**（避免两个任务同时改一个工作区）。
- 总并发数默认 3，可在"设置 → 运行与后台"修改；超出的任务排队，左侧任务列表显示排队原因。
- 每个任务有自己的步骤时间线、子 agent 日志和成果；拍板弹窗会注明是哪个任务。你正在编辑东西时不会被打断，右下角显示"N 个任务在等你拍板"，点一下再处理。

## 定时任务

- 桌面版"定时"页新建，或在"任务"页填好需求后点"设为定时任务…"。时间规则：每天 / 每周几 / 每隔 N 小时 / 只执行一次 / cron 表达式，保存前会预览接下来 5 次执行时间。
- **拍板方式**：
  - 无人值守：自动通过拍板，子 agent 的问题按它的推荐处理，需要你直接对话的步骤跳过，合并冲突交给主工具。
  - 等我拍板：到点开始，遇到拍板弹窗 + 系统通知，等你处理。
- 定时任务需要 aiflow 在运行：桌面版关闭窗口会留在托盘继续执行，可在设置里打开"开机自动启动"。也可以不开界面，在命令行运行 `aiflow scheduler`（全部按无人值守执行）。
- 同一台电脑上只有一个 aiflow 进程负责调度（锁文件 `~/.aiflow/scheduler.lock`），不会重复执行。aiflow 没开着而错过的执行：10 分钟内补跑，更久的跳过并记录为"错过"。
- 命令行：`aiflow schedule list`、`aiflow schedule add --name 名称 --task "需求" --workflow quick --cwd 项目 --weekdays 09:00 [--wait]`、`aiflow schedule rm|enable|disable <id>`。

## 需求素材、产出物与运行记录

- **需求素材**：桌面版"需求"下方可以添加文件（Word/PPT/Excel 会转成文字，PDF/图片原样交给 AI 查看）和链接；命令行用 `--file` / `--link`（可多次）。
  - Confluence：设置 → 集成 填写令牌后自动拉取页面正文。
  - Figma：填写个人访问令牌后自动导出画板为 PNG，并提取界面文字；链接带 `node-id` 时只导出那个节点。
  - 其他网页：直接抓取正文；需要登录或取不到时，会把链接交给子 agent 用它自己的 MCP / 工具访问。
- **产出物**：需求定稿（docs/aiflow/SPEC.md）、实施方案（docs/aiflow/PLAN.md）、代码检查报告、代码变更（与运行前对比的完整 diff）。桌面版在"📄 成果"标签页和"记录"页查看；工作流步骤用 `"artifact": "名称"` 标记。
- **每一步的输入输出**：桌面版点时间线上的任意一步，左边是发给 agent 的完整提示词，右边是它的输出，还有你在这一步的回答和拍板。

## 前后端并行开发（git worktree 隔离）

```json
{ "id": "impl", "type": "parallel", "isolation": "worktree", "steps": [ { "id": "impl-core", ... }, { "id": "impl-frontend", ... } ] }
```

1. 给当前工作区拍一个快照（包含你未提交的改动，**不动你的分支和暂存区**）；
2. 每个子步骤在 `.aiflow/worktrees/` 下的独立 worktree 里同时开发；
3. 完成后在单独的集成 worktree 里依次合并，有冲突时你选择：让主工具解决 / 自己手动解决 / 终止；
4. 合并结果以"未提交改动"的形式应用回你的工作区，临时 worktree 和分支自动删除。

不是 git 仓库时自动改为依次执行。`.aiflow/` 会被加入本地忽略（.git/info/exclude，不会提交）。

## 主控 + 子 agent

- aiflow 是主控；每个被调用的 AI CLI 是子 agent，在你的项目目录里以真实进程运行，会加载它自己的 skill、插件、MCP 和 CLAUDE.md/AGENTS.md/GEMINI.md。
- `interactive` 步骤：终端交给子 agent 的 TUI，和直接用一样（斜杠命令、skill、提问都可用），输入 /exit 后回到主控。
- `agent` / `parallel` 步骤：后台运行，实时显示输出（Claude 会显示 🔧 工具/Skill 调用和费用）；拿不准时输出 [[ASK]]，主控停下来问你。
- `aiflow skills` 查看各工具装了什么；步骤里用 `"use": [...]` 点名要用的能力，用 `"args": [...]` 追加该步的 CLI 参数。

内置工作流：`default`（完整流程）、`omc`（用 OMC /deep-interview 访谈）、`quick`（小改动）。
新增步骤类型 `interactive`、`loop`，通用字段 `when`、`use`、`args`、`ask`；`aiflow stats` 查看工具表现。
**完整说明见《aiflow 使用手册》。**

## 默认工作流（workflows/default.json）

| # | 步骤 | 工具 | 说明 |
|---|------|------|------|
| 1 | 需求理解 | claude + agy **并行** | 各自独立分析 |
| 2 | 交叉验证+方案 | 主工具 | 对比共识/分歧，出实施方案 |
| 3 | **你拍板** | — | 可重做/手改 |
| 4 | 保存方案 | — | docs/aiflow/PLAN.md |
| 5 | 后端/核心实现 | claude（长任务） | 可改代码 |
| 6 | 前端实现 | agy（Gemini） | 可改代码 |
| 7 | 整体审核 | codex（GPT） | 只读，查参数/接口/bug |
| 8 | **你确认** | — | |
| 9 | 修复 | 主工具 | 可改代码 |

## 自定义分工

```powershell
aiflow wf init default     # 复制到 项目/.aiflow/workflows/default.json
```

改 `roles` 就能换人，不用动步骤：

```json
"roles": { "main": "@main", "analyst2": "agy", "longTask": "claude", "frontend": "gemini", "reviewer": "codex" }
```

工作流查找顺序：`项目/.aiflow/workflows/` → `~/.aiflow/workflows/` → 内置。新建文件即新工作流。

### 步骤类型

| type | 字段 | 作用 |
|------|------|------|
| `agent` | `role` 或 `tool`、`prompt`、`mode`(`read`/`edit`)、`timeoutMin` | 单工具执行 |
| `parallel` | `roles` 或 `tools`、`prompt` | 多工具同时执行同一提示（交叉验证） |
| `approve` | `review`: 被审步骤 id | 人工拍板 |
| `write` | `from`、`to` | 把某步输出保存成文件 |

提示词变量：`{{task}}` `{{feedback}}` `{{runDir}}` `{{steps.<id>.output}}` `{{steps.<id>.outputs.<工具>}}`。
`prompt` 可写成字符串数组（每项一行）。

## 工具调用方式与覆盖

内置调用方式（`src/registry.js`）：

| 工具 | 非交互命令 | 可改代码模式追加 |
|------|-----------|------------------|
| claude | `claude -p` ← stdin | `--permission-mode acceptEdits` |
| codex | `codex exec --skip-git-repo-check -` ← stdin | `--full-auto` |
| agy | `agy -p "去读提示词文件"` | `--mode accept-edits` |
| gemini | `gemini` ← stdin | `--approval-mode auto_edit` |
| opencode | `opencode run "去读提示词文件"` | — |

各 CLI 版本更新可能改参数，可在 `~/.aiflow/config.json` 覆盖，或加自定义工具：

```json
{
  "overrides": { "agy": { "promptVia": "stdin", "args": ["-p", "", "{{EDIT}}"] } },
  "custom": {
    "kimi": { "name": "Kimi CLI", "bins": ["kimi"], "args": ["-p", "{{PROMPT}}"], "promptVia": "file" }
  }
}
```

`promptVia`：`stdin`（最稳）/ `file`（长提示写文件，命令行只传一句短指令，规避 Windows 8191 字符限制和引号转义）/ `arg`。

## 已知问题

- **agy -p 在被程序调用（非 TTY）时**有已知的卡住/不输出问题（官方 issue #76、#318）。aiflow 会关闭 stdin 并按 `timeoutMin` 超时杀进程。
  如果仍不行，把 `roles` 里的 agy 换成 `gemini`。
- 第 5、6 步串行执行，避免两个工具同时改同一个仓库产生冲突。建议在 git 仓库里跑，方便回滚。

## 路线图（GUI）

核心逻辑（detect / config / runner）与 CLI 分离，GUI 只需做一层壳：
1. `runner.js` 改成事件发射（step-start / line / approve-request），CLI 和 GUI 各自订阅；
2. 用 **Tauri** 或 **Electron** 做桌面端：工具列表页、拖拽式工作流编辑器（roles 下拉选工具）、运行页（每个工具一个输出面板 + 拍板按钮 + Markdown 方案编辑器）。
