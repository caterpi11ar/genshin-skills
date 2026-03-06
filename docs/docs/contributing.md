---
sidebar_position: 8
title: 贡献指南
---

# 贡献指南

## 开发环境

推荐使用 `pnpm`。

```bash
git clone https://github.com/caterpi11ar/genshin-impact-claw.git
cd genshin-impact-claw

pnpm install
pnpm build
```

## 开发工作流

```bash
# Dev loop（文件变更自动重启）
pnpm dev

# 运行测试
pnpm test

# 构建
pnpm build

# 从构建产物运行
pnpm start
```

:::note
`pnpm dev` 通过 `tsx watch` 直接运行 TypeScript，适合开发时使用。`pnpm build` 产出 `dist/`，通过 `pnpm start` 或全局 `giclaw` 命令运行。
:::

## 添加新技能

最简单的贡献方式是添加新技能，无需编写 TypeScript：

1. 创建目录：`mkdir skills/my-skill`
2. 编写 `skills/my-skill/SKILL.md`（参考[编写技能](/docs/skills/writing-skills)）
3. 在 `config.json` 的 `tasks.enabled` 中添加 `"my-skill"`
4. 运行验证：`giclaw run --dry-run`

## 项目结构

```
genshin-impact-claw/
├── src/             # TypeScript 源码
├── skills/          # 技能定义（SKILL.md 文件）
├── dist/            # 构建产物
├── docs/            # 文档站点（Docusaurus）
├── config.json      # 运行时配置
└── package.json
```
