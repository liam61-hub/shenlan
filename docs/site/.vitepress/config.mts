import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: '深蓝',
  description: '运行在本地终端上的开源 Agent 工作台',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '功能', link: '/guide/features' },
      { text: '安全', link: '/guide/security' },
      { text: '模型', link: '/guide/models' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '使用指南',
          items: [
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '核心能力', link: '/guide/features' },
            { text: '安全与本地数据', link: '/guide/security' },
            { text: '模型接入', link: '/guide/models' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    footer: {
      message: '模型自带 · 会话本地存储 · 能力随使用复利增长',
      copyright: 'Copyright © 2026 shenlan',
    },
  },
});
