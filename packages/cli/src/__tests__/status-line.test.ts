import { describe, expect, it } from 'vitest';
import { buildStatusLine } from '../components/InputBox.js';
import { displayWidth } from '../markdown-utils.js';

describe('buildStatusLine（输入框下方常驻状态行）', () => {
  const MODEL = 'deepseek-v4-flash';
  const CWD = '/Users/edy/work/code/shenlan';

  it('短 cwd 原样显示', () => {
    expect(buildStatusLine(MODEL, 'default', CWD, 200)).toBe(
      `${MODEL} · NORMAL · ${CWD}`,
    );
  });

  it('长 cwd 左侧截断且保留 basename', () => {
    const longCwd = `${CWD}/packages/cli/src/components`;
    const line = buildStatusLine(MODEL, 'default', longCwd, 50);
    expect(line).toMatch(/^deepseek-v4-flash · NORMAL · …/);
    expect(line.endsWith('components')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(50);
  });

  it('极窄宽度仍有 …', () => {
    expect(buildStatusLine(MODEL, 'default', CWD, 5)).toBe('…');
    expect(buildStatusLine(MODEL, 'default', CWD, 20)).toContain('…');
  });

  it('非 default 模式显示对应标签', () => {
    expect(buildStatusLine(MODEL, 'plan', CWD, 200)).toBe(
      `${MODEL} · PLAN · ${CWD}`,
    );
    expect(buildStatusLine(MODEL, 'bypassPermissions', CWD, 200)).toBe(
      `${MODEL} · BYPASS · ${CWD}`,
    );
    expect(buildStatusLine(MODEL, 'acceptEdits', CWD, 200)).toBe(
      `${MODEL} · ACCEPT EDITS · ${CWD}`,
    );
  });
});

describe('buildStatusLine（CJK 显示宽度预算）', () => {
  it('中文 cwd 按显示宽度预算，短 cwd 原样显示', () => {
    const cwd = 'D:\\工作\\项目\\深蓝';
    const line = buildStatusLine('deepseek-v4-flash', 'default', cwd, 200);
    expect(line).toBe(`deepseek-v4-flash · NORMAL · ${cwd}`);
    expect(displayWidth(line)).toBeLessThanOrEqual(200);
  });

  it('长中文 cwd 截断后总宽不超预算且保留 basename 尾部', () => {
    // 前缀 displayWidth = 17+3+6+3 = 29；basename 深蓝工作目录 12 列 + … 1 列 = 42 → 宽度 44 装得下
    const cwd = 'D:\\用户\\项目\\很长的中文路径名称测试\\深蓝工作目录';
    const line = buildStatusLine('deepseek-v4-flash', 'default', cwd, 44);
    expect(displayWidth(line)).toBeLessThanOrEqual(44);
    expect(line.endsWith('深蓝工作目录')).toBe(true);
    expect(line).toContain('…');
    // 更窄（40）时 basename 放不下，只保留尾部一部分
    const narrow = buildStatusLine('deepseek-v4-flash', 'default', cwd, 40);
    expect(displayWidth(narrow)).toBeLessThanOrEqual(40);
  });

  it('中文 cwd 极窄宽度退化为 …', () => {
    expect(buildStatusLine('deepseek-v4-flash', 'default', 'D:\\工作', 6)).toBe('…');
  });
});
