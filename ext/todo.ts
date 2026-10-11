/**
 * PixelAgent todo 扩展
 * ------------------------------------------------------------
 * 为什么需要它：pi 本体**不带** todo 工具（官方只在 examples/extensions/todo.ts
 * 给了个示例，没装）。所以右栏 TODOS tab 如果只靠 pi 原生能力，永远是空的 ——
 * 那就成了占位。这里给 pi 补一个真的 todo 工具，tab 才有真数据。
 *
 * 状态存哪：存在工具结果的 details 里（和 pi 官方示例同一套设计），不落外部文件。
 * 好处是会话分叉（branch）时 todo 状态会自动跟着分支走，不需要额外同步。
 *
 * 为什么一个外部依赖都不引：ext/ 目录往上找 node_modules 只能找到 PixelAgent 自己的
 * （只有 electron / fontsource），找不到 typebox、pi-tui。所以 parameters 直接用
 * JSON Schema，渲染也不注册（TUI 里的渲染由 pi 兜底）。
 *
 * 双路输出：内容里除了给人看的列表，还带一行机器可读标记 PIXELTODOS:{...}。
 * 原因：tool_execution_end 事件到底透不透传 details 没把握（之前已经踩过
 * tool_execution_end 没有 args 的坑），所以让前端能从文本里再抓一次，两条路都不落空。
 */

const MARK = 'PIXELTODOS:';

export default function (pi) {
  /** @type {{id:number,text:string,done:boolean}[]} */
  let todos = [];
  let nextId = 1;

  // 从当前分支的历史里重建状态（会话恢复 / 分叉后都要重来一遍）
  const reconstruct = (ctx) => {
    todos = [];
    nextId = 1;
    let branch = [];
    try { branch = ctx.sessionManager.getBranch() || []; } catch (e) { return; }
    for (const entry of branch) {
      if (!entry || entry.type !== 'message') continue;
      const m = entry.message;
      if (!m || m.role !== 'toolResult' || m.toolName !== 'todo') continue;
      const d = m.details;
      if (d && Array.isArray(d.todos)) {
        todos = d.todos;
        nextId = typeof d.nextId === 'number' ? d.nextId : 1;
      }
    }
  };

  pi.on('session_start', async (_e, ctx) => reconstruct(ctx));
  pi.on('session_tree', async (_e, ctx) => reconstruct(ctx));

  const snapshot = (action, error) => ({
    action,
    todos: todos.map((t) => ({ id: t.id, text: t.text, done: !!t.done })),
    nextId,
    ...(error ? { error } : {})
  });

  // 人看的文本 + 机器可读标记，一次给全
  const reply = (humanText, details) => ({
    content: [{ type: 'text', text: humanText + '\n' + MARK + JSON.stringify(details) }],
    details
  });

  const listText = () => (todos.length
    ? todos.map((t) => `[${t.done ? 'x' : ' '}] #${t.id}: ${t.text}`).join('\n')
    : 'No todos');

  pi.registerTool({
    name: 'todo',
    label: 'Todo',
    description:
      'Manage a todo list for the current task. Actions: ' +
      'list (show all), add (needs text), toggle (needs id), remove (needs id), clear (drop all). ' +
      'Use it to plan multi-step work and to mark progress as you go.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'toggle', 'remove', 'clear'],
          description: 'list = show todos, add = create one, toggle = flip done state, remove = delete one, clear = delete all'
        },
        text: { type: 'string', description: 'Todo text. Required for add.' },
        id: { type: 'number', description: 'Todo id. Required for toggle and remove.' }
      },
      required: ['action'],
      additionalProperties: false
    },

    async execute(_toolCallId, params) {
      const p = params || {};
      switch (p.action) {
        case 'list':
          return reply(listText(), snapshot('list'));

        case 'add': {
          if (!p.text) return reply('Error: text required for add', snapshot('add', 'text required'));
          const t = { id: nextId++, text: String(p.text), done: false };
          todos.push(t);
          return reply('Added todo #' + t.id + ': ' + t.text, snapshot('add'));
        }

        case 'toggle': {
          if (p.id === undefined) return reply('Error: id required for toggle', snapshot('toggle', 'id required'));
          const t = todos.find((x) => x.id === p.id);
          if (!t) return reply('Todo #' + p.id + ' not found', snapshot('toggle', '#' + p.id + ' not found'));
          t.done = !t.done;
          return reply('Todo #' + t.id + ' ' + (t.done ? 'completed' : 'reopened'), snapshot('toggle'));
        }

        case 'remove': {
          if (p.id === undefined) return reply('Error: id required for remove', snapshot('remove', 'id required'));
          const i = todos.findIndex((x) => x.id === p.id);
          if (i < 0) return reply('Todo #' + p.id + ' not found', snapshot('remove', '#' + p.id + ' not found'));
          const gone = todos.splice(i, 1)[0];
          return reply('Removed todo #' + gone.id + ': ' + gone.text, snapshot('remove'));
        }

        case 'clear': {
          const n = todos.length;
          todos = [];
          nextId = 1;
          return reply('Cleared ' + n + ' todo(s)', snapshot('clear'));
        }

        default:
          return reply('Unknown action: ' + p.action, snapshot('list', 'unknown action: ' + p.action));
      }
    }
  });
}
