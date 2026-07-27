# 小微 AI Handoff 模式开发规范

本文件描述将微信小程序接入“小微 AI Agent + AI Handoff”的标准流程，并约束后续在本仓库新增或修改 AI 能力时的实现方式。本规范自包含，不依赖仓库中的 README、示例 Skill 或既有业务页面。

## 1. 先设计能力，再写页面

对每个 Skill 先写清四件事：

1. **用户意图**：用户会如何表达需求，以及哪些说法需要追问澄清。
2. **原子接口**：每个接口只完成一个真实业务动作；输入、输出、错误和副作用必须可验证。
3. **调用约束**：哪些接口必须以前一步的结果为前置条件；禁止 Agent 编造 ID、金额、规格、地址或权限。
4. **接力页**：接口成功后用户应进入哪个小程序页面继续完成复杂交互。

对下单、支付、预约、删除、提交等有副作用的动作，接口必须做登录态、资源归属、参数合法性和幂等校验；不能因为 Agent 调用了接口就跳过业务确认。

## 2. 建立独立 Skill 分包

每个业务能力放在独立目录，例如：

```text
skills/<skill-name>/
├── SKILL.md       # 业务能力、意图分流、调用顺序和边界
├── mcp.json       # 原子接口名称、Schema、页面元数据
├── index.js       # 创建 Skill 并注册接口
├── apis/          # 每个原子接口一个实现文件
├── components/    # 可复用原子组件；Handoff 场景中可不在对话内渲染
└── utils/         # 无 UI 的共享工具
```

在 `app.json` 中合并以下配置，不能覆盖项目既有页面或分包：

```json
{
  "lazyCodeLoading": "requiredComponents",
  "subPackages": [
    { "root": "skills", "pages": [], "independent": true }
  ],
  "agent": {
    "skills": [
      {
        "name": "<skill-name>",
        "description": "用一句话说明 Agent 可完成的业务范围",
        "path": "skills/<skill-name>"
      }
    ],
    "pageMetadata": "page-meta.json"
  }
}
```

`page-meta.json` 用于声明无需先调用原子接口即可展示的小程序页面信息。`agent.skills[].path`、`createSkill()` 的路径和实际目录必须完全一致。

## 3. 声明并实现原子接口

### 3.1 `mcp.json`

每个接口必须声明：

- 稳定且唯一的 `name`；
- `description`，包含适用条件、禁止场景和数据来源；
- 严格的 `inputSchema` 与 `outputSchema`；
- Handoff 接力页：`_meta.ui.pagePath`，只写页面路径，不把 query 拼进该字段；
- 可复用组件路径：`_meta.ui.componentPath`。当前小微 Handoff 对话不渲染原子组件时，保留它作为未来复用信息即可。

输入值必须来自用户明确表达或上游接口的结构化返回；没有可信 ID 时，先查询或追问，不得猜测。

### 3.2 `index.js`

用小程序模型上下文创建并注册 Skill。注册名必须与 `mcp.json` 完全一致：

```js
const skill = wx.modelContext.createSkill('skills/<skill-name>')
skill.registerAPI('searchSomething', searchSomething)
```

不要把业务逻辑堆在 `index.js`；每个 API 独立实现，便于校验、测试和审计。

### 3.3 接口返回值

成功结果应同时区分给用户、给 Agent 和给页面的数据：

```js
{
  isError: false,
  content: [{ type: 'text', text: '简短说明下一步操作。' }],
  structuredContent: { /* Agent 用的可信业务摘要 */ },
  handoff: {
    query: 'itemId=123',
    payload: { /* 接力页首屏可用的非敏感预置数据 */ }
  },
  _meta: { /* 仅渲染层需要的数据 */ }
}
```

- `handoff.query` 必须是字符串；页面 `onLoad(query)` 收到的是框架解析后的对象。
- `payload` 只用于首屏加速或减少重复查询，不能携带令牌、身份证号、支付签名等敏感数据，也不能替代服务端再次鉴权。
- `content` 在 Handoff 模式下保持简短，引导用户点击小程序卡片；商品详情、选择器和支付 UI 交给接力页完成。
- 失败结果要明确说明失败原因和正确出口。对于不支持的意图，直接说明能力边界，禁止“凑一个接口调用”。

## 4. 实现 AI Handoff 接力

目标链路如下：

```text
用户对话
  → Agent 选择原子接口
  → 接口返回文本 + handoff
  → 用户点击小程序卡片
  → wx.onAgentHandoff(pageId, path, query, payload)
  → 接力页 onLoad(query)
  → 小程序内使用普通导航完成后续交互
```

实现要求：

