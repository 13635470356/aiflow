// 命令行界面适配器：把引擎事件打印到终端，并用 stdin 收集拍板/回答
import readline from 'node:readline';
import path from 'node:path';
import { runInteractive, openInEditor } from './proc.js';

export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// 行队列输入：交互子 agent 运行时暂停，避免抢 stdin
const input = { rl: null, lines: [], waiters: [], ended: false };
function inputStart() {
  if (input.rl || input.ended) return;
  input.rl = readline.createInterface({ input: process.stdin, terminal: false });
  input.rl.on('line', (l) => (input.waiters.length ? input.waiters.shift()(l) : input.lines.push(l)));
  input.rl.on('close', () => {
    input.rl = null;
    if (!process.stdin.isTTY && process.stdin.readableEnded) input.ended = true;
    while (input.waiters.length) input.waiters.shift()(null);
  });
}
export function inputPause() { if (input.rl) { const r = input.rl; input.rl = null; r.removeAllListeners('close'); r.close(); } }
async function ask(q) {
  inputStart();
  process.stdout.write(q);
  const l = input.lines.length ? input.lines.shift() : input.ended ? null : await new Promise((r) => input.waiters.push(r));
  if (l == null) throw new Error('输入已结束，无法继续拍板（可加 --yes 自动通过）');
  if (!process.stdin.isTTY) console.log(l);
  return l.trim();
}
async function pick(q, keys) { for (;;) { const a = (await ask(q)).toLowerCase(); if (keys.includes(a)) return a; } }

export function createCliUi() {
  let depth = 0;
  const pad = () => '  '.repeat(depth);
  const tag = (t) => c.cyan(`[${t}]`);
  return {
    event(type, d) {
      switch (type) {
        case 'run-start': console.log(c.bold(`\n▶ 主控 aiflow · 工作流 ${d.workflow} · 主工具 ${d.main} · 记录 ${path.relative(process.cwd(), d.runDir)}`)); break;
        case 'step': depth = d.depth; console.log(c.bold(`\n${pad()}━━ ${d.title} ${c.dim(`[${d.type}]`)} ━━`)); break;
        case 'skip': console.log(c.dim(`${pad()}  ↷ 条件不满足，跳过（when: ${d.when}）`)); break;
        case 'info': {
          const f = { ok: c.green, warn: c.yellow, err: c.red, dim: c.dim, info: c.bold }[d.level] || ((s) => s);
          console.log(pad() + f(d.text)); break;
        }
        case 'tool-start':
          if (d.interactive) console.log(c.bold(c.cyan(`\n▶ 进入 ${d.tool} 交互模式`)) + c.dim('（和直接使用一样；完成后输入 /exit 回到 aiflow）'));
          console.log(`${tag(d.tool)} ${c.dim(d.cmd)}`); break;
        case 'tool-line': for (const l of d.text.split('\n')) console.log(`${tag(d.tool)} ${d.stream === 'stderr' ? c.dim(l) : l}`); break;
        case 'tool-use': console.log(`${tag(d.tool)} ${c.magenta('🔧 ' + d.name)} ${c.dim(d.detail)}`); break;
        case 'tool-meta': console.log(`${tag(d.tool)} ${c.dim(d.text)}`); break;
        case 'tool-done':
          console.log(`${tag(d.tool)} ${d.timedOut ? c.red('超时终止') : d.ok ? c.green('完成') : c.red('失败' + (d.code != null ? ' 退出码 ' + d.code : ''))} ${c.dim((d.ms / 1000).toFixed(0) + 's' + (d.cost ? ` · $${d.cost.toFixed(4)}` : ''))}`); break;
        case 'artifact': console.log(c.green(`${pad()}📄 产出物「${d.title}」：${path.relative(process.cwd(), d.file)}`)); break;
        case 'done': console.log(c.green(c.bold(`\n✔ 工作流完成。全部提示词/输出在 ${path.relative(process.cwd(), d.runDir)}，用 aiflow stats 查看工具表现`))); break;
        case 'error': console.error(c.red(`\n✘ ${d.message}`)); break;
      }
    },
    async approve({ content, file }) {
      console.log(`\n${content || '(无内容)'}\n`);
      console.log(c.yellow(`内容已保存：${path.relative(process.cwd(), file)}`));
      const d = await pick(c.bold('拍板？ [y]通过 / [e]手动编辑后通过 / [r]提意见让AI重做 / [n]终止 > '), ['y', 'e', 'r', 'n']);
      if (d === 'e') { inputPause(); openInEditor(file); return { decision: 'e' }; }
      if (d === 'r') return { decision: 'r', feedback: await ask('你的修改意见：') };
      return { decision: d };
    },
    async answer({ tool, stepId, questions }) {
      console.log(c.yellow(`\n${tag(tool)} 需要你拍板（${stepId}）：`) + `\n${questions}\n`);
      return ask(c.bold(`回答 ${tool}（可一次答多条；输入 auto 让它按推荐决定）> `));
    },
    async confirm({ question }) { return (await pick(c.yellow(`${question} [y/n] > `), ['y', 'n'])) === 'y'; },
    async choose({ question, options }) {
      return pick(c.yellow(`${question}。${options.map((o) => `[${o.key}]${o.label}`).join(' / ')} > `), options.map((o) => o.key));
    },
    async pickFile() { return ask('文件路径：'); },
    async interactive({ exe, args, cwd }) {
      inputPause();
      const code = await runInteractive(exe, args, { cwd });
      console.log(c.bold(c.cyan('\n◀ 已返回 aiflow')));
      return code;
    },
    close: inputPause,
  };
}
