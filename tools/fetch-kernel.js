// ============================================================
// tools/fetch-kernel.js —— 打包前把 pi 内核装进 vendor/pi
// 跑法：npm run dist:kernel（npm run dist 会自动先跑这一步）
//
// 为什么不直接拷全局 node_modules：全局目录 1.4GB（混着 opencode、
// volcengine 等无关包），干净安装只拉 pi 自己的依赖树，还能锁版本。
// 版本取本机全局装的 pi（开发时验收过的就是它），取不到才装最新。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'pi');
const PKG = '@earendil-works/pi-coding-agent';

// 版本来源：按 pi-bridge.findPiCli 同样的前缀顺序找全局安装的 package.json
function installedVersion() {
  const prefixes = [
    process.env.npm_config_prefix,
    'E:/npm-global',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null
  ].filter(Boolean);
  for (const pre of prefixes) {
    try {
      const pj = JSON.parse(fs.readFileSync(
        path.join(pre, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
      if (pj && pj.version) return pj.version;
    } catch (e) { /* 试下一个前缀 */ }
  }
  return '';
}

function dirSize(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, it.name);
      if (it.isDirectory()) walk(f);
      else { try { bytes += fs.statSync(f).size; } catch (e) { /* 忽略读不了的 */ } }
    }
  };
  try { walk(dir); } catch (e) { /* 目录不存在按 0 */ }
  return bytes;
}

function main() {
  const ver = installedVersion();
  console.log('[kernel] 目标版本：' + PKG + (ver ? '@' + ver : '（本机没找到全局安装，装最新）'));

  fs.rmSync(VENDOR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR, { recursive: true });

  // spawn npm.cmd 必须 shell:true（Node 安全补丁 CVE-2024-27980 后的规矩，
  // PixelAgent 主进程 check-updates 里踩过同一个坑）
  const spec = ver ? PKG + '@' + ver : PKG;
  const r = spawnSync('npm',
    ['install', spec, '--prefix', VENDOR, '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'error'],
    { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error || (r.status !== 0 && r.status !== null)) {
    console.error('[kernel] npm install 失败（exit ' + r.status + '）');
    process.exit(1);
  }

  // 自检：cli.js 必须在预期位置，否则打出来的包是个空壳
  const cli = path.join(VENDOR, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.error('[kernel] cli.js 不在预期位置：' + cli);
    process.exit(1);
  }

  fs.writeFileSync(path.join(ROOT, 'vendor', 'kernel-version.txt'), PKG + '@' + (ver || 'latest') + '\n', 'utf8');
  console.log('[kernel] OK —— cli.js 就位，node_modules 共 ' + (dirSize(path.join(VENDOR, 'node_modules')) / 1048576).toFixed(1) + ' MB');
}

main();
