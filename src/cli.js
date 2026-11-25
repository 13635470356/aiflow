import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, toolDef, allToolIds, listWorkflows, loadWorkflow, workflowDirs, BUILTIN_WF_DIR } from './config.js';
import { detectAll } from './detect.js';
import { runWorkflow, resolveTool } from './runner.js';
import { createCliUi, c } from './ui-cli.js';
import { computeStats } from './stats.js';
import { inspectSkills } from './skills.js';

const HELP = `
aiflow — 本机 AI 编程 CLI 编排器

  aiflow detect                     扫描本机 AI CLI（claude/codex/agy/gemini/opencode...）
  aiflow tools                      查看已检测工具
  aiflow main <工具id>              设置主工具
  aiflow ask "<提示词>" [--tool id] 用主工具（或指定工具）快速问一句
  aiflow wf list                    列出可用工作流
  aiflow wf show <名称>             查看工作流的分工
  aiflow wf init [名称]             把内置工作流复制到当前项目 .aiflow/workflows/ 以便自定义
  aiflow run <工作流> --task "<需求>" | --task-file <文件> [--file 素材 ...] [--link 网址 ...] [--dry-run] [--yes]
                                    --file 可多次：Word/PPT/Excel/PDF/图片等；--link 可多次：Confluence/Figma/网页
  aiflow skills [工具id]            列出各工具已安装的 skill/命令/子代理/插件/规则/MCP
  aiflow stats [--days 30]          各工具/角色的调用次数、成功率、耗时、费用、提问次数
  aiflow schedule list               查看定时任务
  aiflow schedule add --name 名称 --task "需求" [--workflow quick] [--cwd 项目路径]
         (--daily 09:00 | --weekdays 09:00 | --every 3 | --at 2026-11-25T09:00 | --cron "0 9 * * 1-5") [--wait]
  aiflow schedule rm|enable|disable <id>
  aiflow scheduler                  后台执行定时任务（无界面，全部按无人值守执行；桌面版开着时不需要它）
  aiflow ui [--port 7788]           网页模式：在浏览器里使用图形界面（无需安装桌面版）
`;

function parseArgs(argv) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (k === 'file' || k === 'link') (opts[k] ||= []).push(v);
      else opts[k] = v;
    } else pos.push(a);
  }
  return { pos, opts };
}

function printTools(cfg) {
  console.log('');
  for (const id of allToolIds(cfg)) {
    const d = toolDef(cfg, id), hit = cfg.detected[id];
    const star = cfg.main === id ? c.yellow('★ 主') : '    ';
    const status = hit ? c.green('✔ ' + hit.version.padEnd(14)) : c.dim('✘ 未安装'.padEnd(16));
    console.log(`${star} ${id.padEnd(9)} ${status} ${d.name}${d.unverified ? c.dim(' (调用参数未验证)') : ''}`);
    if (hit) console.log(c.dim(`          ${hit.path}`));
  }
  console.log('');
}

async function runCli(wf, opts) {
  const ui = createCliUi();
  try {
    const r = await runWorkflow(wf, { ...opts, ui, cli: true });
    if (!r.ok) process.exitCode = 1;
  } finally { ui.close(); }
}

