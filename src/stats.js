// 统计：读取 ~/.aiflow/stats.jsonl 并按工具/角色/步骤汇总（CLI 和桌面版共用）
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';

export function computeStats(days = 30) {
  const f = path.join(HOME_DIR, 'stats.jsonl');
  if (!fs.existsSync(f)) return { total: 0, days, byTool: [], byRole: [], byStep: [] };
  const since = Date.now() - days * 86400000;
  const recs = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && Date.parse(r.at) >= since);
  const agg = (keyFn) => {
    const m = new Map();
    for (const r of recs) {
      const k = keyFn(r);
      const a = m.get(k) || { name: k, n: 0, ok: 0, ms: 0, cost: 0, timeout: 0, asks: 0 };
      a.n++; a.ok += r.ok ? 1 : 0; a.ms += r.ms || 0; a.cost += r.costUsd || 0;
      a.timeout += r.timedOut ? 1 : 0; a.asks += r.round > 0 ? 1 : 0;
      m.set(k, a);
    }
    return [...m.values()].map((a) => ({ ...a, okRate: a.ok / a.n, avgMs: a.ms / a.n })).sort((x, y) => y.n - x.n);
  };
  return {
    total: recs.length,
    days,
    byTool: agg((r) => `${r.tool} (${r.kind === 'interactive' ? '交互' : '后台'})`),
    byRole: agg((r) => `${r.role || '-'} → ${r.tool}`),
    byStep: agg((r) => `${r.workflow}/${r.step}`),
  };
}
