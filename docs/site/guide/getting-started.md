# 快速开始

## 从源码运行

公开 npm 版本仍在准备中。当前使用 Node.js 22+ 从 [GitHub 源码](https://github.com/liam61-hub/shenlan)运行：

```bash
git clone https://github.com/liam61-hub/shenlan.git
cd shenlan
npm ci
npm run build
node packages/cli/dist/index.js
```

## 使用前准备

- Node.js 22 或更高版本。
- 至少一个受支持模型的 API Key。
- 一个需要读取、分析或修改的本地工作目录。

## 首次运行流程

1. 从源码启动 CLI，进入首次配置向导。
2. 选择模型提供方并粘贴自己的 API Key。
3. 完成连通性测试后，在目标项目目录中输入任务。
4. 使用 `Shift+Tab` 切换权限模式；写文件和执行命令默认需要确认。

深蓝支持交互会话、单次 headless 任务、会话恢复和长任务目标模式。会话与密钥默认保存在本机；调用模型时，请求内容发送给用户配置的服务商。
