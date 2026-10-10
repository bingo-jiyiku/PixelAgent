// ============================================================
// test/pi-wire.test.js —— Pi 接线单测（真的调一次 pi，不模拟）
// 跑法：npm run test:pi
// 验证三件事：
//   1) 能定位到 node 和 pi 的 cli.js
//   2) 能把 pi 的 JSON 事件流解析出来，并实时打印 text_delta
//   3) 会话（--session）能记住上一轮，实现多轮对话
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const bridge = require('../pi-bridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 跑一轮 pi，把事件流收下来
function run(opts) {
  return new Promise((resolve) => {
    const deltas = [];
    const tools = [];
    let thinking = '';
    let states = [];
    let err = '';
    const t0 = Date.now();

    const job = bridge.ask({
      prompt: opts.prompt,
      sessionFile: opts.sessionFile,
      noSession: opts.noSession,
      onEvent(ev) {
        if (ev.type === 'message_update' && ev.assistantMessageEvent) {
          const a = ev.assistantMessageEvent;
          if (a.type === 'text_delta') {
            deltas.push(a.delta);
            if (opts.live) process.stdout.write(a.delta);   // 打字机实时打印
          } else if (a.type === 'thinking_delta') {
            thinking += a.delta;
          } else if (a.type === 'toolcall_end') {
            tools.push((a.toolCall && a.toolCall.name) || '?');
          }
        } else if (ev.type === 'turn_end' && ev.message) {
          states.push(`${ev.message.provider}/${ev.message.model}`);
        }
      },
      onState(s) { if (opts.verbose) console.log('   [state]', s); },
      onExit(info) {
        err = info.error || (info.stderr ? info.stderr.slice(-300) : '');
        resolve({
          text: deltas.join(''),
          deltas,
          tools,
          thinking,
          model: states[0] || '',
          code: info.code,
          ms: Date.now() - t0,
          err
        });
      }
    });
    if (opts.live) {
      // 无输出 40 秒就认为卡住了，交给超时处理
      setTimeout(() => { try { job.abort(); } catch (e) {} }, 40000);
    }
  });
}

(async () => {
  console.log('===== 【1】定位 pi =====');
  const loc = bridge.locate();
  console.log('node :', loc.node);
  console.log('pi   :', loc.cli);
  if (!loc.cli) { console.log('❌ 找不到 pi 入口'); process.exit(1); }
  console.log('cli 文件存在:', fs.existsSync(loc.cli));

  console.log('\n===== 【2】单轮：真实调用 + 实时打印 text_delta =====');
  console.log('提问: 只回答两个字：你好');
  const a = await run({ prompt: '只回答两个字：你好', noSession: true, live: true });
  console.log('\n--- 解析结果 ---');
  console.log('text_delta 条数 :', a.deltas.length);
  console.log('拼出来的全文   :', JSON.stringify(a.text));
  console.log('模型           :', a.model);
  console.log('退出码 / 耗时  :', a.code, '/', a.ms + 'ms');
  console.log('思考片段       :', JSON.stringify(a.thinking.slice(0, 40)));

  const ok2 = a.code === 0 && a.deltas.length > 0 && a.text.trim().length > 0;
  console.log(ok2 ? '✅ 单轮流式解析通过' : '❌ 单轮失败: ' + a.err);

  console.log('\n===== 【3】多轮：同一个 session 连续对话 =====');
  const ses = path.join(__dirname, 'tmp-session.json');
  try { fs.unlinkSync(ses); } catch (e) { /* 第一次跑没有文件 */ }

  const r1 = await run({ prompt: '记住：我最喜欢的数字是 42。只回答“已记住”。', sessionFile: ses, live: false });
  console.log('第1轮回复 :', JSON.stringify(r1.text), '| 模型:', r1.model, '| 退出码:', r1.code);
  console.log('会话文件生成:', fs.existsSync(ses));

  const r2 = await run({ prompt: '我最喜欢的数字是多少？只回答数字。', sessionFile: ses, live: false });
  console.log('第2轮回复 :', JSON.stringify(r2.text), '| 退出码:', r2.code);

  const ok3 = r1.code === 0 && r2.code === 0 && /42/.test(r2.text);
  console.log(ok3 ? '✅ 多轮会话记忆通过（第2轮答出 42）' : '❌ 多轮失败: ' + (r2.err || '没记住'));

  console.log('\n===== 结论 =====');
  console.log(ok2 && ok3 ? '✅ Pi 接线全部通过' : '❌ 有失败项');
  process.exit(ok2 && ok3 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
