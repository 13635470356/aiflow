import { which, runSync } from './proc.js';
import { allToolIds, toolDef } from './config.js';

/** 扫描本机所有已知/自定义 AI CLI，返回 { id: {path, version} | null } */
export function detectAll(cfg) {
  const result = {};
  for (const id of allToolIds(cfg)) {
    const def = toolDef(cfg, id);
    let found = null;
    for (const bin of def.bins || [id]) {
      const p = def.path || which(bin, def.winExtraPaths || []);
      if (p) { found = p; break; }
    }
    if (!found) { result[id] = null; continue; }
    const v = runSync(found, def.versionArgs || ['--version'], 10000);
    const version = (v.out.match(/\d+\.\d+(\.\d+)?[\w.-]*/) || [v.out.trim().split('\n')[0] || '?'])[0];
    result[id] = { path: found, version, detectedAt: new Date().toISOString() };
  }
  return result;
}
