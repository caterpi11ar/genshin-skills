---
sidebar_position: 3
title: 模型配置
---

# 模型配置

giclaw 使用 **OpenAI 兼容的视觉模型 API** 分析游戏截图并决定操作。运行 `giclaw init` 可以交互式选择供应商，也可以手动在 `config.json` 中配置。模型配置保存在项目或用户配置文件中，不要求增加环境变量。

## 当前已验收配置

当前真实账号全流程使用本机 NewAPI 网关、`gpt-5.6-sol` 和流式 Chat Completions：

```json
{
  "model": {
    "name": "gpt-5.6-sol",
    "baseUrl": "http://127.0.0.1:3002/v1",
    "apiKey": "你的 NewAPI 用户令牌",
    "family": "gpt-5",
    "stream": true
  }
}
```

`/v1/models` 必须携带用户令牌。先确认接口返回的精确模型 ID，再写入 `model.name`；当前网关只使用其实际列出的 5.6 系列模型，不使用旧模型名占位。

```bash
curl http://127.0.0.1:3002/v1/models \
  -H "Authorization: Bearer <NewAPI 用户令牌>"
```

## 其他兼容供应商示例

### Google Gemini

性价比最优。Gemini 2.5 Flash 具有出色的视觉理解能力，响应速度快，免费额度充足。

```json
{
  "model": {
    "name": "gemini-2.5-flash",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "apiKey": "你的 API Key"
  }
}
```

获取 API Key：[Google AI Studio](https://aistudio.google.com/apikey)

### 豆包 / 火山引擎

国内访问稳定，无需代理。

```json
{
  "model": {
    "name": "doubao-seed-1.6-thinking-vision-250428",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKey": "你的 API Key"
  }
}
```

获取 API Key：[火山引擎控制台](https://console.volcengine.com/ark)

### 通义千问 Qwen-VL

阿里云提供，国内访问稳定。

```json
{
  "model": {
    "name": "qwen-vl-max",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "sk-xxx"
  }
}
```

获取 API Key：[阿里云百炼](https://bailian.console.aliyun.com/)

## 自定义供应商

任何兼容 OpenAI `/v1/chat/completions` 接口且支持 `image_url` 类型输入的视觉模型均可使用。只需在 `config.json` 中填入对应的 `baseUrl`、`name` 和 `apiKey`。

```json
{
  "model": {
    "name": "your-model-name",
    "baseUrl": "https://your-api-endpoint.com/v1",
    "apiKey": "your-api-key"
  }
}
```

:::tip
giclaw 通过 `POST {baseUrl}/chat/completions` 发送请求，消息体包含 `image_url`（base64 编码的截图）和文本提示。确保你的供应商支持此格式即可。
:::

### 仅支持流式返回的兼容服务

如果兼容服务拒绝 `stream: false`，可以只在当前配置中启用流式聚合：

```json
{
  "model": {
    "name": "gpt-5.6-sol",
    "baseUrl": "http://127.0.0.1:3002/v1",
    "apiKey": "你的 NewAPI 用户令牌",
    "family": "gpt-5",
    "stream": true
  }
}
```

开启后，giclaw 仍调用 `/chat/completions`，但会向上游发送 `stream: true`，再在进程内把 SSE 分片聚合为 Midscene 结构化规划所需的完整 Chat Completion。该选项不启用 Responses API，也不会修改代理服务或系统环境变量。

## 配置检查

- `baseUrl` 应包含兼容服务要求的 `/v1` 前缀，项目会在其后请求 `/chat/completions`。
- `model.name` 必须与带鉴权访问 `/v1/models` 时返回的 ID 完全一致。
- 5.x 兼容模型将 `family` 设为 `gpt-5`，使 Midscene 使用正确的模型家族适配。
- 上游拒绝非流式请求时设置 `stream: true`；这不会切换到 Responses API。
- `model_unavailable` 通常表示网关没有该模型的可用映射或上游通道。先核对模型列表和通道状态，再检查项目配置。
- `giclaw run --dry-run` 不请求模型 API，只能验证本地配置结构和任务编排。
