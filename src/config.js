import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_TOOLS } from './registry.js';

export const HOME_DIR = process.env.AIFLOW_HOME || path.join(os.homedir(), '.aiflow');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const BUILTIN_WF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

const DEFAULT_CONFIG = {
  main: null,          // 主工具 id
  detected: {},        // id -> { path, version, detectedAt }
  overrides: {},       // id -> 覆盖注册表字段，例如 { "agy": { "promptVia": "stdin" } }
  custom: {},          // 自定义工具，字段同注册表
  defaultTimeoutMin: 30,
};

export function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return CONFIG_FILE;
}

/** 合并注册表 + 自定义 + 覆盖，得到某工具的最终定义 */
export function toolDef(cfg, id) {
  const base = KNOWN_TOOLS[id] || cfg.custom[id];
  if (!base) return null;
  return { id, ...base, ...(cfg.overrides[id] || {}) };
}

export function allToolIds(cfg) {
  return [...new Set([...Object.keys(KNOWN_TOOLS), ...Object.keys(cfg.custom)])];
}

/** 工作流查找顺序：项目 .aiflow/workflows -> ~/.aiflow/workflows -> 内置 */
export function workflowDirs(cwd) {
  return [path.join(cwd, '.aiflow', 'workflows'), path.join(HOME_DIR, 'workflows'), BUILTIN_WF_DIR];
}

export function listWorkflows(cwd) {
  const seen = new Map();
  for (const dir of workflowDirs(cwd)) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5);
      if (!seen.has(name)) seen.set(name, path.join(dir, f));
    }
  }
  return seen;
}

export function loadWorkflow(cwd, nameOrPath) {
  let file = nameOrPath;
  if (!fs.existsSync(file)) file = listWorkflows(cwd).get(nameOrPath);
  if (!file) throw new Error(`找不到工作流: ${nameOrPath}（用 aiflow wf list 查看）`);
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  wf.__file = file;
  return wf;
}

/** 列出工作流及来源：project | user | builtin（同名时前者优先） */
export function listWorkflowsDetailed(cwd) {
  const scopes = ['project', 'user', 'builtin'];
  const seen = new Map();
  workflowDirs(cwd).forEach((dir, i) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5);
      if (seen.has(name)) continue;
      let description = '';
      try { description = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).description || ''; } catch { description = '(JSON 格式错误)'; }
      seen.set(name, { name, file: path.join(dir, f), scope: scopes[i], description });
    }
  });
  return [...seen.values()];
}

/** 保存工作流：scope = project（需 cwd）| user。内置工作流不能直接改，保存时会落到 project/user。 */
export function saveWorkflow(cwd, scope, name, wf) {
  if (!/^[\w.-]+$/.test(name)) throw new Error('工作流名称只能包含字母、数字、_ - .');
  const dir = scope === 'project' ? workflowDirs(cwd)[0] : workflowDirs(cwd)[1];
  fs.mkdirSync(dir, { recursive: true });
  const { __file, ...clean } = wf;
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(clean, null, 2));
  return file;
}

export function deleteWorkflow(file) {
  if (file.startsWith(BUILTIN_WF_DIR)) throw new Error('内置工作流不能删除');
  fs.unlinkSync(file);
}
