import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runWizard } from '../wizard.js';

const originalStdin = process.stdin;
const originalStdout = process.stdout;

/**
 * 用预置答案替换 stdin（readline 注入），stdout 换成 PassThrough 收集。
 * 答案逐条在独立 macrotask 写入且不 end 流：ask() 的 promise 续体（microtask）
 * 会在下一条答案到达前注册下一个 question；若一次性 end 全部答案，readline 会在
 * 同步处理完所有行后立即关闭接口，后续 rl.question 抛 "readline was closed"。
 * 流由向导末尾 rl.close() 自行关闭。
 */
function injectStdio(answers: string[]): void {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  for (const answer of answers) {
    setImmediate(() => {
      stdin.write(answer + '\n');
    });
  }
}

function restoreStdio(): void {
  Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true });
}

function readConfig(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, '.shenlan', 'config.json'), 'utf-8'));
}

function readGlobalConfig(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
}

function logText(spy: MockInstance): string {
  return spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

describe('runWizard — 多 provider 配置向导', () => {
  let cwd: string;
  let globalDir: string;
  let fetchMock: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shenlan-wizard-'));
    globalDir = mkdtempSync(join(tmpdir(), 'shenlan-wizard-global-'));
    process.env.SHENLAN_CONFIG_DIR = globalDir;
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.SHENLAN_CONFIG_DIR;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreStdio();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('单 provider（deepseek + pro）：写入 providerKeys 与 model.model，默认模型直接采用', async () => {
    injectStdio(['g', '1', 'sk-ds-1', '2']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ deepseek: 'sk-ds-1' });
    expect(cfg.model.model).toBe('deepseek-v4-pro');
    // 全新配置：baseUrl 置空，由 resolveBaseUrl 自动解析
    expect(cfg.model.baseUrl).toBe('');
    // 默认写全局，项目配置不存在
    expect(existsSync(join(cwd, '.shenlan', 'config.json'))).toBe(false);
    expect(result).toEqual({
      providers: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
      defaultModel: 'deepseek-v4-pro',
    });
    expect(logText(logSpy)).toContain('Setup complete');
    expect(logText(logSpy)).toContain('DeepSeek → deepseek-v4-pro');
  });

  it('双 provider（1,2）：两个 key 落盘，默认模型按末步选择写入', async () => {
    injectStdio(['g', '1,2', 'sk-ds-2', '1', 'sk-qwen-2', '2', '2']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ deepseek: 'sk-ds-2', qwen: 'sk-qwen-2' });
    expect(cfg.model.model).toBe('qwen-plus');
    // 两个 provider 各做一次连通性测试
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      providers: [
        { provider: 'deepseek', model: 'deepseek-v4-flash' },
        { provider: 'qwen', model: 'qwen-plus' },
      ],
      defaultModel: 'qwen-plus',
    });
  });

  it('空 key 取消该 provider：providerKeys 不含 qwen', async () => {
    injectStdio(['g', '1,2', 'sk-ds-3', '1', '']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ deepseek: 'sk-ds-3' });
    expect('qwen' in (cfg.providerKeys ?? {})).toBe(false);
    expect(cfg.model.model).toBe('deepseek-v4-flash');
    expect(result.providers).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
  });

  it('选择 p 作用域：密钥写入项目 .shenlan/config.json', async () => {
    injectStdio(['p', '1', 'sk-proj-1', '1']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readConfig(cwd);
    expect(cfg.providerKeys).toEqual({ deepseek: 'sk-proj-1' });
    // 全局配置未被创建
    expect(existsSync(join(globalDir, 'config.json'))).toBe(false);
    expect(result.providers).toHaveLength(1);
  });

  it('预置含 mcpServers/自定义字段的 config.json：重跑向导后字段保留，原 baseUrl 不动', async () => {
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      model: { baseUrl: 'https://custom.example.com', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
      permissions: { mode: 'default', allow: ['read'], deny: [] },
      skills: [],
      mcpServers: [{ name: 'filesystem', transport: 'stdio', command: 'npx' }],
      customField: { keep: 'me' },
    }, null, 2), 'utf-8');
    injectStdio(['p', '1', 'sk-ds-4', '2']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readConfig(cwd);
    expect(cfg.providerKeys.deepseek).toBe('sk-ds-4');
    expect(cfg.model.model).toBe('deepseek-v4-pro');
    expect(cfg.model.baseUrl).toBe('https://custom.example.com');
    expect(cfg.mcpServers).toEqual([{ name: 'filesystem', transport: 'stdio', command: 'npx' }]);
    expect(cfg.customField).toEqual({ keep: 'me' });
    expect(result.defaultModel).toBe('deepseek-v4-pro');
  });

  it('连通性测试失败（HTTP 500）：黄色警告但流程完成、配置已落盘', async () => {
    injectStdio(['g', '1', 'sk-ds-5', '1']);
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys.deepseek).toBe('sk-ds-5');
    const out = logText(logSpy);
    expect(out).toContain('HTTP 500');
    expect(out).toContain('Setup complete');
    expect(result.providers).toHaveLength(1);
  });

  it('qwen 单独配置：默认模型 qwen-turbo，连通性测试走 dashscope 且带 Bearer', async () => {
    injectStdio(['g', '2', 'sk-qwen-1', '']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ qwen: 'sk-qwen-1' });
    expect(cfg.model.model).toBe('qwen-turbo');
    expect(cfg.model.baseUrl).toBe('');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dashscope.aliyuncs.com/api/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-qwen-1' } }),
    );
    expect(result.defaultModel).toBe('qwen-turbo');
  });

  it('非法输入循环重问后继续（provider 与模型选择）', async () => {
    // '9' 超范围重问（'3' 现在是合法的 openai 序号，不再用作非法样例）
    injectStdio(['g', '9', '1', 'sk-ds-6', '9', '2']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys.deepseek).toBe('sk-ds-6');
    expect(cfg.model.model).toBe('deepseek-v4-pro');
    expect(logText(logSpy)).toContain('Invalid input');
    expect(result.defaultModel).toBe('deepseek-v4-pro');
  });

  it('全部 provider 取消（空 key）：不写配置，返回空 providers', async () => {
    injectStdio(['g', '2', '']);

    const result = await runWizard();

    expect(existsSync(join(globalDir, 'config.json'))).toBe(false);
    expect(() => readConfig(cwd)).toThrow();
    expect(result).toEqual({ providers: [], defaultModel: '' });
  });

  it('选择 OpenAI(3)：providerKeys.openai 写入、默认 gpt-5.4、连通性命中 api.openai.com 且带 Bearer', async () => {
    injectStdio(['g', '3', 'sk-openai-1', '1']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ openai: 'sk-openai-1' });
    expect(cfg.model.model).toBe('gpt-5.4');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-openai-1' } }),
    );
    expect(result).toEqual({
      providers: [{ provider: 'openai', model: 'gpt-5.4' }],
      defaultModel: 'gpt-5.4',
    });
  });

  it('自定义 provider(4)：baseUrl+key+模型名落盘为派生 provider + providerBaseUrls 归一化', async () => {
    injectStdio(['g', '4', 'https://llama.example.com/v1', 'sk-llama-1', 'llama-3.1-70b']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ llama: 'sk-llama-1' });
    // /v1 后缀被归一化剥离（客户端统一拼 /v1/chat/completions，避免双重 /v1）
    expect(cfg.providerBaseUrls).toEqual({ llama: 'https://llama.example.com' });
    expect(cfg.model.model).toBe('llama-3.1-70b');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://llama.example.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-llama-1' } }),
    );
    expect(result).toEqual({
      providers: [{ provider: 'llama', model: 'llama-3.1-70b' }],
      defaultModel: 'llama-3.1-70b',
    });
  });

  it('自定义 baseUrl 留空 + gpt-5.6-terra：派生 openai、不写 providerBaseUrls、连通性走官方端点', async () => {
    injectStdio(['g', '4', '', 'sk-openai-2', 'gpt-5.6-terra']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ openai: 'sk-openai-2' });
    expect(cfg.providerBaseUrls).toBeUndefined();
    expect(cfg.model.model).toBe('gpt-5.6-terra');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-openai-2' } }),
    );
    expect(result.providers).toEqual([{ provider: 'openai', model: 'gpt-5.6-terra' }]);
  });

  it('qwen 模型单选列表由目录派生：可选新增项（9 → qwen-vl-max）', async () => {
    injectStdio(['g', '2', 'sk-qwen-9', '9']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ qwen: 'sk-qwen-9' });
    expect(cfg.model.model).toBe('qwen-vl-max');
    expect(result.defaultModel).toBe('qwen-vl-max');
  });

  it('已存在配置 + 自定义录入：其他 provider 字段与原 baseUrl 保留', async () => {
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      model: { baseUrl: 'https://custom.example.com', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
      permissions: { mode: 'default', allow: ['read'], deny: [] },
      skills: [],
      mcpServers: [],
      providerKeys: { deepseek: 'sk-ds-existing' },
    }, null, 2), 'utf-8');
    injectStdio(['p', '4', 'https://gw.example.com/v1', 'sk-gw-1', 'gpt-5.4']);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await runWizard();

    const cfg = readConfig(cwd);
    expect(cfg.providerKeys).toEqual({ deepseek: 'sk-ds-existing', openai: 'sk-gw-1' });
    expect(cfg.providerBaseUrls).toEqual({ openai: 'https://gw.example.com' });
    expect(cfg.model.model).toBe('gpt-5.4');
    expect(cfg.model.baseUrl).toBe('https://custom.example.com');
    expect(result.defaultModel).toBe('gpt-5.4');
  });

  it('目录无模型的厂商（zhipu）：探测 /v1/models 得到清单后数字单选，清单写入 providerModels', async () => {
    injectStdio(['g', '7', 'sk-zhipu-1', '2']);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'glm-4-plus' }, { id: 'glm-4-air' }] }),
    } as unknown as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ zhipu: 'sk-zhipu-1' });
    // 探测清单第 2 项（接口序），并落盘为排序后的 providerModels
    expect(cfg.model.model).toBe('glm-4-air');
    expect(cfg.providerModels).toEqual({ zhipu: ['glm-4-air', 'glm-4-plus'] });
    expect(result).toEqual({
      providers: [{ provider: 'zhipu', model: 'glm-4-air' }],
      defaultModel: 'glm-4-air',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/paas/v4/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-zhipu-1' } }),
    );
    // 第 3 步已探测，第 6 步复用结果 → 全程只请求一次
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('目录无模型的厂商（kimi）：探测失败退回手输模型名，不崩溃且正常落盘', async () => {
    injectStdio(['g', '8', 'sk-kimi-1', 'moonshot-v1-32k']);
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ kimi: 'sk-kimi-1' });
    expect(cfg.model.model).toBe('moonshot-v1-32k');
    expect(cfg.providerModels).toEqual({ kimi: ['moonshot-v1-32k'] });
    const out = logText(logSpy);
    expect(out).toContain('HTTP 404');
    expect(out).toContain('Setup complete');
    expect(result.defaultModel).toBe('moonshot-v1-32k');
  });

  it('目录无模型的厂商（doubao）：探测返回非 JSON 时退回手输，不崩溃', async () => {
    injectStdio(['g', '6', 'sk-doubao-1', 'doubao-pro-32k']);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    } as unknown as Response);

    const result = await runWizard();

    const cfg = readGlobalConfig(globalDir);
    expect(cfg.providerKeys).toEqual({ doubao: 'sk-doubao-1' });
    expect(cfg.model.model).toBe('doubao-pro-32k');
    expect(cfg.providerModels).toEqual({ doubao: ['doubao-pro-32k'] });
    expect(result.defaultModel).toBe('doubao-pro-32k');
  });
});
