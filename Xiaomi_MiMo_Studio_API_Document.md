# Xiaomi MiMo Studio API 逆向文档

> 基站地址: `https://aistudio.xiaomimimo.com`
> 逆向日期: 2026-03-27
> 前端技术栈: React + MobX + Webpack + Zod (schema验证) + CryptoJS

---

## 一、认证机制

### 1.1 Cookie 认证

所有API请求通过 Cookie 进行身份认证，关键Cookie字段：

| Cookie 名称 | 说明 | 示例 |
|---|---|---|
| `serviceToken` | 小米账号登录token（HttpOnly，JS不可读） | Base64编码的加密token |
| `userId` | 用户ID | `2267194026` |
| `xiaomichatbot_ph` | 防护哈希值，POST请求附加为query参数 | `qm/L3QFrh9tGbeAJkq83kw==` |

### 1.2 请求头 (公共Headers)

```
Content-Type: application/json
Accept-Language: zh-CN (或 en-US，取自locale配置)
x-timeZone: Asia/Shanghai (取自 Intl.DateTimeFormat().resolvedOptions().timeZone)
```

### 1.3 xiaomichatbot_ph 参数注入逻辑

**仅POST请求**会自动附加 `xiaomichatbot_ph` 作为URL query参数。

前端算法（从HTTP客户端 `post()` 方法中提取）：

```javascript
// 环境变量映射 cookie 名称
const COOKIE_NAME_MAP = {
  development: "michatbot_ph",
  "development-preview": "pre-michatbot_ph",
  review: "michatbot_ph",
  staging: "pre-michatbot_ph",
  preview: "michatbot_ph",
  production: "xiaomichatbot_ph"  // 生产环境使用此名称
};

// POST 方法中自动注入
post(url, payload, options) {
  const buildQueryParams = () => {
    // 内部环境跳过
    if (isInternalEnv) return options?.queryParams;
    
    // 从 cookie 中读取 xiaomichatbot_ph 的值
    const phValue = getCookie("xiaomichatbot_ph");
    if (!phValue) return options?.queryParams;
    
    // 如果没有现有queryParams，直接创建
    if (!options?.queryParams) {
      return { xiaomichatbot_ph: phValue };
    }
    
    // 如果queryParams是字符串，拼接到URL
    if (typeof options.queryParams === "string") {
      const encoded = encodeURIComponent(phValue);
      return options.queryParams 
        ? `${options.queryParams}&xiaomichatbot_ph=${encoded}` 
        : `xiaomichatbot_ph=${encoded}`;
    }
    
    // 如果是对象，合并
    return { ...options.queryParams, xiaomichatbot_ph: phValue };
  };
  
  return this.fetch({
    url, method: "POST", payload, ...options,
    queryParams: buildQueryParams()
  });
}
```

### 1.4 Cookie 读取工具函数

```javascript
// getCookie 实现
function getCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookies = document.cookie.split("; ");
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) {
      return decodeURIComponent(cookie.slice(prefix.length))
        .replaceAll(/^"|"$/g, "")
        .trim();
    }
  }
  return undefined;
}
```

---

## 二、HTTP 客户端架构

### 2.1 基础客户端类 (BaseHttpClient)

前端使用自封装的 HTTP 客户端，基于原生 `fetch()` API：

```javascript
class BaseHttpClient {
  constructor({
    host = "",        // API主机地址
    prefix = "",      // URL前缀
    headers = {},     // 静态headers
    getHeaders,       // 动态headers函数
    handleResult,     // 响应处理函数
    handleError,      // 错误处理函数
    verifyCode = true,  // 是否校验响应code
    credentials = "same-origin", // 凭证模式
    timeout           // 请求超时
  }) {}

  // 创建子客户端（继承配置 + 覆盖prefix等）
  child({ host, prefix, headers, ... }) -> BaseHttpClient

  // HTTP 方法
  get(url, queryParams?, options?) -> Promise<[data, error]>
  post(url, payload?, options?) -> Promise<[data, error]>
  put(url, payload?, options?) -> Promise<[data, error]>
  del(url, payload?, options?) -> Promise<[data, error]>
  patch(url, payload?, options?) -> Promise<[data, error]>
  completions(url, payload, signal) -> Promise<[Response, error]>  // SSE流式
}
```

