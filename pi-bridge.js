// ============================================================
// pi-bridge.js —— Pi 后端桥（纯 Node，不依赖 Electron）
// 职责：找到 node 和 pi 的入口 -> spawn 子进程 ->
//       逐行解析 JSON 事件流 -> 用回调把事件吐给上层
// 这样写的好处：主进程 main.js 能用，命令行测试脚本也能直接用，
// 两处共用同一份"接线代码"，不会出现测试过了、界面没过的情况。
// ============================================================
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// pi 包的入口文件（package.json 里 bin.pi 指向 dist/bundle/cli.js）
const PI_CLI_REL = ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'];

// ---------- 找 node：不能用 electron 自带的 node，必须是系统里的真 node ----------
function findNode() {
  // 1) 允许环境变量直接指定
  if (process.env.PIXELAGENT_NODE && fs.existsSync(process.env.PIXELAGENT_NODE)) {
    return process.env.PIXELAGENT_NODE;
  }
  // 2) 扫 PATH 找 node.exe / node
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, 'node' + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  // 3) 兜底：直接叫 node（靠 PATH 让系统自己解析）
  return 'node';
}

// ---------- 找 pi 的 cli.js：npm 全局前缀里翻 ----------
function findPiCli() {
  // 1) 环境变量直连
  if (process.env.PIXELAGENT_PI_CLI && fs.existsSync(process.env.PIXELAGENT_PI_CLI)) {
    return process.env.PIXELAGENT_PI_CLI;
  }
  // 2) 已知前缀 + npm 配置前缀
  const prefixes = [
    process.env.npm_config_prefix,
    'E:/npm-global',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
    '/usr/local',
    '/usr',
    path.join(process.env.HOME || '', '.npm-global')
  ].filter(Boolean);

  for (const pre of prefixes) {
    const p = path.join(pre, ...PI_CLI_REL);
    if (fs.existsSync(p)) return p;
  }
  // 3) 从 PATH 里带 pi/pi.cmd 的目录反推 npm 全局前缀
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    if (fs.existsSync(path.join(dir, 'pi')) || fs.existsSync(path.join(dir, 'pi.cmd'))) {
      const p = path.join(dir, ...PI_CLI_REL);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// 对外暴露：把定位结果缓存起来，也方便测试脚本打印
function locate() {
  const node = findNode();
  const cli = findPiCli();
  return { node, cli };
}

/**
 * 组装 pi 的命令行参数（不含 node / cli 本身）。
 * 抽成纯函数是为了能单测 —— 这里的顺序有个真踩过的坑：
 * 附件必须作为**独立的 argv**，排在 prompt 之前。
 * 一旦把 "@路径 问题" 拼成一个字符串，pi 会把整串当成一个文件路径，
 * 报 "File not found: E:\...\a.png 这张图里有什么…"。
 */
function buildArgs(opts) {
  const args = ['-p', '--mode', 'json'];

  // 额外参数（扩展 / 模型 / 思考档位），由调用方拼好
  if (Array.isArray(opts.extraArgs) && opts.extraArgs.length) args.push(...opts.extraArgs);

  // 会话参数也是选项，必须排在 @ 文件之前
  if (opts.noSession) args.push('--no-session');
  else if (opts.sessionFile) args.push('--session', opts.sessionFile);

  // 附件：一律给绝对路径（pi 按 cwd 解析相对路径，绝对路径最稳）
  if (Array.isArray(opts.attachments) && opts.attachments.length) {
    for (const a of opts.attachments) {
      if (a) args.push('@' + path.resolve(a));
    }
  }

  args.push(opts.prompt);   // 用户的话永远是最后一个参数
  return args;
}

/**
 * 发一轮问话。
 * @param {object} opts
 * @param {string} opts.prompt        用户这一轮的话
 * @param {string[]} [opts.attachments] 附件的绝对路径（图片/文本），会以 @path 形式传给 pi
 * @param {string} opts.sessionFile   会话文件路径（多轮记忆靠它）
 * @param {boolean} [opts.noSession]  true = 不留会话（单次问答）
 * @param {string} [opts.agentDir]    pi 配置目录（PI_CODING_AGENT_DIR），用于跟终端里的 pi 隔离
 * @param {(ev:object)=>void} opts.onEvent  每解析出一行 JSON 事件就回调
 * @param {(s:string, d:any)=>void} [opts.onState] 状态回调（THINKING/TOOL/DONE...）
 * @param {(info:object)=>void} [opts.onExit] 进程结束回调
 * @returns {{child: object, abort: ()=>void}}
 */
function ask(opts) {
  const { node, cli } = locate();
  if (!cli) {
    const err = new Error('找不到 pi 的入口文件 cli.js（请设置环境变量 PIXELAGENT_PI_CLI）');
    if (opts.onExit) opts.onExit({ code: -1, error: err.message });
    return { child: null, abort() {} };
  }

  // 会话目录先建好，否则 pi 可能写不进去
  if (!opts.noSession && opts.sessionFile) {
    try { fs.mkdirSync(path.dirname(opts.sessionFile), { recursive: true }); } catch (e) { /* ignore */ }
  }

  // 组装参数：一律用数组传参，绝不拼字符串，避免引号/空格/中文被 shell 吃掉
  const args = [cli, ...buildArgs(opts)];

  if (opts.onState) opts.onState('THINKING', '启动 pi');

  const env = Object.assign({}, process.env, { PI_OFFLINE: process.env.PI_OFFLINE || '' });
  // 配置目录隔离：不共用终端里那份 ~/.pi/agent，免得互相抢锁
  if (opts.agentDir) env.PI_CODING_AGENT_DIR = opts.agentDir;

  const child = spawn(node, args, {
    // stdin 必须断开（ignore，等于 /dev/null）：pi 在 stdin 是管道时会一直等，
    // 表现为整个进程卡死。绝不能用 inherit / 建 pty。
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: opts.cwd || process.cwd(),
    env
  });

  // 标准输出按行切：pi 输出的是"换行分隔的 JSON"（NDJSON）
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    // 一次可能攒了好几行，也可能半行，所以循环切
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (e) {
        // 不是 JSON 的行（比如 pi 的告警）当日志丢出去，不要让整个流崩掉
        if (opts.onEvent) opts.onEvent({ type: 'raw_line', line });
        continue;
      }
      if (opts.onEvent) opts.onEvent(ev);
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });

  child.on('error', (e) => {
    if (opts.onExit) opts.onExit({ code: -1, error: e.message, stderr });
  });

  child.on('close', (code) => {
    // 收尾：可能最后一行没带换行
    const rest = buf.trim();
    if (rest) {
      try {
        if (opts.onEvent) opts.onEvent(JSON.parse(rest));
      } catch (e) { /* 忽略残缺行 */ }
    }
    if (opts.onExit) opts.onExit({ code, stderr: stderr.trim() });
  });

  return {
    child,
    abort() {
      try { child.kill(); } catch (e) { /* 已经退出就算了 */ }
    }
  };
}

module.exports = { ask, locate, buildArgs };
