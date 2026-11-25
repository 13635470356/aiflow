# aiflow 使用手册

Nov 23, 2026 · @Morgan Lee

## 核心概念：主控 + 子 agent

aiflow 是主控 agent，负责按工作流调度；它调用的每个 AI CLI（claude、agy、codex……）都是一个子 agent。子 agent 是真实的 CLI 进程，在你的项目目录里运行，所以会加载它自己的 skill、插件、MCP 和规则文件。

子 agent 有两种运行方式：

| 方式 | 步骤类型 | 你看到什么 | 怎么拍板 |
| --- | --- | --- | --- |
| 前台（交互） | `interactive` | 完整 TUI，和直接运行 `claude` / `agy` 一模一样，斜杠命令、skill、提问都可用 | 直接在 TUI 里和它对话；完成后输入 `/exit` 回到 aiflow |
| 后台（自动） | `agent` / `parallel` | 实时输出；Claude 还会显示它调用的工具、Skill、费用 | 它拿不准时输出 `[[ASK]]` 问题，aiflow 停下来问你，你的回答再交还给它 |

此外还有主控自己的拍板点（`approve` 步骤）：方案、审核结论等关键产出都要你通过、手改或提意见重做。

经验法则：需求不清、需要来回讨论的阶段用前台；方案明确后的编码、审核用后台。

## Windows 11 安装与首次使用

前提：Node.js 18 或更新版本；各 AI CLI 已安装，并且在交互模式下登录过一次。aiflow 使用它们缓存的凭据。

1. 把 aiflow.zip 解压到固定目录，如 `D:\tools\aiflow`。
2. 在 PowerShell 中运行 `cd D:\tools\aiflow`，然后运行 `npm link`。之后任意目录都能用 `aiflow`。
3. 运行 `aiflow detect` 扫描工具，会自动选主工具；用 `aiflow main claude` 可以改。
4. 进入项目目录，先运行 `aiflow run default --task "需求" --dry-run`，确认每步的调用命令，再去掉 `--dry-run` 正式运行。

Windows 上可能遇到的问题：

- PowerShell 提示“禁止运行脚本”：执行一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，或者用 `aiflow.cmd`。
- 中文乱码：用 Windows Terminal；老式 CMD 先执行 `chcp 65001`。
- 不想全局安装：直接运行 `node D:\tools\aiflow\bin\aiflow.js <命令>`。
- 拍板时选 `e` 默认用记事本打开。想用 VS Code：`$env:EDITOR="code --wait"`。
- 建议在 git 仓库里运行：审核步骤靠 `git diff` 看改动，出问题也方便回滚。

## 桌面版（Windows 11）