### 2.2 应用客户端 (AppHttpClient)

继承 BaseHttpClient，固定配置：
- **host**: `//aistudio.xiaomimimo.com`
- **getHeaders**: 自动添加 `Accept-Language` 和 `x-timeZone`
- **handleError**: 处理 302/401(登录过期)、503/429(服务繁忙)、451/461(用户封禁)

### 2.3 响应格式

所有API返回统一JSON格式：

```json
{
  "code": 0,        // 0 或 200 表示成功
  "msg": "成功",
  "data": { ... }   // 业务数据
}
```

客户端自动解析，返回 `[data, null]`(成功) 或 `[null, error]`(失败)。

### 2.4 MD5 哈希函数

前端使用 CryptoJS.MD5 用于文件内容MD5计算（文件上传场景）：

```javascript
function md5Hash(content) {
  return CryptoJS.MD5(content).toString();
}
```

---

## 三、API 接口详情

### 3.1 用户模块 (`/open-apis/user`)

#### 3.1.1 获取用户信息
```
GET /open-apis/user/mi/get
```

**请求参数**: 无

**响应数据 (UserInfo)**:
```json
{
  "userId": "2267194026",
  "userName": "倚楼映秋影",
  "userCode": "45041df1-163f-4",
  "idc": "China",
  "avatar": "https://cdn.cnbj1.fds.api.mi-img.com/user-avatar/xxx.jpg",
  "watermark": "W7EEA25Qf6ORMtuJCteVrQ==",
  "isChildAccount": false,
  "isAgreed": true,
  "isClawDisclaimerAgreed": true,
  "bannedStatus": "NOT_BANNED"  // "NOT_BANNED" | "TEMPORARY" | "PERMANENT"
}
```

#### 3.1.2 用户登出
```
GET /open-apis/user/mi/logout
```

#### 3.1.3 用户反馈
```
POST /open-apis/user/feedback?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "...(反馈内容)",
  "multiMedias": []  // 可选的多媒体附件
}
```

#### 3.1.4 获取WebSocket Ticket
```
GET /open-apis/user/ws/ticket?xiaomichatbot_ph=xxx
```

**响应数据**:
```json
{
  "ticket": "ws-ticket-string"
}
```

#### 3.1.5 MiMo Claw 状态查询
```
GET /open-apis/user/mimo-claw/status
```

**响应数据 (ClawResource)**:
```json
{
  "status": "NOT_CREATED",  // "CREATING"|"AVAILABLE"|"CREATE_FAILED"|"DESTROYING"|"DESTROYED"|"DESTROY_FAILED"|"RESTARTING"|"RESTART_FAILED"|"REPAIRING"|"REPAIR_FAILED"
  "message": "未创建",
  "requestId": "...",
  "expireTime": null
}
```

#### 3.1.6 创建 Claw 资源
```
POST /open-apis/user/mimo-claw/create?xiaomichatbot_ph=xxx
```

**响应数据**: ClawResource (同上)

#### 3.1.7 销毁 Claw 资源
```
POST /open-apis/user/mimo-claw/destroy?xiaomichatbot_ph=xxx
```

#### 3.1.8 重启 Claw 资源
```
POST /open-apis/user/mimo-claw/restart?xiaomichatbot_ph=xxx
```

#### 3.1.9 修复 Claw 资源
```
POST /open-apis/user/mimo-claw/repair?xiaomichatbot_ph=xxx
```

---

### 3.2 Bot 配置模块 (`/open-apis/bot`)

#### 3.2.1 获取Bot配置
```
GET /open-apis/bot/config
```

