# giclaw 文档站

文档站基于 [Docusaurus](https://docusaurus.io/) 构建，产品文档位于 `docs/`，首页位于 `src/pages/index.tsx`。

## 安装依赖

```bash
pnpm install
```

## 本地开发

```bash
pnpm start
```

默认启动本地开发服务器并监听文档变更。

## 构建与检查

```bash
pnpm build
pnpm typecheck
```

构建产物输出到 `build/`。合并文档修改前至少运行一次 `pnpm build`，以检查断链、MDX 和页面编译错误。

## 部署

```bash
pnpm deploy
```

站点配置位于 `docusaurus.config.ts`，生产地址为 `https://giclaw.cn`。