桌面版和命令行用的是同一个引擎、同一份配置（`%USERPROFILE%\.aiflow\`）和同样的工作流文件，两边可以混着用。

| 方式 | 怎么做 | 适合 |
| --- | --- | --- |
| 安装包 | 双击 `build-desktop.bat`，完成后在 `release\` 里运行 `*-nsis.exe`（安装版）或 `*-portable.exe`（便携版） | 日常使用；会创建桌面快捷方式 |
| 直接运行 | 双击 `run-desktop.bat` | 自己改了代码想马上试 |
| 网页版 | 双击 `web-ui.bat`，或运行 `aiflow ui` | 不想装 Electron；界面完全相同 |

第一次构建要下载 Electron（约 100MB）和打包工具，脚本会问你是否使用国内镜像。打包时如果提示 "Cannot create symbolic link"，在 Windows 设置里打开“开发者模式”，或者用管理员身份运行脚本。

界面分五页：

- **运行**：选工作流、写需求、开始。左边是步骤时间线，紫色表示在等你；右边每个子 agent 一个日志标签页，实时显示输出和 🔧 工具/Skill 调用，每段都能打开它收到的提示词和它的输出。
- **工作流**：用下拉框换角色的工具，点步骤看提示词；改步骤用“编辑 JSON”。内置工作流保存时会另存到项目或用户目录。
- **工具**：检测、设主工具、查看每个 CLI 装了哪些 skill / 命令 / 插件 / MCP。
- **统计** 与 **设置**：同命令行的 `aiflow stats` 和 config.json。

需要你参与时会弹窗：拍板方案（可以直接在弹窗里编辑再通过）、回答子 agent 的问题、确认是否执行某一步。窗口不在前台时，任务栏会闪烁并发系统通知。前台子 agent 会在一个新的终端窗口里打开真实的 claude 或 agy；你在那个窗口里对话，输入 `/exit` 关闭后 aiflow 自动继续。如果窗口没有自己关闭，点“我已完成，继续”。

## 需求素材、产出物与运行记录

运行时可以附上需求素材，所有子 agent 都会先读素材再干活。桌面版在“需求”下方添加文件或链接，也可以直接拖进去；命令行用 `--file 文件` 和 `--link 网址`，都可以重复多次。

| 素材 | aiflow 怎么处理 |
| --- | --- |
| Word / PPT / Excel | 复制一份，并转成同名 `.md` 文字（文件里的图片不提取） |
| PDF / 图片 / 文本 | 原样复制，子 agent 用自己的 Read 工具查看 |
| Confluence 链接 | 在“设置 → 集成”填了令牌后，自动拉取页面正文转成 Markdown。云版填邮箱加 API token，内网版只填个人访问令牌 |
| Figma 链接 | 填了个人访问令牌后，把画板导出为 PNG 并提取界面文字；链接带 `node-id` 时只导出那个节点，最多 12 个画板 |
| 其他网页 | 抓取正文 |

取不到的链接（没配令牌、需要登录、网络不通）不会让流程失败：链接会写进素材清单，并要求子 agent 用它自己的 MCP（比如 Figma、Atlassian MCP）去访问。素材保存在 `.aiflow\runs\<时间>\inputs\`，清单是这个目录里的 `INDEX.md`。令牌只保存在本机的 config.json 里。

每次运行结束后会得到这些产出物，桌面版在“📄 成果”标签页和“记录”页里查看：

- **需求定稿**：`docs/aiflow/SPEC.md`，你拍板通过的版本。
- **实施方案**：`docs/aiflow/PLAN.md`。
- **代码检查报告**：最后一轮审核的结果。
- **代码变更**：和运行前的工作区对比得到的完整 diff，不包含你运行前就有的改动；只在 git 仓库里生成。
- **需求素材**：上面的素材清单。

要看某一步 agent 的输入和输出，在运行页点时间线上的那一步即可。弹窗左边是发给它的完整提示词，右边是它的输出，下方是你在这一步的回答和拍板。“记录”页能看到历次运行的同样信息，还能一键用同一个需求再跑一次。自己写工作流时，给步骤加 `"artifact": "名称"` 就会产生一个产出物。

## 前后端并行开发（git worktree 隔离）

`default` 和 `omc` 工作流里，后端和前端两个实现步骤会同时运行，各自在独立的 git worktree 里改代码，互不干扰：

1. 给当前工作区拍一个快照。快照包含你未提交的改动和新文件，但不动你的分支和暂存区。
2. 每个子步骤在 `.aiflow/worktrees/` 下的独立副本里开发，需求素材也会带进去。
3. 都完成后，在一个单独的集成副本里依次合并。遇到冲突会弹窗让你选：让主工具解决、自己手动解决（可以点“打开文件夹”），或终止。
4. 合并结果以未提交改动的形式应用回你的工作区，临时副本和分支自动删除。

因为两边看不到彼此的代码，实施方案步骤会要求把接口定义写完整、把前后端要改的文件分开，尽量避免冲突。如果项目不是 git 仓库，会改为依次执行。`.aiflow/` 会自动加入本地忽略列表 `.git/info/exclude`，不会被提交。

自己写并行组时，用 `{"type": "parallel", "isolation": "worktree", "steps": [ ... ]}`，组里只能放 `agent` 步骤。

## 同时运行多个任务

桌面版“任务”页里，每个任务单独选项目文件夹，可以连续提交多个任务。不同项目的任务同时运行；同一项目的任务自动排队，等前一个结束再开始，避免两个任务同时改一个工作区。这时“开始运行”按钮会变成“加入队列”。

- **上限**：同时运行的任务默认最多 3 个，在“设置 → 运行与后台”里改，范围 1–10。超出的任务排队，左侧任务列表会写明排队原因。
- **查看**：点任务列表里的任务，右边显示它自己的步骤、子 agent 日志和成果。状态有排队中、运行中、等你拍板、完成、失败、已停止。
- **拍板弹窗**：会写明来自哪个项目和哪个需求，并有“查看这个任务”链接。如果你正在编辑别的东西，弹窗不会打断你：右下角会显示“N 个任务在等你拍板”，关掉自己的窗口或点这个提示后再依次弹出。
- **停止**：每个任务单独停止，排队中的任务可以取消。

## 定时任务

到点后，定时任务会自动提交成一个普通任务，排队和并发规则同上，在任务列表里带 ⏰ 标记。在桌面版“定时”页新建，或者在“任务”页填好需求后点“设为定时任务…”。

| 设置 | 可选项 |
| --- | --- |
| 什么时候执行 | 每天、每周几、每隔 N 小时（整点）、只执行一次、cron 表达式。保存前会预览接下来 5 次的执行时间 |
| 无人值守 | 自动通过所有拍板；子 agent 的问题按它的推荐处理；需要你直接对话的步骤跳过；合并冲突交给主工具，两次解决不了就停止并保留 worktree。适合固定、明确的任务 |
| 等我拍板 | 到点开始执行；遇到拍板和提问会弹窗，并发系统通知等你处理 |

定时任务只在 aiflow 运行时才会执行：

- **桌面版**：有定时任务或有任务在跑时，关闭窗口会留在托盘继续执行，从托盘菜单才能真正退出。在“设置 → 运行与后台”里打开“开机自动启动”，开机后会直接在托盘里运行。
- **命令行**：运行 `aiflow scheduler`，没有界面，所有定时任务都按无人值守执行。
- 同一台电脑上只有一个 aiflow 进程负责调度，不会重复执行。
- aiflow 当时没开着而错过的执行：落后 10 分钟以内会补跑，更久的跳过，并在历史里记为“错过”。

命令行管理定时任务：

```
aiflow schedule list
aiflow schedule add --name "工作日巡检" --cwd D:\code\app --workflow quick --task "检查并修复 lint" --weekdays 09:00
aiflow schedule add ... --daily 21:00 | --every 3 | --at 2026-11-25T09:00 | --cron "0 9 * * 1-5"   加 --wait 表示等我拍板
aiflow schedule rm|enable|disable <id>
```

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `aiflow detect` | 扫描本机 AI CLI，记录路径和版本 |
| `aiflow tools` | 查看已检测的工具，★ 为主工具 |
| `aiflow main <工具id>` | 设置主工具 |
| `aiflow skills [工具id]` | 列出各工具已装的 skill、斜杠命令、子代理、插件、规则文件、MCP 配置 |
| `aiflow ask "问题" [--tool agy]` | 用主工具或指定工具快速问一句 |
| `aiflow wf list` | 列出可用工作流 |
| `aiflow wf show <名称>` | 查看工作流的角色分工、步骤、条件和循环 |
| `aiflow wf init [名称]` | 把内置工作流复制到项目 `.aiflow\workflows\` 便于自定义 |
| `aiflow run <工作流> --task "需求"` | 运行工作流；也可用 `--task-file 需求.md` |
| `... --dry-run` | 只打印每步会怎么调用，不执行 |
| `... --yes` | 所有拍板点自动通过，子 agent 提问按它的推荐处理 |
| `aiflow stats [--days 30]` | 各工具/角色/步骤的次数、成功率、耗时、超时、追问、费用 |

拍板时的按键：`y` 通过 · `e` 手动编辑后通过 · `r` 写意见让 AI 重做 · `n` 终止。子 agent 提问时，直接输入回答；输入 `auto` 让它按自己的推荐决定。

## 子 agent 使用各自的 skill / 插件 / MCP

子 agent 会自动使用各自的 skill、插件和 MCP，aiflow 不需要也不会替代它们。aiflow 只是在项目目录里启动真实的 CLI，每个 CLI 会按自己的规则加载全局和项目级配置。

| 工具 | 会加载的能力（主要位置） |
| --- | --- |
| claude | `~/.claude/skills`、`.claude/skills`、`.claude/commands`、`.claude/agents`、已装插件（如 oh-my-claudecode）、`CLAUDE.md`、`.mcp.json` |
| codex | `~/.codex/skills`、`~/.agents/skills`、`~/.codex/prompts`、`AGENTS.md`、`~/.codex/config.toml` 中的 MCP |
| agy | Antigravity CLI 的插件、skill 和 MCP（`~/.gemini/antigravity-cli/`）、`GEMINI.md` / `AGENTS.md` |
| gemini | `~/.gemini/extensions`、`~/.gemini/commands`、`GEMINI.md`、`settings.json` 中的 MCP |

这些路径是 `aiflow skills` 扫描的地方，属于尽力而为。CLI 版本变化后如有不对，可以在配置的 `overrides.<工具>.skillDirs` 里改。

三种用法，按控制力度从弱到强：

1. **自动触发**：什么都不配。子 agent 会根据任务自己决定是否用某个 skill，和你平时直接使用时一样。
2. **`use` 字段点名**：在步骤里写 `"use": ["deep-interview", "用 frontend-design skill 做界面"]`。aiflow 会在提示词末尾加一段“本步骤请优先使用以下能力”。前台、后台都有效。
3. **斜杠命令开头**：`interactive` 步骤的 `prompt` 以 `/` 开头时（如 `/deep-interview {{task}}`），会原样作为第一条消息发给 CLI，直接进入那个 skill。

还可以用步骤的 `args` 字段给这一步追加 CLI 参数，比如只在前端步骤挂一个浏览器 MCP：`"args": ["--mcp-config", ".mcp.frontend.json"]`（参数名以各 CLI 的 `--help` 为准）。

需要知道的限制：后台模式下，那些靠“弹出选项问你”来推进的 skill（比如深度访谈）没法把问题直接弹给你。这类 skill 请放在 `interactive` 步骤里用；后台步骤的问题走 `[[ASK]]` 协议交给你。后台运行 Claude 时，第一行会显示它加载了多少工具、MCP、skill 和插件，之后每次调用 Skill 或工具都会实时打印 `🔧 Skill xxx`，可以确认它确实用上了。

## 内置工作流

内置三个工作流：`default` 走完整流程，需求定稿和实施方案各拍板一次，前后端在独立 worktree 里并行开发；`omc` 把访谈换成 oh-my-claudecode 的 `/deep-interview`；`quick` 用于小改动。用 `aiflow wf show <名称>` 可以看到当前的分工。

&#91;embedded content: default 工作流 · 4 个拍板点，前后端 worktree 并行，含审核循环\]

审核结论为 PASS 时循环结束；跑满 3 轮仍未通过，会问你再来一轮、接受现状还是终止。

- **omc**：与 default 相同，但第一步以 `/deep-interview {{task}}` 进入 Claude，访谈结果从 `.omc/specs/` 收集；编码步骤用 `use` 要求 Claude 使用 OMC 的执行类 skill。前提是你的 Claude Code 已安装 OMC。
- **quick**：claude 实现 → codex 审核 → 你确认，不做访谈和方案。
- 自定义：`aiflow wf init default` 复制到项目里，改 `roles` 换人，改 `steps` 换流程。

## 工作流 JSON 参考

一个工作流就是一个 JSON 文件：`roles` 决定谁干哪类活，`steps` 决定做什么。查找顺序为：项目 `.aiflow\workflows\` → `%USERPROFILE%\.aiflow\workflows\` → 内置。新建一个文件就多一个工作流。

顶层字段：`name`、`description`、`roles`（角色 → 工具id，`@main` 表示主工具）、`askUser`（后台子 agent 是否可以向你提问，默认 true）、`steps`。

### 步骤类型

| type | 必填字段 | 作用 |
| --- | --- | --- |
| `agent` | `role` 或 `tool`、`prompt` | 一个后台子 agent 执行。不写 type 时默认是它 |
| `parallel` | `roles` 或 `tools`、`prompt` | 多个后台子 agent 同时做同一任务，用于交叉验证。只能只读 |
| `interactive` | `role` 或 `tool`、`prompt`，可选 `output` | 前台子 agent，你直接对话；退出后收集结果文件 |
| `approve` | `review`：被审步骤 id | 你拍板。被审步骤必须在同一层 |
| `write` | `from`、`to` | 把某步结果保存成文件 |
| `loop` | `steps`、`until`，可选 `max`（默认 3） | 重复执行内层步骤，直到 `until` 为真；到上限时问你：再来一轮、接受现状继续，或终止 |

### 通用字段

| 字段 | 含义 |
| --- | --- |
| `id` / `title` | 步骤标识和显示名 |
| `prompt` | 提示词；写成字符串数组时，每项一行 |
| `mode` | `read`（默认）或 `edit`（追加该工具的改代码权限参数） |
| `when` | 条件，不满足就跳过这一步 |
| `use` | 要求子 agent 优先使用的 skill / 命令 / MCP |
| `args` | 这一步额外追加的 CLI 参数 |
| `ask` | 是否允许这一步向你提问，覆盖顶层 `askUser` |
| `maxAsks` | 最多追问几轮（默认 5），超过后让它按自己的推荐决定 |
| `timeoutMin` | 超时分钟数，超时后杀掉整个进程树 |
| `output` | 仅 `interactive`：结果文件的通配路径，取本次会话中最新的一个；不写则要求子 agent 写入 aiflow 指定的文件 |
| `promptAs` | 仅 `interactive`：`direct` 表示把提示词原样作为第一条消息（以 `/` 开头时自动如此） |

### when 条件

- `"confirm:要做前端吗？"`：运行到这一步时问你 y/n。
- 其他情况写表达式，可用：`has('步骤id','文字')`、`output('步骤id')`、`ran('步骤id')`、`changed('src/web/')`（git 工作区在该路径下有改动）、`task`、`iter`（当前循环轮次）。例如：`"!has('plan','无前端改动')"`。

### 模板变量

`{{task}}` 需求 · `{{feedback}}` 你在拍板时写的重做意见 · `{{steps.<id>.output}}` 某步的结果 · `{{steps.<id>.outputs.<工具>}}` 并行步骤中某个工具的结果 · `{{iter}}` 循环轮次 · `{{runDir}}` 本次运行记录目录 · `{{outFile}}` interactive 步骤的结果文件路径。

### ASK 协议（后台子 agent 向你提问）

aiflow 会在后台步骤的提示词末尾自动加上约定：遇到拿不准、且影响结果的问题，就停下来，只输出 `[[ASK]] … [[/ASK]]` 问题块，可以附上选项和它的推荐。aiflow 显示问题后，把你的回答附在原任务后面再发一次。并行步骤里多个子 agent 同时提问时，会排队一个一个问你。审核类步骤建议设 `"ask": false`，让它直接给结论。

## 工具配置

配置文件在 `%USERPROFILE%\.aiflow\config.json`。运行 `aiflow detect` 会生成它；手工改动后再运行一次 `detect` 即可生效。

### 内置调用方式

| 工具 | 后台命令 | 改代码模式追加 | 前台交互启动 |
| --- | --- | --- | --- |
| claude | `claude -p --output-format stream-json --verbose` ← stdin | `--permission-mode acceptEdits` | `claude "首条消息"` |
| codex | `codex exec --skip-git-repo-check -` ← stdin | `--full-auto` | `codex "首条消息"` |
| agy | `agy -p "读取提示词文件"` | `--mode accept-edits` | `agy -i "首条消息"` |
| gemini | `gemini` ← stdin | `--approval-mode auto_edit` | `gemini -i "首条消息"` |
| opencode | `opencode run "读取提示词文件"` | — | `opencode --prompt "首条消息"` |

qwen、copilot、cursor 也在识别列表里，但它们的调用参数没有核实过。长提示词不会直接写在命令行里：要么走 stdin，要么写入文件后只传一句“去读这个文件”。这样可以避开 Windows 命令行 8191 字符的限制和引号转义问题。

### 覆盖内置工具：overrides

```json
{
  "overrides": {
    "codex": { "args": ["exec", "-m", "<模型名>", "{{EDIT}}", "--skip-git-repo-check", "-"] },
    "agy": { "promptVia": "stdin" }
  },
  "defaultTimeoutMin": 30
}
```

可以覆盖的字段有：`args`、`interactiveArgs`、`editArgs`、`promptVia`（`stdin` / `file` / `arg`）、`stream`、`skillDirs`、`path`（手动指定可执行文件）。占位符 `{{EDIT}}` 在 edit 模式下会替换成 `editArgs`，`{{PROMPT}}` 会替换成提示词或“读文件”指令。

### 同一个 CLI 配成不同模型：custom

```json
{
  "custom": {
    "claude-opus": {
      "name": "Claude 长任务", "bins": ["claude"],
      "args": ["-p", "--model", "opus", "--output-format", "stream-json", "--verbose", "{{EDIT}}"],
      "stream": "claude-json", "promptVia": "stdin",
      "editArgs": ["--permission-mode", "acceptEdits"],
      "interactiveArgs": ["--model", "opus", "{{EDIT}}", "{{PROMPT}}"]
    }
  }
}
```

配好后运行 `aiflow detect`，就能在 `roles` 里写 `"longTask": "claude-opus"`。模型名换成你账号里实际能用的。要接入其他 CLI（比如 Kimi），也在 `custom` 里按同样的字段添加。

## 用运行记录和统计优化工作流

每次运行都会在项目的 `.aiflow\runs\<时间>\` 下留下记录：`prompts\` 是发给每个子 agent 的完整提示词（追问重跑的文件名带 `.r1`、`.r2`），`outputs\` 是各自的结果，`run.json` 记录你的每次拍板、重做意见、回答和被跳过的步骤。所有调用还会追加到 `%USERPROFILE%\.aiflow\stats.jsonl`，供 `aiflow stats` 汇总。

根据信号调整：

| 你看到的信号 | 怎么调 |
| --- | --- |
| 同一个拍板点反复选 `r` 重做 | 把你常提的意见写进那一步的 `prompt` |
| 某个角色的成功率低或经常超时 | 换工具（改 `roles`），或调大 `timeoutMin` |
| 追问次数多 | 需求阶段不够清楚：加 `interactive` 访谈，或把常见答案写进项目的 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` |
| 审核循环经常跑满 3 轮 | 审核标准太严，或修复方不合适：对比各轮的 `review` 输出 |
| 小改动也要跑很久 | 另建一个精简工作流（实现 → 审核），或给重步骤加 `when: "confirm:..."` |
| 想对比哪个工具更适合某个角色 | 放进同一个 `parallel` 步骤跑同一任务，比较 `outputs\`（仅限只读任务） |

建议常备几个工作流，按任务大小选用：`quick`（小改动）、`default`（新功能）、`omc`（需求模糊、你的 Claude 装了 OMC）、`bugfix`（先定位再修复）。

## 常见问题与已知限制

- **agy 后台运行卡住或没有输出**：`agy -p` 被程序调用时（非 TTY）有已知问题，见 Antigravity CLI 的 GitHub issue #76 和 #318。aiflow 会关闭 stdin，并按 `timeoutMin` 杀进程。仍不行的话，可以把该角色改成 `gemini`，或者改用 `interactive` 步骤。
- **交互步骤退出后提示“没找到结果文件”**：子 agent 没有按约定写文件。可以选 `r` 重新进入并提醒它写入，选 `p` 手动指定文件，或选 `s` 跳过。
- **OMC 工作流**：`/deep-interview` 把规格写到 `.omc/specs/deep-interview-*.md`，aiflow 会取本次会话里最新的那个文件。访谈结束后，OMC 会问你下一步（如进入 ralplan 或 autopilot）。要让 aiflow 接管后续流程，就不要选这些，直接输入 `/exit`。
- **并行步骤不能改代码**：多个工具同时改同一个仓库会冲突，所以 aiflow 会直接拒绝 `parallel` + `edit`。
- **前台模式的第一条消息不能带换行**：工具是 `.cmd` 启动时（npm 安装的 CLI 通常是），换行会被替换成空格。长内容会自动改成“读取提示词文件”。
- **费用统计**：只有 Claude 的事件流会返回费用；订阅制账号显示的是换算值，不是实际扣费。其他工具只统计次数和耗时。
- **已验证范围**：所有流程都在 Linux 上用模拟 CLI 测试过；尚未在真实 Windows 和真实 CLI 上跑过。第一次使用请先加 `--dry-run`，并用 `quick` 这类小工作流试跑。