**响应数据 (BotConfig)**:
```json
{
  "modelConfigListNg": [
    {
      "name": "MiMo-V2-Flash",
      "model": "mimo-v2-flash-studio",
      "intro": { "en": "High-Speed Reasoning Lightweight Large Model", "zh": "极速推理轻量级大模型" },
      "isDefault": true,
      "isNew": false,
      "isOmni": false,
      "generation": {
        "temperature": 0.8,
        "topP": 0.95,
        "maxTokens": 100000
      },
      "features": {
        "webSearch": 0,   // 0=DISABLED, 1=ENABLED, 2=ENABLED_BY_DEFAULT
        "thinking": 0,
        "scene": { "enabled": false }
      },
      "fileUpload": { "..." }
    },
    {
      "name": "MiMo-V2-Pro",
      "model": "mimo-v2-pro",
      "intro": { "en": "Open-Source Performance Flagship Model", "zh": "开源性能旗舰模型" },
      "isDefault": false,
      "isNew": true,
      "isOmni": false
    },
    {
      "name": "MiMo-V2-Omni",
      "model": "mimo-v2-omni",
      "intro": { "en": "High-Speed Flash Version Of Multimodal Model", "zh": "极速Flash版的多模态模型" },
      "isDefault": false,
      "isNew": true,
      "isOmni": true,
      "features": {
        "scene": {
          "enabled": true,
          "types": ["TRANSLATION", "QA", "VISION_QA"]
        }
      }
    }
  ],
  "recommendQuestionsNg": { "en-US": [...], "zh-CN": [...] },
  "claw": {
    "enabled": true,
    "recommendQuestions": { "en-US": [...], "zh-CN": [...] },
    "fileUpload": { "..." },
    "chatQrCodes": ["..."]
  },
  "voiceConfig": { "voice": [...] },
  "ext": {
    "enableVoice": true,
    "enableCustomVoice": true,
    "isForeignVersion": false
  }
}
```

#### 3.2.2 聊天补全 (流式SSE)
```
POST /open-apis/bot/chat?xiaomichatbot_ph=xxx
```

**请求体 (ChatCompletionRequest)**:
```json
{
  "model": "mimo-v2-flash-studio",
  "temperature": 0.8,
  "topP": 0.95,
  "systemPrompt": "",
  "webSearchMode": "disabled",  // "disabled" | "auto" | "enabled"
  "enableThinking": true,
  "conversationId": "15bfc9a618f7a3d116a71dab14ce7e48",
  "content": "你好",
  "multiMedias": [
    {
      "mediaType": "image",     // "image" | "file" | "video" | "audio"
      "fileUrl": "https://...",
      "compressedVideoUrl": "",
      "audioTrackUrl": "",
      "name": "photo.jpg",
      "size": 102400,
      "uploadProgress": 100,
      "status": "completed"     // "uploading"|"parsing"|"completed"|"error"|"parseError"|"empty"
    }
  ]
}
```

**响应**: Server-Sent Events (SSE) 流式响应

SSE事件数据格式（前端解析逻辑）:
```json
{
  "state": "generating",  // "generating" | "final"
  "message": "...",        // 生成内容（含thinking标签）
  "webSearchResults": [],
  "webSearchDone": false
}
```

前端Think标签解析：
```
<think>\0 ... </think>\0
```
（使用 `\0` 空字符作为think标签的分隔符）

---

### 3.3 会话模块 (`/open-apis/chat/conversation`)

#### 3.3.1 获取会话列表
```
POST /open-apis/chat/conversation/list?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "queryParam": {
    "search": "搜索关键词"  // 可选
  },
  "pageInfo": {
    "pageNum": 1,
    "pageSize": 20
  }
}
```

**响应数据**:
```json
{
  "total": 2,
  "pageNum": 1,
  "dataList": [
    {
      "id": 2364492,
      "conversationId": "15bfc9a618f7a3d116a71dab14ce7e48",
      "title": "MiMo个人介绍网页设计",
      "type": "chat",  // "chat" | "voice"
      "createTime": "2026-03-27 19:04:03",
      "updateTime": "2026-03-27 19:05:25"
    }
  ]
}
```

#### 3.3.2 保存/创建会话
```
POST /open-apis/chat/conversation/save?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "conversationId": "xxx",
  "title": "新会话"
}
```

**响应数据**: Conversation对象 (同上)

