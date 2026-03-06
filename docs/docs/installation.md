---
sidebar_position: 2
title: 安装
---

# 安装

## 环境要求

- **Node.js >= 20**

## 全局安装（推荐）

```bash
npm install -g giclaw@latest
# 或
pnpm add -g giclaw@latest
```

安装后全局可用 `giclaw` 命令。首次运行时自动下载 Chromium，无需手动安装。

安装完成后，运行 `giclaw init` 进行交互式配置：

```bash
giclaw init
```

## 从源码安装（开发）

推荐使用 `pnpm`。

```bash
git clone https://github.com/caterpi11ar/giclaw.git
cd giclaw

pnpm install
pnpm build

# 单次运行
pnpm start

# Dev loop（auto-reload on TS changes）
pnpm dev
```

:::note
`pnpm dev` 通过 `tsx watch` 直接运行 TypeScript。`pnpm build` 产出 `dist/`，通过 `pnpm start` 或全局 `giclaw` 命令运行。
:::
