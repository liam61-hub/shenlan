/**
 * 配置键目录（CONFIG_KEYS）— schema 一致性 + 值解析 + 嵌套读写测试
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  ENV_VARS,
  descText,
  lookupConfigKey,
  parseConfigValue,
  getNested,
  setNested,
  deleteNested,
} from '../config-schema.js';
import { DEFAULT_CONFIG } from '../config.js';

describe('CONFIG_KEYS schema 一致性', () => {
  it('每个条目都有 type 与非空双语 description', () => {
    for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
      expect(meta.type, `${key} 缺 type`).toMatch(/^(string|number|boolean)$/);
      expect(meta.description?.en, `${key} 缺英文 description`).toBeTruthy();
      expect(meta.description?.zh, `${key} 缺中文 description`).toBeTruthy();
    }
  });

  it('带 default 的条目与 DEFAULT_CONFIG 嵌套值一致（防漂移）', () => {
    for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
      if (meta.default !== undefined) {
        expect(getNested(DEFAULT_CONFIG, key), `${key} 默认值漂移`).toEqual(meta.default);
      }
    }
  });

  it('allowedValues 均为 string 且含 description', () => {
    for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
      if (meta.allowedValues) {
        expect(meta.allowedValues.length, `${key} allowedValues 为空`).toBeGreaterThan(0);
        for (const v of meta.allowedValues) {
          expect(typeof v, `${key}.allowedValues 含非字符串`).toBe('string');
        }
      }
    }
  });

  it('tavily.enabled 已收录（默认关闭）', () => {
    expect(CONFIG_KEYS['tavily.enabled']).toMatchObject({ type: 'boolean', default: false });
  });

  it('agent.maxBackground 已收录（默认 3，后台 Explore agent 并发上限）', () => {
    expect(CONFIG_KEYS['agent.maxBackground']).toMatchObject({ type: 'number', default: 3 });
  });

  it('actionSafety 与 planMode 键已收录', () => {
    expect(CONFIG_KEYS['actionSafety.highRiskActions']).toMatchObject({
      type: 'string', allowedValues: ['deny', 'confirm'], default: 'deny',
    });
    expect(CONFIG_KEYS['actionSafety.confirmPhrase']).toMatchObject({ type: 'string', default: 'yes' });
    expect(CONFIG_KEYS['actionSafety.protectedPaths']).toMatchObject({ type: 'string' });
    expect(CONFIG_KEYS['actionSafety.auditEnabled']).toMatchObject({ type: 'boolean', default: true });
    expect(CONFIG_KEYS['planMode.readonlyCommands']).toMatchObject({ type: 'string' });
  });

  it('pitfallMemory 键已收录', () => {
    expect(CONFIG_KEYS['pitfallMemory.injectTopN']).toMatchObject({ type: 'number', default: 5 });
    expect(CONFIG_KEYS['pitfallMemory.searchBeforeAction']).toMatchObject({ type: 'boolean', default: true });
    expect(CONFIG_KEYS['pitfallMemory.autoRecordOnError']).toMatchObject({ type: 'boolean', default: true });
  });

  it('providerFailover.enabled 已收录（默认关闭）', () => {
    expect(CONFIG_KEYS['providerFailover.enabled']).toMatchObject({ type: 'boolean', default: false });
  });

  it('updateCheck.enabled 已收录（默认开启）', () => {
    expect(CONFIG_KEYS['updateCheck.enabled']).toMatchObject({ type: 'boolean', default: true });
  });

  it('端点与确认短语标记敏感（展示掩码）', () => {
    expect(CONFIG_KEYS['model.baseUrl']).toMatchObject({ type: 'string', secret: true });
    expect(CONFIG_KEYS['actionSafety.confirmPhrase']).toMatchObject({ type: 'string', secret: true });
  });

  it('描述文字不含特定 provider 名（模型中立，双语都查）', () => {
    for (const meta of Object.values(CONFIG_KEYS)) {
      for (const d of [meta.description.en, meta.description.zh]) {
        expect(d, d).not.toContain('DeepSeek');
        expect(d, d).not.toContain('deepseek');
      }
    }
  });

  it('language 键已收录（默认 en，允许 en/zh-CN）', () => {
    expect(CONFIG_KEYS['language']).toMatchObject({
      type: 'string',
      allowedValues: ['en', 'zh-CN'],
      default: 'en',
    });
  });
});

describe('lookupConfigKey — 精确键 + 动态前缀', () => {
  it('精确键命中', () => {
    expect(lookupConfigKey('costGuardrails.enabled')?.type).toBe('boolean');
  });

  it('providerKeys 动态前缀命中且标记敏感', () => {
    expect(lookupConfigKey('providerKeys.deepseek')).toMatchObject({ type: 'string', secret: true });
  });

  it('providerBaseUrls 动态前缀命中且标记敏感', () => {
    expect(lookupConfigKey('providerBaseUrls.qwen')).toMatchObject({ type: 'string', secret: true });
  });

  it('未知键返回 null', () => {
    expect(lookupConfigKey('nope.unknown')).toBeNull();
  });
});

describe('parseConfigValue — 类型/取值校验', () => {
  it('boolean 接受 true/false', () => {
    expect(parseConfigValue('costGuardrails.enabled', 'true')).toEqual({ ok: true, value: true });
    expect(parseConfigValue('costGuardrails.enabled', 'false')).toEqual({ ok: true, value: false });
  });

  it('boolean 拒绝非布尔输入', () => {
    const r = parseConfigValue('costGuardrails.enabled', 'yes');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('boolean');
  });

  it('number 解析数字串，拒绝非数字', () => {
    expect(parseConfigValue('agent.maxSteps', '120')).toEqual({ ok: true, value: 120 });
    const r = parseConfigValue('agent.maxSteps', 'abc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('number');
  });

  it('string 带 allowedValues 时拒绝取值外输入', () => {
    expect(parseConfigValue('routing.policy', 'manual')).toEqual({ ok: true, value: 'manual' });
    const r = parseConfigValue('routing.policy', 'random');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cost-first');
  });

  it('未知键报错', () => {
    const r = parseConfigValue('unknown.key', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('未知');
  });
});

describe('getNested / setNested / deleteNested — 点路径嵌套读写', () => {
  const obj = {
    costGuardrails: { enabled: true, maxCostPerSession: 5 },
    agent: { maxSteps: 80 },
  };

  it('getNested 取深层值', () => {
    expect(getNested(obj, 'costGuardrails.maxCostPerSession')).toBe(5);
    expect(getNested(obj, 'agent.maxSteps')).toBe(80);
  });

  it('getNested 缺失路径返回 undefined', () => {
    expect(getNested(obj, 'agent.noSuch')).toBeUndefined();
    expect(getNested(obj, 'noSuch.x')).toBeUndefined();
  });

  it('setNested 深路径写入且不污染兄弟字段', () => {
    const out = setNested({}, 'agent.maxSteps', 120) as { agent: { maxSteps: number } };
    expect(out.agent.maxSteps).toBe(120);
    const out2 = setNested({ agent: { maxSteps: 80 } }, 'agent.goalMaxSteps', 300) as {
      agent: { maxSteps: number; goalMaxSteps: number };
    };
    expect(out2.agent).toEqual({ maxSteps: 80, goalMaxSteps: 300 });
  });

  it('setNested 标量值写入', () => {
    const out = setNested({}, 'memory.autoSave', false) as { memory: { autoSave: boolean } };
    expect(out.memory.autoSave).toBe(false);
  });

  it('deleteNested 删除键并报告是否发生变化', () => {
    const o = { costGuardrails: { enabled: true, maxCostPerSession: 5 } };
    const r1 = deleteNested(o, 'costGuardrails.enabled');
    expect(r1).toBe(true);
    expect(o.costGuardrails.enabled).toBeUndefined();
    expect(o.costGuardrails.maxCostPerSession).toBe(5);
    expect(deleteNested(o, 'costGuardrails.enabled')).toBe(false);
  });
});

describe('ENV_VARS — 产品环境变量目录', () => {
  it('SHENLAN_* 变量全部收录且 key 类标记敏感', () => {
    const byName = new Map(ENV_VARS.map((v) => [v.name, v]));
    expect(byName.get('SHENLAN_MODEL')?.description).toBeTruthy();
    expect(byName.get('SHENLAN_BASE_URL')).toMatchObject({ secret: true });
    expect(byName.get('SHENLAN_API_KEY')).toMatchObject({ secret: true });
    expect(byName.get('SHENLAN_CONFIG_DIR')?.secret).toBeUndefined();
    expect(byName.get('SHENLAN_COST_LEDGER')?.secret).toBeUndefined();
    expect(byName.get('SHENLAN_DEBUG')?.secret).toBeUndefined();
    expect(byName.get('SHENLAN_NO_UPDATE_CHECK')?.secret).toBeUndefined();
    expect(byName.get('NO_UPDATE_NOTIFIER')?.secret).toBeUndefined();
    expect(byName.get('<PROVIDER>_API_KEY')).toMatchObject({ secret: true });
  });

  it('每条目都有 name 与非空双语 description', () => {
    for (const v of ENV_VARS) {
      expect(v.name).toBeTruthy();
      expect(v.description?.en).toBeTruthy();
      expect(v.description?.zh).toBeTruthy();
    }
  });

  it('descText 按语言取值', () => {
    expect(descText({ en: 'UI language', zh: '界面语言' }, 'en')).toBe('UI language');
    expect(descText({ en: 'UI language', zh: '界面语言' }, 'zh-CN')).toBe('界面语言');
  });
});
