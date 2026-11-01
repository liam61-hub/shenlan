/**
 * 配置样例模板（纯数据）— 首次运行自动生成的 config.sample.json /
 * README.md / env.example 内容。占位值用中文提示，避免触发密钥扫描误报。
 */

const SAMPLE_BASE: Record<string, unknown> = {
  model: {
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-v4-flash',
    maxTokens: 8192,
  },
  providerKeys: {
    deepseek: '在这里填入 DeepSeek API Key',
    qwen: '在这里填入 qwen API Key',
  },
  providerBaseUrls: {
    deepseek: '',
    qwen: '',
  },
  routing: {
    policy: 'cost-first',
    lockedModel: null,
  },
  permissions: {
    mode: 'default',
    allow: ['read', 'search'],
    deny: [],
  },
  skills: [],
  mcpServers: [],
  agent: {
    maxSteps: 80,
  },
  context: {
    autoCompactTokenLimit: 200_000,
    keepRecentTurns: 20,
    toolOutputLimitChars: 8000,
    compactModel: '',
    maxMemoryTokens: 4096,
  },
  balanceCheck: {
    enabled: true,
    lowBalanceWarnThreshold: 1,
  },
  memory: {
    autoSave: true,
  },
  updateCheck: {
    enabled: true,
  },
  tavily: {
    enabled: false,
  },
  actionSafety: {
    highRiskActions: 'deny',
    confirmPhrase: 'yes',
    protectedPaths: [],
    auditEnabled: true,
  },
  planMode: {
    readonlyCommands: ['git status', 'git diff', 'git log', 'ls', 'pwd'],
  },
  onboarding: {
    done: false,
    tipsSeen: false,
  },
};

export const CONFIG_SAMPLE_GLOBAL: Record<string, unknown> = {
  _说明: '这是 shenlan 全局配置样例（~/.shenlan/config.sample.json）。复制为同目录 config.json 后按需修改；未知字段会被忽略，不会报错。',
  ...SAMPLE_BASE,
};

export const CONFIG_SAMPLE_PROJECT: Record<string, unknown> = {
  _说明: '这是 shenlan 项目配置样例（.shenlan/config.sample.json）。复制为同目录 config.json 后按需修改；项目配置优先级高于全局配置，model.model 留空表示沿用全局/默认模型。',
  ...SAMPLE_BASE,
};

export const CONFIG_README_MD = `# shenlan 配置目录

本目录由 shenlan 首次运行时自动生成（也可以手动创建）。

## 文件说明

- \`config.json\` — 实际生效配置（生成后 shenlan 不会自动改写）
- \`config.sample.json\` — 完整字段样例（复制为 \`config.json\` 后按需修改）
- \`env.example\` — .env 格式样例（复制为 \`.env\` 或 \`~/.shenlan/.env\` 后填写）
- \`README.md\` — 本文件

## 配置优先级（高到低）

1. 真实环境变量（shell export）
2. 项目 .env（<项目目录>/.env）
3. 全局 .env（~/.shenlan/.env）
4. 项目配置（<项目>/.shenlan/config.json）
5. 全局配置（~/.shenlan/config.json）

## 配置 API Key（4 种方式）

1. 界面：首次运行欢迎引导，或 \`/keys\` 面板、\`shenlan --setup\` 向导
2. 手动编辑 \`config.json\` 的 \`providerKeys\`：

   \`\`\`json
   { "providerKeys": { "deepseek": "sk-xxx", "qwen": "sk-xxx" } }
   \`\`\`

3. 环境变量：

   \`\`\`bash
   export DEEPSEEK_API_KEY=sk-xxx
   \`\`\`

4. .env 文件：项目 \`.env\` 或全局 \`~/.shenlan/.env\` 写 \`KEY=VALUE\`：

   \`\`\`bash
   DEEPSEEK_API_KEY=sk-xxx
   QWEN_API_KEY=sk-xxx
   \`\`\`

## 安全

- 密钥文件权限 0600、全局目录 0700（仅本用户可读）
- \`.env*\` 与 \`.shenlan/config.json\` 已被提交时安全检查硬禁止，不要提交到 git
`;

export const ENV_EXAMPLE = `# 复制为 .env（项目目录）或 ~/.shenlan/.env（全局）后填写
# 优先级：真实环境变量 > 项目 .env > 全局 .env > 配置文件
DEEPSEEK_API_KEY=在这里填入 DeepSeek API Key
QWEN_API_KEY=在这里填入 qwen API Key
# SHENLAN_API_KEY=通用 fallback key
# SHENLAN_MODEL=deepseek-v4-flash
# SHENLAN_BASE_URL=https://api.deepseek.com
# SHENLAN_NO_UPDATE_CHECK=1
# TAVILY_API_KEY=联网搜索 fallback（无原生搜索的模型）
`;