#### 3.3.3 删除会话
```
POST /open-apis/chat/conversation/delete?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "conversationId": "xxx"
}
```

#### 3.3.4 生成会话标题
```
POST /open-apis/chat/conversation/genTitle?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "conversationId": "15bfc9a618f7a3d116a71dab14ce7e48",
  "content": "用户消息内容"
}
```

**响应数据**: `string` (生成的标题)

---

### 3.4 对话记录模块 (`/open-apis/chat/dialog`)

#### 3.4.1 获取对话记录列表
```
POST /open-apis/chat/dialog/list?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "queryParam": {
    "conversationId": "15bfc9a618f7a3d116a71dab14ce7e48",
    "endId": 12345  // 可选，用于分页（前一页最后一条ID）
  },
  "pageInfo": {
    "pageNum": 1,
    "pageSize": 10
  }
}
```

**响应数据 (DialogMessage[])**:
```json
[
  {
    "conversationId": "15bfc9a618f7a3d116a71dab14ce7e48",
    "msgId": "msg-xxx",
    "inputInfo": {
      "query": "用户提问内容",
      "multiMedias": [
        {
          "mediaType": "image",
          "fileUrl": "https://...",
          "name": "photo.jpg",
          "size": 102400,
          "uploadProgress": 100,
          "status": "completed",
          "tokenUsage": 1000
        }
      ]
    },
    "createTime": "2026-03-27 19:04:03",
    "dialogIdx": 0,
    "dialogLogDetailList": [
      {
        "id": 1,
        "version": "v1",
        "result": "AI回复内容...",
        "dialogStatus": "FINISHED",
        "usage": {
          "promptTokens": 100,
          "completionTokens": 500,
          "totalTokens": 600
        },
        "thinkingCostTime": 2500,
        "feedback": "",         // "good" | "bad" | ""
        "done": true,
        "model": "mimo-v2-flash-studio",
        "webSearchResults": [
          {
            "datePublished": "2026-03-27",
            "url": "https://example.com",
            "name": "搜索结果标题",
            "siteName": "Example",
            "snippet": "摘要...",
            "siteIcon": "https://..."
          }
        ],
        "webSearchDone": true,
        "tips": [
          { "type": "ratio", "value": 0.5 },
          { "type": "truncate", "value": 1000 }
        ]
      }
    ]
  }
]
```

#### 3.4.2 对话反馈
```
POST /open-apis/chat/dialog/feedback?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "id": 12345,           // dialogLogDetail的id
  "feedback": "good",    // "good" | "bad"
  "badReason": "事实错误"  // 仅feedback=bad时提供
}
```

---

### 3.5 资源上传模块 (`/open-apis/resource`)

#### 3.5.1 生成上传信息
```
POST /open-apis/resource/genUploadInfo?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "fileName": "photo.jpg",
  "fileContentMd5": "d41d8cd98f00b204e9800998ecf8427e"  // 可选，文件MD5
}
```

**响应数据**:
```json
{
  "resourceUrl": "https://cdn.xxx/uploaded-file-url",
  "uploadUrl": "https://upload.xxx/presigned-url",
  "objectName": "object-key-in-storage"
}
```

#### 3.5.2 上传文件

获取到 `uploadUrl` 后，直接使用 PUT 方法上传：

```
PUT {uploadUrl}
Content-Type: application/octet-stream
content-md5: {fileContentMd5}  // 可选

Body: 文件二进制内容
```

使用 XMLHttpRequest 实现上传进度监听。

#### 3.5.3 文件解析
```
POST /open-apis/resource/parse?fileUrl=xxx&objectName=xxx&model=mimo-v2-flash-studio&xiaomichatbot_ph=xxx
```

**Query参数**:
| 参数 | 说明 |
|---|---|
| fileUrl | 已上传文件的URL |
| objectName | 存储对象名 |
| model | 使用的模型名称 |

**响应数据**: 解析后的文件信息

**错误码**: `6002` 表示文件内容为空

---

### 3.6 审核模块 (`/open-apis/audit`)

#### 3.6.1 提交审核
```
POST /open-apis/audit/submit?xiaomichatbot_ph=xxx
```