export async function main(argv) {
  const { pos, opts } = parseArgs(argv);
  const cmd = pos[0];
  const cwd = process.cwd();
  const cfg = loadConfig();

  switch (cmd) {
    case 'detect': {
      console.log('扫描中...');
      cfg.detected = Object.fromEntries(Object.entries(detectAll(cfg)).filter(([, v]) => v));
      if (!cfg.main || !cfg.detected[cfg.main]) {
        cfg.main = ['claude', 'codex', 'agy', 'gemini', 'opencode'].find((id) => cfg.detected[id]) || Object.keys(cfg.detected)[0] || null;
        if (cfg.main) console.log(c.yellow(`自动设置主工具为 ${cfg.main}（可用 aiflow main <id> 修改）`));
      }
      const f = saveConfig(cfg);
      printTools(cfg);
      console.log(c.dim(`配置已保存：${f}`));
      break;
    }
    case 'tools':
      printTools(cfg);
      break;
    case 'main': {
      const id = pos[1];
      if (!cfg.detected[id]) throw new Error(`${id} 未检测到。已安装：${Object.keys(cfg.detected).join(', ') || '无（先 aiflow detect）'}`);
      cfg.main = id; saveConfig(cfg);
      console.log(c.green(`主工具已设为 ${id}`));
      break;
    }
    case 'ask': {
      const wf = { name: 'ask', __file: 'ask', steps: [{ id: 'ask', type: 'agent', tool: opts.tool || '@main', prompt: pos.slice(1).join(' ') }] };
      await runCli(wf, { task: '', cfg, cwd, dryRun: !!opts['dry-run'] });
      break;
    }
    case 'wf': {
      const sub = pos[1];
      if (sub === 'list' || !sub) {
        for (const [name, file] of listWorkflows(cwd)) {
          const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
          console.log(`${name.padEnd(16)} ${wf.description || ''} ${c.dim(file)}`);
        }
      } else if (sub === 'show') {
        const wf = loadWorkflow(cwd, pos[2]);
        console.log(c.bold(`\n${wf.name}`) + `  ${wf.description || ''}\n\n角色分工：`);
        for (const [role, tool] of Object.entries(wf.roles || {})) console.log(`  ${role.padEnd(12)} → ${tool === '@main' ? `@main (${cfg.main})` : tool}`);
        console.log('\n步骤：');
        const show = (steps, depth) => steps.forEach((s) => {
          if (!s) return;
          const t = s.type || 'agent';
          const who = t === 'parallel' && s.steps ? c.dim('worktree 并行') : t === 'parallel' ? (s.roles || s.tools || []).map((r) => resolveTool(r, wf, cfg)).join(' + ')
            : ['agent', 'interactive'].includes(t) ? resolveTool(s.tool || s.role, wf, cfg) : '';
          const flags = [s.mode === 'edit' && c.yellow('可改代码'), t === 'interactive' && c.yellow('你直接对话'),
            s.when && c.dim(`when: ${s.when}`), t === 'loop' && c.dim(`最多 ${s.max ?? 3} 轮 until: ${s.until}`),
            s.use && c.dim(`use: ${s.use.join(', ')}`)].filter(Boolean).join(' ');
          console.log(`${'  '.repeat(depth + 1)}• [${t.padEnd(11)}] ${(s.title || s.id).padEnd(20)} ${c.cyan(who)} ${flags}`);
          if (t === 'loop' || (t === 'parallel' && s.steps)) show(s.steps, depth + 1);
        });
        show(wf.steps, 0);
        console.log('');
      } else if (sub === 'init') {
        const name = pos[2] || 'default';
        const src = path.join(BUILTIN_WF_DIR, `${name}.json`);
        const dest = path.join(workflowDirs(cwd)[0], `${name}.json`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest)) throw new Error(`${dest} 已存在`);
        fs.copyFileSync(src, dest);
        console.log(c.green(`已复制到 ${dest}，修改 roles 即可调整分工`));
      }
      break;
    }
    case 'run': {
      const wf = loadWorkflow(cwd, pos[1] || 'default');
      const task = opts['task-file'] ? fs.readFileSync(opts['task-file'], 'utf8') : opts.task;
      if (!task) throw new Error('需要 --task "需求描述" 或 --task-file 需求.md');
      const inputs = { files: (opts.file || []).map((f) => path.resolve(cwd, f)), links: opts.link || [] };
      for (const f of inputs.files) if (!fs.existsSync(f)) throw new Error(`素材文件不存在：${f}`);
      await runCli(wf, { task, inputs, cfg, cwd, dryRun: !!opts['dry-run'], autoApprove: !!opts.yes });
      break;
    }
    case 'skills': {
      const ids = pos[1] ? [pos[1]] : Object.keys(cfg.detected);
      for (const id of ids) {
        const def = toolDef(cfg, id);
        if (!def) { console.log(c.red(`未知工具 ${id}`)); continue; }
        console.log(c.bold(`\n${id} · ${def.name}`));
        const info = inspectSkills(def, cwd);
        if (!Object.keys(info).length) { console.log(c.dim('  未发现（或未配置 skillDirs）')); continue; }
        const label = { skill: 'Skill', command: '斜杠命令', agent: '子代理', plugin: '插件', rules: '规则文件', mcp: 'MCP 配置' };
        for (const [kind, list] of Object.entries(info)) for (const { path: p, items } of list) {
          console.log(`  ${(label[kind] || kind).padEnd(8)} ${c.dim(p)}`);
          if (items[0] !== '(存在)') console.log(`           ${items.slice(0, 30).join('  ')}${items.length > 30 ? c.dim(` …共 ${items.length} 个`) : ''}`);
        }
      }
      console.log(c.dim('\n这些能力由各 CLI 自己加载；在工作流步骤里用 "use": [...] 指定要优先使用的能力。'));
      break;
    }
    case 'stats': {
      const st = computeStats(Number(opts.days || 30));
      if (!st.total) { console.log('还没有统计数据'); break; }
      const table = (title, rows) => {
        console.log(c.bold(`\n${title}`));
        console.log(c.dim('  名称                         次数  成功率  平均耗时   超时  追问  费用(USD)'));
        for (const a of rows)
          console.log(`  ${a.name.padEnd(28)} ${String(a.n).padStart(4)}  ${(a.okRate * 100).toFixed(0).padStart(5)}%  ${(a.avgMs / 1000).toFixed(0).padStart(6)}s  ${String(a.timeout).padStart(5)}  ${String(a.asks).padStart(4)}  ${a.cost ? a.cost.toFixed(3) : '-'}`);
      };
      console.log(c.dim(`最近 ${st.days} 天，共 ${st.total} 次调用`));
      table('按工具', st.byTool); table('按角色 → 工具', st.byRole); table('按工作流步骤', st.byStep);
      break;
    }
    case 'schedule': {
      const S = await import('./schedule.js');
      const sub = pos[1] || 'list';
      if (sub === 'list') {
        const list = S.loadSchedules();
        if (!list.length) console.log('还没有定时任务');
        for (const x of list) {
          console.log(`${x.enabled ? c.green('●') : c.dim('○')} ${x.id}  ${c.bold(x.name)}  ${S.describeWhen(x.when)}  ${c.dim(x.approval === 'wait' ? '等我拍板' : '无人值守')}`);
          console.log(c.dim(`    ${x.cwd} · ${path.basename(x.workflow, '.json')} · 下次 ${x.nextRun ? new Date(x.nextRun).toLocaleString() : '-'} · 上次 ${x.lastStatus || '-'}`));
        }
      } else if (sub === 'add') {
        const when = opts.cron ? { kind: 'cron', expr: opts.cron } : opts.at ? { kind: 'once', at: opts.at } : opts.every ? { kind: 'interval', hours: +opts.every }
          : opts.weekdays ? { kind: 'weekly', days: [1, 2, 3, 4, 5], time: opts.weekdays } : { kind: 'daily', time: opts.daily || '09:00' };
        const wcwd = path.resolve(opts.cwd || cwd);
        const wf = loadWorkflow(wcwd, opts.workflow || 'quick');
        const x = S.upsertSchedule({ name: opts.name, cwd: wcwd, workflow: wf.__file, task: opts['task-file'] ? fs.readFileSync(opts['task-file'], 'utf8') : opts.task, inputs: { files: (opts.file || []).map((f) => path.resolve(cwd, f)), links: opts.link || [] }, when, approval: opts.wait ? 'wait' : 'auto' });
        console.log(c.green(`已添加 ${x.id}：${S.describeWhen(x.when)}，下次 ${new Date(x.nextRun).toLocaleString()}`));
        if (x.approval === 'wait') console.log(c.yellow('"等我拍板"的计划需要桌面版开着（或 aiflow ui），由界面弹窗拍板。'));
      } else if (sub === 'rm') { S.deleteSchedule(pos[2]); console.log('已删除'); }
      else if (sub === 'enable' || sub === 'disable') { S.setEnabled(pos[2], sub === 'enable'); console.log('已更新'); }
      break;
    }
    case 'scheduler': {
      const S = await import('./schedule.js');
      const { JobManager } = await import('./jobs.js');
      const stamp = () => new Date().toLocaleTimeString();
      const mgr = new JobManager({
        makeUi: (job) => {
          const tag = c.cyan(`[${path.basename(job.cwd)}#${job.id}]`);
          return {
            event(type, d) {
              if (type === 'step') console.log(`${stamp()} ${tag} ━━ ${d.title}`);
              else if (type === 'info' && d.level !== 'dim') console.log(`${stamp()} ${tag} ${d.text}`);
              else if (type === 'tool-done') console.log(`${stamp()} ${tag} ${d.tool} ${d.ok ? '完成' : '失败'} ${(d.ms / 1000).toFixed(0)}s`);
              else if (type === 'artifact') console.log(`${stamp()} ${tag} 📄 ${d.title}：${d.file}`);
              else if (type === 'error') console.log(`${stamp()} ${tag} ${c.red('✘ ' + d.message)}`);
              else if (type === 'done') console.log(`${stamp()} ${tag} ${c.green('✔ 完成')} ${d.runDir}`);
            },
            approve: async () => ({ decision: 'y' }), answer: async () => 'auto', confirm: async () => false,
            choose: async ({ options }) => options[0].key, pickFile: async () => null, interactive: async () => 0,
          };
        },
        onChange: (j) => { if (j.status === 'queued' && j.queuedReason) console.log(`${stamp()} [${j.project}#${j.id}] 排队：${j.queuedReason}`); },
      });
      S.startScheduler({
        owner: 'cli',
        onLog: (lvl, t) => console.log(`${stamp()} ${lvl === 'warn' ? c.yellow(t) : t}`),
        onDue: async (x) => {
          if (x.approval === 'wait') console.log(c.yellow(`${stamp()} 计划"${x.name}"设置为"等我拍板"，命令行后台模式没有界面，改为无人值守执行`));
          mgr.start({ cwd: x.cwd, workflow: x.workflow, task: x.task, inputs: x.inputs, autoApprove: true, source: 'schedule', scheduleId: x.id, scheduleName: x.name });
        },
      });
      console.log(c.green('aiflow 定时任务后台已启动，按 Ctrl+C 退出。'));
      process.on('SIGINT', () => { mgr.stopAll(); process.exit(0); });
      await new Promise(() => {});
      break;
    }
    case 'ui': {
      const { startServer } = await import('../desktop/server.js');
      const { url } = await startServer({ port: Number(opts.port || 7788), open: !opts['no-open'] });
      console.log(c.green(`aiflow 图形界面已启动：${url}`));
      console.log(c.dim('只监听本机 127.0.0.1；关闭这个窗口即退出。'));
      await new Promise(() => {});
      break;
    }
    default:
      console.log(HELP);
  }
}
