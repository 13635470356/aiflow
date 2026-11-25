// 已知 AI CLI 工具注册表。
// args 中的占位符：
//   {{EDIT}}   -> 当步骤 mode 为 "edit" 时替换为 editArgs，否则删除
//   {{PROMPT}} -> promptVia 为 "arg"/"file" 时替换为提示词（file 模式会替换为"请读取某文件"的短指令）
// promptVia:
//   stdin -> 提示词通过标准输入传入（最稳，不受 Windows 命令行 8191 字符限制）
//   file  -> 提示词写入文件，命令行只传一句"去读这个文件"（适合不支持 stdin 的工具）
//   arg   -> 直接作为参数传入（仅短提示词）
// interactiveArgs: 交互模式（完整 TUI，和直接用该 CLI 一样）的启动参数
// 用户可在 ~/.aiflow/config.json 的 overrides 中覆盖任意字段。

export const KNOWN_TOOLS = {
  claude: {
    name: 'Claude Code',
    bins: ['claude'],
    winExtraPaths: ['%USERPROFILE%\\.local\\bin\\claude.exe', '%APPDATA%\\npm\\claude.cmd'],
    versionArgs: ['--version'],
    args: ['-p', '--output-format', 'stream-json', '--verbose', '{{EDIT}}'],
    stream: 'claude-json', // 解析事件流，实时显示工具调用/思考文本
    promptVia: 'stdin',
    editArgs: ['--permission-mode', 'acceptEdits'],
    interactiveArgs: ['{{EDIT}}', '{{PROMPT}}'],
    strengths: '主控、长任务推理、整合',
    // 用于 aiflow skills 列出能力；~ 为用户目录，. 为当前项目
    skillDirs: { skill: ['~/.claude/skills', './.claude/skills'], command: ['~/.claude/commands', './.claude/commands'], agent: ['~/.claude/agents', './.claude/agents'], plugin: ['~/.claude/plugins/installed_plugins.json'], rules: ['./CLAUDE.md', '~/.claude/CLAUDE.md'], mcp: ['./.mcp.json', '~/.claude.json'] },
  },
  codex: {
    name: 'Codex CLI',
    bins: ['codex'],
    winExtraPaths: ['%APPDATA%\\npm\\codex.cmd'],
    versionArgs: ['--version'],
    args: ['exec', '{{EDIT}}', '--skip-git-repo-check', '-'],
    promptVia: 'stdin',
    editArgs: ['--full-auto'],
    interactiveArgs: ['{{EDIT}}', '{{PROMPT}}'],
    strengths: '代码审核、参数检查',
    skillDirs: { skill: ['~/.codex/skills', '~/.agents/skills', './.agents/skills'], command: ['~/.codex/prompts'], rules: ['./AGENTS.md', '~/.codex/AGENTS.md'], mcp: ['~/.codex/config.toml'] },
  },
  agy: {
    name: 'Antigravity CLI',
    bins: ['agy'],
    winExtraPaths: ['%LOCALAPPDATA%\\Programs\\antigravity-cli\\agy.exe'],
    versionArgs: ['--version'],
    args: ['-p', '{{PROMPT}}', '{{EDIT}}'],
    promptVia: 'file',
    editArgs: ['--mode', 'accept-edits'],
    interactiveArgs: ['{{EDIT}}', '-i', '{{PROMPT}}'],
    strengths: '前端、需求理解（Gemini 模型）',
    skillDirs: { skill: ['~/.gemini/antigravity-cli/skills', '~/.agents/skills', './.agents/skills'], plugin: ['~/.gemini/antigravity-cli/plugins'], rules: ['./GEMINI.md', './AGENTS.md'], mcp: ['~/.gemini/antigravity-cli/settings.json'] },
    note: 'agy -p 在非 TTY 下有已知卡住/吞输出问题，已用超时兜底；不行可改用 gemini',
  },
  gemini: {
    name: 'Gemini CLI',
    bins: ['gemini'],
    winExtraPaths: ['%APPDATA%\\npm\\gemini.cmd'],
    versionArgs: ['--version'],
    args: ['{{EDIT}}'],
    promptVia: 'stdin',
    editArgs: ['--approval-mode', 'auto_edit'],
    interactiveArgs: ['{{EDIT}}', '-i', '{{PROMPT}}'],
    strengths: '前端',
    skillDirs: { skill: ['~/.gemini/skills', './.gemini/skills'], command: ['~/.gemini/commands', './.gemini/commands'], plugin: ['~/.gemini/extensions'], rules: ['./GEMINI.md', '~/.gemini/GEMINI.md'], mcp: ['~/.gemini/settings.json'] },
  },
  opencode: {
    name: 'OpenCode',
    bins: ['opencode'],
    winExtraPaths: ['%APPDATA%\\npm\\opencode.cmd'],
    versionArgs: ['--version'],
    args: ['run', '{{PROMPT}}'],
    promptVia: 'file',
    editArgs: [],
    interactiveArgs: ['--prompt', '{{PROMPT}}'],
    strengths: '多模型切换',
    skillDirs: { command: ['~/.config/opencode/command', './.opencode/command'], agent: ['~/.config/opencode/agent', './.opencode/agent'], rules: ['./AGENTS.md'] },
  },
  qwen: {
    name: 'Qwen Code',
    bins: ['qwen'],
    versionArgs: ['--version'],
    args: ['-p', '{{PROMPT}}', '{{EDIT}}'],
    promptVia: 'file',
    editArgs: ['--yolo'],
    interactiveArgs: ['-i', '{{PROMPT}}'],
    unverified: true,
  },
  copilot: {
    name: 'GitHub Copilot CLI',
    bins: ['copilot'],
    versionArgs: ['--version'],
    args: ['-p', '{{PROMPT}}', '{{EDIT}}'],
    promptVia: 'file',
    editArgs: ['--allow-all-tools'],
    interactiveArgs: ['-i', '{{PROMPT}}'],
    unverified: true,
  },
  cursor: {
    name: 'Cursor Agent',
    bins: ['cursor-agent'],
    versionArgs: ['--version'],
    args: ['-p', '{{PROMPT}}', '{{EDIT}}'],
    promptVia: 'file',
    editArgs: ['--force'],
    interactiveArgs: ['{{PROMPT}}'],
    unverified: true,
  },
};