**请求体**: 审核内容对象

**响应数据 (AuditTask)**:
```json
{
  "taskId": "task-xxx",
  "status": "PROCESSING",   // "PROCESSING" | "FINISHED"
  "result": null,            // "PASS" | "REJECT" | null
  "resultCode": null,
  "submittedAt": "2026-03-27T00:00:00Z",
  "finishedAt": null
}
```

#### 3.6.2 查询审核状态
```
GET /open-apis/audit/status?taskId=task-xxx
```

**响应数据**: AuditTask (同上)

---

### 3.7 分享模块 (`/open-apis/share`)

#### 3.7.1 创建分享
```
POST /open-apis/share/createShare?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "conversationId": "xxx",
  "messages": [
    { "msgId": "msg-xxx", "id": 12345 }
  ]
}
```

**响应数据**:
```json
{
  "shareId": "share-xxx"
}
```

#### 3.7.2 获取分享内容
```
GET /open-apis/share/getShare/{shareId}
```

**响应数据**:
```json
{
  "messages": [...],  // DialogMessage[] 格式
  "title": "分享标题"
}
```

#### 3.7.3 从分享继续对话
```
POST /open-apis/share/createShare/continue/{shareId}?xiaomichatbot_ph=xxx
```

**响应数据**:
```json
{
  "newConversationId": "new-conversation-id"
}
```

---

### 3.8 联系方式模块 (`/open-apis/contact`)

#### 3.8.1 获取社区二维码
```
GET /open-apis/contact/get
```

**响应数据**:
```json
{
  "communityQrCodes": [
    "https://chatbot-prod.cnbj3-fusion.mi-fds.com/chatbot-prod/system/mimo-contact/xxx.png?..."
  ]
}
```

---

### 3.9 协议模块 (`/open-apis/agreement`)

#### 3.9.1 同意用户协议
```
POST /open-apis/agreement?xiaomichatbot_ph=xxx
```

#### 3.9.2 同意 Claw 免责声明
```
POST /open-apis/agreement/user/mimo-claw?xiaomichatbot_ph=xxx
```

---

### 3.10 Host 文件模块 (`/open-apis/host-files`)

#### 3.10.1 文件列表
```
GET /open-apis/host-files/list?path=/some/path
```

**响应数据 (HostFileList)**:
```json
{
  "path": "/some/path",
  "items": [
    {
      "name": "document.pdf",
      "path": "/some/path/document.pdf",
      "directory": false,
      "size": 1024000,
      "mtime": 1711540000,
      "type": "text"  // "text" | "image" | "audio" | "video" | "other"
    }
  ]
}
```

#### 3.10.2 文件预览 (WPS)
```
POST /open-apis/host-files/preview?xiaomichatbot_ph=xxx
```

**响应数据 (WpsPreviewToken)**:
```json
{
  "supported": true,
  "fileType": "docx",
  "suffix": ".docx",
  "appId": "wps-app-id",
  "fileId": "file-id",
  "token": "wps-token",
  "tokenExpireTime": 1711540000,
  "reason": null,
  "fdsUrl": "https://..."
}
```

#### 3.10.3 文件下载
```
POST /open-apis/host-files/download?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "path": "/some/path/document.pdf"
}
```

**响应数据 (HostFileDownloadResult)**:
```json
{
  "resourceId": "res-xxx",
  "resourceUrl": "https://download-url",
  "objectName": "object-key",
  "fileName": "document.pdf",
  "path": "/some/path/document.pdf",
  "size": 1024000
}
```

---

### 3.11 LiveKit 实时通信 (`/open-apis/chat/liveKit`)

#### 3.11.1 获取RTC配置
```
POST /open-apis/chat/liveKit/getRtcConfig?xiaomichatbot_ph=xxx
```

**请求体**:
```json
{
  "dispatchType": "auto",
  "metadata": {}
}
```

**响应数据 (RtcConfig)**:
```json
{
  "identity": "user-identity",
  "token": "rtc-token",
  "wsUrl": "wss://livekit-server"
}
```

---

### 3.12 登录URL生成 (`/open-apis/v1`)