1. 在 `app.js` 的 `onLaunch` 尽早注册 `wx.onAgentHandoff`，早于接力页路由。
2. 以 `pageId` 为键缓存 `{ path, query, payload }`，而不是使用全局“最后一次 handoff”，避免并发页面串数据。
3. 接力页在 `onLoad(query)` 先解析 URL 参数，再按自己的 `pageId` 取一次 payload；消费后删除缓存，避免重复使用。
4. 页面必须能在 payload 缺失或基础库不支持时安全降级：根据 query 重新查询可信业务数据，或显示明确的错误/重试入口。
5. 进入接力页后，选规格、地址、确认、支付等流程使用普通小程序导航和页面交互完成；不要依赖当前不可用或未确认可用的“返回 Agent 对话”能力。

全局监听与一次性消费可按以下通用模板实现：

```js
App({
  globalData: {
    agentHandoffs: {}
  },

  onLaunch() {
    if (typeof wx.onAgentHandoff !== 'function') {
      console.warn('当前基础库不支持 wx.onAgentHandoff')
      return
    }

    wx.onAgentHandoff(({ pageId, path, query, payload }) => {
      if (!pageId) return
      this.globalData.agentHandoffs[pageId] = {
        path,
        query,
        payload
      }
    })
  },

  takeAgentHandoff(pageId) {
    const handoffs = this.globalData.agentHandoffs
    const handoff = handoffs[pageId]
    if (handoff) delete handoffs[pageId]
    return handoff || null
  }
})
```

接力页不应依赖 payload 才能打开。页面需要先读取框架已经解析好的 `query`，再把同一 `pageId` 对应的 payload 作为可选的首屏数据；若两者都不能提供可信业务 ID，则进入明确的失败或重试状态：

```js
Page({
  onLoad(query) {
    const app = getApp()
    const pageId = typeof this.getPageId === 'function'
      ? this.getPageId()
      : ''
    const handoff = pageId && app.takeAgentHandoff
      ? app.takeAgentHandoff(pageId)
      : null
    const payload = handoff && handoff.payload
    const resourceId = query && query.resourceId
      ? String(query.resourceId)
      : payload && payload.resourceId
        ? String(payload.resourceId)
        : ''

    if (!resourceId) {
      this.setData({
        loadError: '缺少有效的业务标识，请返回后重试。'
      })
      return
    }

    // 必须使用 resourceId 向可信数据源重新查询并鉴权。
    // payload 只能用于首屏预置，不能替代服务端数据。
    this.loadTrustedResource(resourceId, payload)
  }
})
```

原子接口与接力页的映射应在设计阶段写成表格并随实现维护。每一行至少包含接口名、`handoff.query` 的参数、`_meta.ui.pagePath`、页面消费的数据和失败降级方式，不能依赖某个 Demo 的固定接口名或页面路径。

## 5. 鉴权、数据与支付

1. 将原子接口视为独立执行边界。生产环境必须使用服务端会话或受控云函数验证用户身份与资源归属，不能信任 query、payload 或前端缓存中的订单状态。
2. 不得在小程序代码、`SKILL.md`、`mcp.json`、日志或 handoff payload 中写入 AppSecret、服务端密钥、模型 API Key、支付签名或完整敏感个人信息。
3. 创建订单、扣减库存、支付回调、退款和权限变更由服务端作为唯一事实来源；客户端只展示服务端确认后的状态。
4. 任何 `mockLogin`、前端本地存储业务状态或演示支付参数都只能用于跑通 demo，不能复制到生产环境。
5. 为写操作设计幂等键、重复调用保护、审计日志和人工可追溯的错误码。

## 6. 测试与验收

每次新增或修改 Skill 后，至少完成以下验证：

- [ ] `app.json` 的 `agent.skills`、独立分包路径、`mcp.json` 和 `index.js` 注册名一致。
- [ ] 每个 API 的成功、参数缺失、无权限、上游数据不存在和业务不支持分支都可复现。
- [ ] 在“小程序 AI 编译”模式下逐个执行接口，并检查 schema、文本、结构化结果和页面元数据。
- [ ] 用真实对话覆盖：明确意图、模糊意图、歧义追问、不支持请求、连续多步请求和重复提交。
- [ ] 覆盖每一条 Handoff：卡片 → 正确 pagePath → 正确 query → 正确 payload → 页面恢复/降级。
- [ ] 在普通小程序编译模式回归现有页面，确保未接入 AI 的用户路径仍可使用。
- [ ] 涉及登录、订单、地址、支付或外部服务时，完成服务端鉴权、权限和幂等测试；不得以本地 mock 代替生产验收。

## 7. 发布与运维边界

1. 先使用已获权限的测试 AppID 做验证，再决定是否进入生产版本；不要假设内测能力可以直接提审或全量发布。
2. 发布前重新核对微信后台的能力状态、审核要求、隐私规则、配额和计费条款；这些规则可能变更。
3. 记录 Skill 版本、接口版本、失败率、Handoff 成功率、降级次数和有副作用操作的审计记录。
4. 如果接入云开发、第三方模型或自建后端，分别评估其 Token、调用次数、数据库、存储、网络和支付成本；这些成本与本地 demo 是否能运行无关。

## 参考

- 微信小程序 AI 开发模式文档：<https://developers.weixin.qq.com/miniprogram/dev/ai/guide.html>
