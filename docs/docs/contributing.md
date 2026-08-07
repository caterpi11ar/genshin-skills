---
sidebar_position: 8
title: 贡献指南
---

# 贡献指南

## 开发环境

推荐使用 `pnpm`。

```bash
git clone https://github.com/caterpi11ar/giclaw.git
cd giclaw

pnpm install
pnpm build

# 初始化配置（如果尚未配置）
npx tsx src/cli.ts init
```

## 开发工作流

```bash
# Dev loop（文件变更自动重启）
pnpm dev

# 运行测试
pnpm test

# 校验任务定义、依赖和命名流程
pnpm start -- skills

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
4. 运行结构校验：`giclaw skills`
5. 运行编排校验：`giclaw run --dry-run --tasks my-skill`
6. 使用可见窗口完成真实流程验证：`giclaw run --no-headless --tasks my-skill`

## 更新日志要求

[更新日志](/docs/changelog)是项目发布变化的统一记录。提交包含以下任一变化时，应在“待发布”部分增加条目：

- 新功能、新任务、新命令或新配置项
- 默认行为、兼容性、模型接入方式或依赖版本变化
- 用户可以观察到的问题修复
- 能力的启用、暂停、弃用或移除
- 安全、凭据或隐私相关调整

纯格式修改、本地运行数据和不改变外部行为的内部重构无需记录。条目应描述用户结果，不要只列提交号或文件名。发布版本时，将“待发布”条目移动到新的版本标题下并补充发布日期。

GitHub PR 模板会在每次提交合并请求时提醒检查更新日志、关联文档、验证结果和敏感文件。

## 项目结构

```
giclaw/
├── src/             # TypeScript 源码
├── skills/          # 技能定义（SKILL.md 文件）
├── dist/            # 构建产物
├── docs/            # 文档站点（Docusaurus）
├── config.json      # 运行时配置
└── package.json
```
