# 快速开始

## 从源码运行

公开 npm 版本仍在准备中。当前使用 Node.js 22+ 从 [GitHub 源码](https://github.com/liam61-hub/shenlan)运行：

```bash
git clone https://github.com/liam61-hub/shenlan.git
cd shenlan
npm ci
npm run build
node packages/cli/dist/index.js --version
node packages/cli/dist/index.js
```

### Updating a source checkout

From the repository root, pull the latest supported branch and rebuild before starting the CLI:

```bash
git pull --ff-only origin master
npm ci
npm run build
node packages/cli/dist/index.js
```

`npm ci` uses the checked-in lockfile, so it gives a clean, reproducible dependency install after checkout or an update.

## 更新源码检出

在仓库根目录拉取受支持分支并重新构建，然后启动 CLI：

```bash
git pull --ff-only origin master
npm ci
npm run build
node packages/cli/dist/index.js
```

`npm ci` 按仓库锁文件安装依赖，确保干净检出和更新后的依赖一致。

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