#### 3.12.1 生成登录URL
```
GET /open-apis/v1/genLoginUrl
```

用于跳转小米账号登录页面。

---

## 四、WebSocket 通信 (Claw Gateway)

### 4.1 连接地址

```
wss://aistudio.xiaomimimo.com/ws/proxy
```

需先通过 `/open-apis/user/ws/ticket` 获取ticket。

### 4.2 ClawGatewayClient 协议

#### 4.2.1 连接握手

WebSocket连接成功后，发送 `connect` 请求：

```json
{
  "type": "req",
  "id": "uuid",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "mimo-claw-ui",
      "platform": "Win32",
      "mode": "cli"
    },
    "role": "operator",
    "scopes": [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing"
    ],
    "caps": ["tool-events"],
    "userAgent": "Mozilla/5.0...",
    "locale": "zh-CN"
  }
}
```

#### 4.2.2 消息格式

**请求消息**:
```json
{
  "type": "req",
  "id": "unique-id",
  "method": "method-name",
  "params": { ... }
}
```

**响应消息**:
```json
{
  "type": "res",
  "id": "matching-req-id",
  "ok": true,
  "payload": { ... }
}
```

**错误响应**:
```json
{
  "type": "res",
  "id": "matching-req-id",
  "ok": false,
  "error": { "message": "error description" }
}
```

**事件消息**:
```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "challenge-nonce" }
}
```

#### 4.2.3 重连策略

- 初始重连延迟: 800ms
- 指数退避: delay = Math.min(delay * 1.7, 15000ms)
- 连接成功后重置为 800ms
- connect 请求延迟 750ms 发送

#### 4.2.4 请求超时

默认超时: 15000ms (15秒)

---

## 五、前端关键算法

### 5.1 文件内容 MD5 计算

使用 CryptoJS.MD5 计算文件内容的MD5哈希，用于文件上传时的完整性校验：

```javascript
import CryptoJS from "crypto-js";

function computeMD5(content) {
  return CryptoJS.MD5(content).toString();
}
```

### 5.2 文件类型识别

```javascript
const FILE_TYPE_MAP = {
  pdf: "pdf",
  doc: "doc",
  docx: "docx",
  ppt: "ppt",
  pptx: "ppt"
};

function getAttachmentFileType(fileName, mediaType) {
  if (mediaType === "image" || mediaType === "video" || mediaType === "audio") {
    return mediaType;
  }
  const ext = fileName.toLowerCase().split(".").pop() || "";
  return FILE_TYPE_MAP[ext] || "txt";
}
```

### 5.3 文件Block编解码 (Claw模式)

用于在聊天消息中嵌入文件引用：

```javascript
// 编码
function buildFileBlock(files) {
  const payload = { files, prompt: "..." };
  return `<mimo-files>\n${JSON.stringify(payload)}\n</mimo-files>`;
}

// 解码
function parseFileBlock(text) {
  const regex = /<mimo-files>([\S\s]*?)<\/mimo-files>/;
  const match = regex.exec(text);
  if (!match) return { files: [], cleanText: text };
  
  const data = JSON.parse(match[1].trim());
  const files = data.files.filter(f => 
    f && "name" in f && "size" in f && "url" in f && "type" in f
  ).map(f => ({
    name: f.name, size: f.size, url: f.url,
    type: normalizeFileType(f.type)
  }));
  
  return { files, cleanText: text.replace(match[0], "").trim() };
}
```

### 5.4 Think标签解析

AI思考内容使用特殊标签包裹：

```javascript
const THINK_TAG = "<think>\0";       // 以 null 字符结尾
const END_THINK_TAG = "</think>\0";
const MAX_THINK_TAG_COUNT = 3;       // 最多3段思考内容
```

### 5.5 SSE流式响应处理

聊天使用 `completions()` 方法发起流式请求，返回原始 `Response` 对象。前端通过 `ReadableStream` 逐块读取并解析SSE事件：

```javascript
// 发起请求
const [response, error] = await client.completions(
  "/open-apis/bot/chat", 
  requestPayload, 
  abortController.signal
);

// response 是原生 fetch Response，包含 SSE 流
// 前端逐行读取 "data: {...}" 格式的事件
```

