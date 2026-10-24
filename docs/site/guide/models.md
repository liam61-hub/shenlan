<!--
  本页刻意不含具体模型 ID 与价格：只讲接入机制与路由原则，目录/价格以 CLI 内 /model、/prices 为准。
  守卫测试：packages/cli/src/__tests__/site-models.test.ts（往本页加模型清单或金额会让它变红）。
-->

# 模型接入

深蓝使用 OpenAI 兼容协议，可接入 DeepSeek、Qwen、OpenAI 以及提供兼容端点的第三方模型服务。

## 接入方式

- 首次运行向导或 `/keys` 面板。
- `shenlan config` 命令。
- 全局或项目配置文件。
- 环境变量和 `.env` 文件。

配置优先级为：真实环境变量、项目 `.env`、全局 `.env`、项目配置、全局配置。密钥按 provider 分开保存；自定义模型同时配置 Base URL、API Key 和模型名。

## 路由原则

- `cost-first` 优先控制成本，并按任务复杂度选择合适模型。
- `quality-first` 优先模型能力。
- 手动锁定模型后保持粘性；遇到图片输入时可升级到视觉模型。
- 目录外的 OpenAI 兼容模型在拥有有效 Key 和端点时可以直接使用。

具体模型目录和价格会随实现更新，发布版本以 CLI 内的 `/model` 与 `/prices` 输出为准。
