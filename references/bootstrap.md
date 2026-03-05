# 原神云游戏 — 领月卡引导工作流

> **目标**：登录原神云游戏，领取空月祝福（Blessing of the Welkin Moon）每日奖励。

## 前置条件

### 1. 安装依赖并编译

```bash
cd <SKILL_DIR>
pnpm install
npx playwright install chromium
pnpm build
```

- `pnpm install`：安装 Node.js 依赖
- `npx playwright install chromium`：下载 Chromium 浏览器（Playwright 需要）
- `pnpm build`：编译 TypeScript 到 `dist/`，后续所有脚本都从 `dist/` 运行

### 2. 启动浏览器后台进程

```bash
node <SKILL_DIR>/dist/scripts/start-browser.js &
```

等待几秒让浏览器初始化完成。进程会在后台监听 Unix socket（`/tmp/genshin-skills.sock`），所有技能通过该 socket 通信。

---

## 步骤

> 每一步执行后都必须检查返回 JSON 的 `success` 字段。若 `success: false`，立即截图并报告错误，不要继续后续步骤。

### 1. 登录

```bash
node <SKILL_DIR>/dist/scripts/run-skill.js browser_login
```

首次运行时会打开可见浏览器窗口，需要手动扫码/输入密码登录。登录成功后 cookie 会自动保存，后续运行自动恢复登录态（headless 模式）。

### 2. 启动游戏

```bash
node <SKILL_DIR>/dist/scripts/run-skill.js browser_start_game \
  --dismissSelectors '[".guide-close-btn"]'
```

此步会：
- 关闭引导弹窗（`.guide-close-btn`）
- 点击「开始游戏」按钮

### 3. 接受用户协议弹窗

等待用户协议弹窗出现并点击确认：

```bash
node <SKILL_DIR>/dist/scripts/run-skill.js browser_wait --ms 3000
node <SKILL_DIR>/dist/scripts/run-skill.js browser_click \
  --selector ".user-agreement-dialog .van-dialog__confirm"
```

### 4. 关闭设置引导

通过 JS 点击第三步引导按钮跳过设置引导：

```bash
node <SKILL_DIR>/dist/scripts/run-skill.js browser_wait --ms 2000
node <SKILL_DIR>/dist/scripts/run-skill.js browser_evaluate \
  --expression "document.querySelector('.guide-step-3 .guide-btn')?.click()"
```

### 5. 坐标点击进入游戏

云游戏加载完成后是 canvas，无法通过选择器交互，需要使用坐标点击。点击画面中央两次（第一次激活窗口，第二次进入游戏）：

```bash
node <SKILL_DIR>/dist/scripts/run-skill.js browser_click --x 640 --y 360
node <SKILL_DIR>/dist/scripts/run-skill.js browser_wait --ms 5000
node <SKILL_DIR>/dist/scripts/run-skill.js browser_click --x 640 --y 360
```

### 6. 截图确认

截图确认已进入游戏画面：

```bash
node <SKILL_DIR>/dist/scripts/run-skill.js browser_wait --ms 10000
node <SKILL_DIR>/dist/scripts/run-skill.js browser_screenshot --output-file game.png
```

检查截图是否显示游戏主界面。如果仍在加载画面，再等待并重试截图。

### 7. 领取月卡

<!-- TODO: 云游戏内交互需要坐标点击，具体坐标待通过截图确认后补充 -->

> **待实现**：月卡领取需要在游戏画面内进行坐标点击操作。具体流程：
> 1. 等待月卡弹窗出现（登录后自动弹出）
> 2. 点击领取按钮（坐标待确认）
> 3. 截图确认领取成功
>
> 请先执行到第 6 步，通过截图确认游戏画面后，再补充此步骤的坐标。

### 8. 关闭浏览器

```bash
node <SKILL_DIR>/dist/scripts/stop-browser.js
```

---

## 错误处理

- **每步检查 `success`**：解析返回 JSON，若 `success: false` 则读取 `content` 中的错误信息
- **失败时截图**：执行 `browser_screenshot --output-file error.png` 保存当前画面
- **登录超时**：`browser_login` 默认 5 分钟超时，若超时需重新执行
- **弹窗未出现**：选择器 click 失败不一定是错误，可能是该弹窗本次没出现，截图确认后可跳过

## 注意事项

- 弹窗选择器（`.guide-close-btn`、`.user-agreement-dialog` 等）可能随云游戏版本更新而变化，若步骤 3/4 失败，先截图确认实际 DOM 结构
- 坐标点击依赖 viewport 尺寸，默认 1280×720。如果修改了 viewport，坐标需要相应调整
- 云游戏有排队机制，高峰期启动可能需要额外等待
