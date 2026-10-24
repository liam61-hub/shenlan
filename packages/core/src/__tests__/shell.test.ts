import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '../tools/index.js';
import { getTool } from '../tools/index.js';
import {
  listBackgroundTasks,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_TIMEOUT_MS,
} from '../tools/shell.js';

// shell.ts 顶层副作用注册 shell / shell_status / shell_kill
await import('../tools/shell.js');

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractBgId(content: string): string {
  const m = content.match(/\(id: (bg-[a-z0-9]+)\)/);
  if (!m) throw new Error(`no bg id in: ${content}`);
  return m[1];
}

let shellTool: Tool;
beforeAll(() => {
  shellTool = getTool('shell')!;
  expect(shellTool).toBeTruthy();
});

afterEach(async () => {
  // 清理仍在运行的后台任务，避免测试泄漏进程
  const kill = getTool('shell_kill')!;
  for (const task of listBackgroundTasks()) {
    if (task.status === 'running') {
      await kill.execute({ id: task.id });
    }
  }
});

describe('shell 工具', () => {
  it('快速命令正常返回输出', async () => {
    const r = await shellTool.execute({ command: 'echo hi' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('hi');
  });

  it('非零退出码返回明确错误（不再出现 Command exited with code null）', async () => {
    const r = await shellTool.execute({ command: 'exit 3' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Command exited with code 3');
    expect(r.content).not.toContain('code null');
  });

  it('超时后不杀进程：转后台并返回部分输出，shell_status 可查到最终结果', async () => {
    // Windows 走 cmd.exe（spawn shell:true）：`;` 不是分隔符且 sleep 不存在，
    // `echo start; sleep...` 会被当成 echo 的文本整体输出并立即退出；改用 cmd 语法
    const cmd = process.platform === 'win32'
      ? 'echo start & ping -n 2 127.0.0.1 >nul & echo done'
      : 'echo start; sleep 1.5; echo done';
    const r = await shellTool.execute({
      command: cmd,
      timeout: 300,
    });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('Command timed out after');
    expect(r.content).toContain('Command timed out after 300ms'); // 亚秒级超时不再显示 "0 seconds"
    expect(r.content).toContain('still running in the background');
    expect(r.content).toContain('start'); // 已捕获的部分输出

    const id = extractBgId(r.content);
    expect(listBackgroundTasks().some((t) => t.id === id)).toBe(true);

    // 刚转后台时状态 running
    const running = await getTool('shell_status')!.execute({ id });
    expect(running.content).toContain('running');

    // 等待命令完成后，shell_status 反映 completed + exit 0
    await wait(2200);
    const done = await getTool('shell_status')!.execute({ id });
    expect(done.content).toContain('completed');
    expect(done.content).toContain('exit 0');
    expect(done.content).toContain('done');
  });

  it('shell_kill 可终止后台命令', async () => {
    const cmd = process.platform === 'win32'
      ? 'ping -n 31 127.0.0.1 >nul'
      : 'sleep 30';
    const r = await shellTool.execute({ command: cmd, timeout: 300 });
    const id = extractBgId(r.content);

    const killed = await getTool('shell_kill')!.execute({ id });
    expect(killed.content).toContain('Killed background command');

    const st = await getTool('shell_status')!.execute({ id });
    expect(st.content).toContain('killed');

    // 再 kill 一次：提示已非 running
    const again = await getTool('shell_kill')!.execute({ id });
    expect(again.content).toContain('not running');
  });

  it('未知 id 返回错误', async () => {
    const st = await getTool('shell_status')!.execute({ id: 'bg-00000000' });
    expect(st.isError).toBe(true);
    expect(st.content).toContain('Unknown background command id');
  });

  it('默认与最大超时对齐 Claude Code（120s / 600s）', () => {
    expect(SHELL_DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(SHELL_MAX_TIMEOUT_MS).toBe(600_000);
  });
});
