/* ============================================================
   test/probe-trash.js —— 单独验 `shell.trashItem` 的真实行为
   ------------------------------------------------------------
   跑法：electron test/probe-trash.js

   为什么要单独留这么一个脚本：
   「删除会话」的 IPC 曾经回报 TRASH_FAILED，但文件明明从目录里消失了 ——
   看起来像"删除失败"，其实是 trashItem **把文件移走之后仍然 reject**。
   这两种情况的修法完全相反（一个是重试/降级，一个是改判定依据），
   光看报错猜不出来，必须把三件事**同时**打出来才能定性：
     · 抛没抛、抛的是什么
     · 文件还在不在
     · 再调一次会怎样（不存在的路径会报什么）

   做法上就是最朴素的变量隔离：不猜，直接量。
   ============================================================ */
'use strict';

const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '_trash_probe');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'probe-target.txt');
  fs.writeFileSync(f, 'trash probe\n', 'utf8');
  console.log('建好:', f, '存在=', fs.existsSync(f));

  try {
    await shell.trashItem(f);
    console.log('trashItem: resolved（成功）');
  } catch (e) {
    console.log('trashItem: REJECTED');
    console.log('  name   =', e && e.name);
    console.log('  message=', e && e.message);
    console.log('  code   =', e && (e.code || e.errno));
  }
  console.log('调用后文件还在吗:', fs.existsSync(f));

  // 再对同一个路径调一次：文件已经没了，报的错和刚才不一样 ——
  // 这正好说明「抛异常」并不等于「没删掉」。
  try {
    await shell.trashItem(f);
    console.log('二次 trashItem: resolved');
  } catch (e) {
    console.log('二次 trashItem: REJECTED ->', e && e.message);
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.exit(0);
});
