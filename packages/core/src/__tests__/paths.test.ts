import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { expandHome } from '../tools/paths.js';

describe('expandHome（~ 展开）', () => {
  it('~/ 前缀展开为主目录', () => {
    expect(expandHome('~/work/code/foo')).toBe(`${homedir()}/work/code/foo`);
  });

  it('单独的 ~ 展开为主目录', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('普通绝对路径保持不变', () => {
    expect(expandHome('/home/alice/work')).toBe('/home/alice/work');
  });

  it('非 ~ 开头的相对路径保持不变', () => {
    expect(expandHome('src/main.ts')).toBe('src/main.ts');
    expect(expandHome('')).toBe('');
  });
});
