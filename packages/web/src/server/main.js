#!/usr/bin/env node
// Entry point: `node packages/web/src/server/main.js` (in the image: `node server/main.js`).
import { loadConfig } from './config.js';
import { makeLogger, VERSION, WebServer } from './server.js';
import { createSearch } from '../search/search.js';

const cfg = loadConfig();
const log = makeLogger();
const server = new WebServer(cfg, { log, searchFactory: createSearch });

let stopping = false;
async function stop(sig) {
  if (stopping) return;
  stopping = true;
  log.info(`收到 ${sig}，正在停止`);
  const t = setTimeout(() => process.exit(0), 5000);
  t.unref();
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

try {
  await server.init();
  const addr = await server.listen();
  log.info(`MD Viewer Web ${VERSION} 已启动，端口 ${addr.port}，登录：${cfg.auth === 'on' ? '已启用' : '未启用'}`);
} catch (e) {
  log.error('启动失败：' + (e && e.message));
  process.exit(1);
}