---

## 六、环境配置

| 环境 | API Host | Cookie名称 |
|---|---|---|
| development | `//api-chatbot-staging.dt.mi.com` | `michatbot_ph` |
| development-preview | `//api-chatbot-preview.dt.mi.com` | `pre-michatbot_ph` |
| review | `//api-chatbot-staging.dt.mi.com` | `michatbot_ph` |
| staging | `//api-chatbot-preview.dt.mi.com` | `pre-michatbot_ph` |
| preview | `//mimo.dt.mi.com` | `michatbot_ph` |
| **production** | `//aistudio.xiaomimimo.com` | `xiaomichatbot_ph` |

平台管理后台地址: `https://platform.xiaomimimo.com`

---

## 七、错误处理

| HTTP状态码 | 处理方式 |
|---|---|
| 302 / 401 | 登录过期，触发重新登录 |
| 429 / 503 | 服务繁忙，提示用户稍后重试 |
| 451 | 用户被临时封禁 (TEMPORARY) |
| 461 | 用户被永久封禁 (PERMANENT) |

---

## 八、API接口汇总表

| 序号 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | GET | `/open-apis/user/mi/get` | 获取用户信息 |
| 2 | GET | `/open-apis/user/mi/logout` | 登出 |
| 3 | POST | `/open-apis/user/feedback` | 用户反馈 |
| 4 | GET | `/open-apis/user/ws/ticket` | 获取WS票据 |
| 5 | GET | `/open-apis/user/mimo-claw/status` | Claw状态 |
| 6 | POST | `/open-apis/user/mimo-claw/create` | 创建Claw |
| 7 | POST | `/open-apis/user/mimo-claw/destroy` | 销毁Claw |
| 8 | POST | `/open-apis/user/mimo-claw/restart` | 重启Claw |
| 9 | POST | `/open-apis/user/mimo-claw/repair` | 修复Claw |
| 10 | GET | `/open-apis/bot/config` | 获取Bot配置 |
| 11 | POST | `/open-apis/bot/chat` | 聊天补全(SSE) |
| 12 | POST | `/open-apis/chat/conversation/list` | 会话列表 |
| 13 | POST | `/open-apis/chat/conversation/save` | 保存会话 |
| 14 | POST | `/open-apis/chat/conversation/delete` | 删除会话 |
| 15 | POST | `/open-apis/chat/conversation/genTitle` | 生成标题 |
| 16 | POST | `/open-apis/chat/dialog/list` | 对话记录列表 |
| 17 | POST | `/open-apis/chat/dialog/feedback` | 对话反馈 |
| 18 | POST | `/open-apis/resource/genUploadInfo` | 生成上传信息 |
| 19 | POST | `/open-apis/resource/parse` | 文件解析 |
| 20 | POST | `/open-apis/audit/submit` | 提交审核 |
| 21 | GET | `/open-apis/audit/status` | 审核状态 |
| 22 | POST | `/open-apis/share/createShare` | 创建分享 |
| 23 | GET | `/open-apis/share/getShare/{id}` | 获取分享 |
| 24 | POST | `/open-apis/share/createShare/continue/{id}` | 从分享继续 |
| 25 | GET | `/open-apis/contact/get` | 社区二维码 |
| 26 | POST | `/open-apis/agreement` | 同意协议 |
| 27 | POST | `/open-apis/agreement/user/mimo-claw` | 同意Claw声明 |
| 28 | GET | `/open-apis/host-files/list` | Host文件列表 |
| 29 | POST | `/open-apis/host-files/preview` | 文件预览 |
| 30 | POST | `/open-apis/host-files/download` | 文件下载 |
| 31 | POST | `/open-apis/chat/liveKit/getRtcConfig` | RTC配置 |
| 32 | GET | `/open-apis/v1/genLoginUrl` | 生成登录URL |

---

> 注：所有 POST 请求均自动在URL中附加 `?xiaomichatbot_ph=xxx` 参数（从同名cookie读取）
