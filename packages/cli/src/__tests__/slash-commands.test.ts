import { describe, expect, it } from 'vitest';
import { isSlashCommand, SLASH_COMMANDS, parseShellArgs } from '../slash-commands.js';

describe('isSlashCommand（斜杠命令路由判定）', () => {
  it('已注册命令（含别名、带参数）识别为命令', () => {
    expect(isSlashCommand('/exit')).toBe(true);
    expect(isSlashCommand('/quit')).toBe(true);
    expect(isSlashCommand('/q')).toBe(true);
    expect(isSlashCommand('/model deepseek-v4-pro')).toBe(true);
    expect(isSlashCommand('/plan off')).toBe(true);
    expect(isSlashCommand('/compact 项目背景')).toBe(true);
    expect(isSlashCommand('/prices')).toBe(true);
    expect(isSlashCommand('/prices check')).toBe(true);
    expect(isSlashCommand('/update')).toBe(true);
    expect(isSlashCommand('/mcp add github -- npx -y @modelcontextprotocol/server-github')).toBe(true);
    expect(isSlashCommand('/skills')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isSlashCommand('/EXIT')).toBe(true);
    expect(isSlashCommand('/Help')).toBe(true);
  });

  it('绝对路径等以 / 开头的普通输入不是命令', () => {
    expect(isSlashCommand('/Users/edy/work/code/nginx-rs')).toBe(false);
    expect(isSlashCommand('/etc/hosts')).toBe(false);
    expect(isSlashCommand('/tmp/abc def')).toBe(false);
  });

  it('非斜杠、空输入、单独 / 不是命令', () => {
    expect(isSlashCommand('你好')).toBe(false);
    expect(isSlashCommand('   ')).toBe(false);
    expect(isSlashCommand('')).toBe(false);
    expect(isSlashCommand('/')).toBe(false);
  });

  it('未知斜杠命令按未知命令处理；/budget 已退役但仍在本地给出提示', () => {
    expect(isSlashCommand('/foobar')).toBe(false);
    expect(isSlashCommand('/unknown cmd')).toBe(false);
    expect(isSlashCommand('/budget')).toBe(true);
    expect(SLASH_COMMANDS).not.toContain('/budget');
  });

  it('SLASH_COMMANDS 为命令名列表（首个词匹配依据）', () => {
    expect(Array.isArray(SLASH_COMMANDS)).toBe(true);
    expect(SLASH_COMMANDS).toContain('/exit');
    expect(SLASH_COMMANDS).toContain('/clear');
    expect(SLASH_COMMANDS).toContain('/prices');
    expect(SLASH_COMMANDS).toContain('/update');
    expect(SLASH_COMMANDS).toContain('/mcp');
    expect(SLASH_COMMANDS).toContain('/skills');
  });
});

describe('parseShellArgs（斜杠子命令参数解析）', () => {
  it('按空白切分普通参数', () => {
    expect(parseShellArgs('add foo -- npx -y pkg')).toEqual(['add', 'foo', '--', 'npx', '-y', 'pkg']);
  });

  it('双引号保留空格与转义引号', () => {
    expect(parseShellArgs('add "my server" -- "npx -y" "a\\"b"')).toEqual(['add', 'my server', '--', 'npx -y', 'a"b']);
  });

  it('单引号内原样保留', () => {
    expect(parseShellArgs("add 'x y' -- 'a b'")).toEqual(['add', 'x y', '--', 'a b']);
  });

  it('空引号产生空 token，连续空白被忽略', () => {
    expect(parseShellArgs('add "" --   cmd')).toEqual(['add', '', '--', 'cmd']);
  });

  it('不带引号直接返回原 token', () => {
    expect(parseShellArgs('--url http://x --headers A=B')).toEqual(['--url', 'http://x', '--headers', 'A=B']);
  });
});
