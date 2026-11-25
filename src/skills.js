// 列出各 AI CLI 已安装的 skill / 斜杠命令 / 子代理 / 插件 / 规则文件 / MCP 配置（尽力而为，路径可在 config overrides 中改）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expand = (p, cwd) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(cwd, p));

function listEntries(p, kind) {
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  if (st.isFile()) {
    if (kind === 'plugin' && p.endsWith('installed_plugins.json')) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Object.keys(j.plugins || j || {});
      } catch { return ['(无法解析)']; }
    }
    return ['(存在)'];
  }
  return fs.readdirSync(p).filter((f) => !f.startsWith('.')).map((f) => f.replace(/\.(md|toml|json)$/, ''));
}

export function inspectSkills(def, cwd) {
  const out = {};
  for (const [kind, paths] of Object.entries(def.skillDirs || {})) {
    for (const raw of paths) {
      const p = expand(raw, cwd);
      const items = listEntries(p, kind);
      if (items) (out[kind] ??= []).push({ path: p, items });
    }
  }
  return out;
}
