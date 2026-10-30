/**
 * dsh-qq-bot —— 浏览器半（client half）
 *
 * 作用：在 **设置 → 插件 → 插件配置** 里放一张名为“QQ 桥接”的卡片，
 * 用来改昵称、白名单、唤醒概率、目标会话这些设置 —— 也就是用户要的那个界面。
 *
 * 为什么这里的东西长得不像源码：
 *   DSH 的官方文档明确说，本仓库之外没有现成的 client 打包预设
 *   （`packages/client/tsdown.client.ts` 不发布），外部插件得自己复刻产物格式。
 *   好在格式很简单：`window.__ModuleLoader__.load({ id, factory })`，
 *   `factory(require)` 返回一个带 `apply` / `inject` 的 Cordis 插件。
 *   这里就是**手写**这个格式，不引入任何构建步骤。
 *   参考实现：第三方插件 `dshmarket` 的 `client/client.js`（同样是手写/预构建产物）。
 *
 * 与宿主半的约定：
 *   - `id` 必须等于包名 `dsh-qq-bot`；
 *   - 卡片注册进 `settings.plugin.item`，**key 必须等于宿主注册的 settings 命名空间** `qq-bridge`，
 *     否则配置页那一栏里什么都不会出现（它按命名空间派发）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // react 是模块表里的 baseline 依赖，不用在 package.json 里声明 external。
    const react = require('react')
    const h = react.createElement

    /** settings 命名空间，必须与 index.js 里的 NS 一致。 */
    const NS = 'qq-bridge'

    // ── 表单描述 ──────────────────────────────────────────────────────────────
    // 加一个设置项 = 在这里加一行。kind: text | list | number | boolean | select
    const FIELDS = [
      {
        key: 'sessionScope',
        label: '会话怎么分',
        kind: 'select',
        options: [
          ['single', '所有群共用一个会话'],
          ['perGroup', '每个群、每个私聊各记各的'],
        ],
        hint: '共用一个会话：所有 QQ 消息都进下面选的那一个会话。各记各的：每个群、每个私聊自动开一条上下文，互不抢回复。',
      },
      {
        key: 'maxRecentTurns',
        label: '每个会话最多留几轮',
        kind: 'number',
        hint: '默认 40。聊太长会尽量把更早的内容压缩掉，回复更快。填 0 表示不限制。',
      },
      {
        key: 'targetSessionId',
        label: '接到哪个会话',
        kind: 'session',
        hint: '按名字选就行，不用记那串 id。选「每个群、每个私聊各记各的」时可以留空，留空就用宿主当前的默认模型；填了则新建的会话沿用这个会话的模型。',
      },
      {
        key: 'nicknames',
        label: '听到这些名字就回应',
        kind: 'list',
        hint: '别人喊到这些名字就一定回话。用逗号分开，例如：244, 小助手。',
      },
      {
        key: 'wakeProbability',
        label: '没点名时的回应概率',
        kind: 'number',
        step: '0.01',
        hint: '没 @、也没喊名字时，按这个概率回话（0 到 1）。默认 0.05，也就是大约二十条里回一条。想少说话就调小。',
      },
      {
        key: 'whitelist',
        label: '哪些私聊可以叫醒',
        kind: 'list',
        hint: '填 QQ 号，用逗号分开。留空 = 任何私聊都不会叫醒机器人。',
      },
      {
        key: 'groupWhitelist',
        label: '哪些群可以叫醒',
        kind: 'list',
        hint: '填群号，用逗号分开。留空 = 任何群都不会叫醒机器人。',
      },
      {
        key: 'atOnlyInGroup',
        label: '群里必须 @ 才理',
        kind: 'boolean',
        hint: '打开之后，群里没 @ 机器人就当没看见。比上面的概率更严。',
      },
      {
        key: 'replyMode',
        label: '群里发出去的是哪一段',
        kind: 'select',
        options: [
          ['marker', '只发「发给群」里的那段'],
          ['tool', '用发消息工具'],
          ['always', '整段回答都进群（慎用）'],
        ],
        hint: '「发给群」的那段要用 [QQ] 和 [/QQ] 包起来，包外面的话不会进群。选「用发消息工具」就改调 qq_bridge_send。选「整段回答都进群」会把思考过程也发出去，一般别用。',
      },
      {
        key: 'delivery',
        label: '忙的时候怎么插话',
        kind: 'select',
        options: [
          ['auto', '能插就插，不能就排队（推荐）'],
          ['followup', '一律新开一轮'],
          ['steer', '不管忙不忙都插'],
        ],
        hint: '推荐：会话正忙就插进去接着说，闲着就排队等下一轮。「一律新开一轮」每次都等当前这轮结束。「不管忙不忙都插」会打断正在做的事。',
      },
      { key: 'replyWithQuote', label: '回复时带上原消息', kind: 'boolean', hint: '回话时引用那条把机器人叫醒的消息。' },
      { key: 'stripMarkdown', label: '去掉 Markdown 记号', kind: 'boolean', hint: '发出去之前拿掉 **粗体**、`代码` 这类记号。QQ 不会渲染它们。' },
      {
        key: 'replyMaxChars',
        label: '一条最多多少字',
        kind: 'number',
        hint: '超过这个字数就整条不发，需要缩短后再发。',
      },
      {
        key: 'onebotUrl',
        label: 'OneBot 连接地址',
        kind: 'text',
        hint: 'NapCat 的 WebSocket 地址，例如 ws://127.0.0.1:3001。留空 = 先不连接。',
      },
      {
        key: 'accessTokenEnv',
        label: 'OneBot 令牌放在哪个环境变量',
        kind: 'text',
        hint: '填环境变量的名字（例如 NAPCAT_TOKEN），不要把令牌本身贴进来。这也不是模型的 API key。NapCat 没开令牌校验就留空。',
        check: (v) => {
          const s = String(v ?? '').trim()
          if (s === '') return null
          if (/^(sk-|Bearer\s)/i.test(s) || s.length > 64 || /[.\s]/.test(s)) {
            return '这里要填的是环境变量名（例如 NAPCAT_TOKEN），不是令牌本身，也不是模型的 API key。'
          }
          return null
        },
      },
      { key: 'selfId', label: '机器人自己的 QQ 号', kind: 'text', hint: '留空 = 连上之后自动读取。' },
      {
        key: 'visionModel',
        label: '用来看图的模型',
        kind: 'text',
        hint: '写成 provider/model。留空 = 自动找一个能看图的模型。',
      },
      {
        key: 'agentPreset',
        label: '人设预设',
        kind: 'text',
        hint: '接到会话时用哪套人设。留空 = 沿用那个会话自己记着的。',
      },
      { key: 'attachRecentChat', label: '把没叫醒时的聊天一并带上', kind: 'boolean', hint: '下次叫醒时，把中间没理的那些话一起附上。' },
      { key: 'recentChatLimit', label: '附带最近几条', kind: 'number', hint: '上面那段最多带最近几条（0–200）。' },
      {
        key: 'napcatInstallDir',
        label: 'NapCat 安装目录',
        kind: 'text',
        hint: '留空 = $DSH_HOME/napcat。自己装的或 Docker 里的 NapCat 不在这个默认位置，请填实际目录。',
      },
      {
        key: 'napcatWebuiUrl',
        label: 'NapCat 网页管理地址',
        kind: 'text',
        hint: '可选。留空就读安装目录里的 webui.json。那边通常是 127.0.0.1，只有跑着 NapCat 的那台机器能打开。远程使用时填一个外面打得开的地址。',
      },
      { key: 'napcatVersion', label: '要下载的 NapCat 版本', kind: 'text', hint: '例如 v4.18.28。留空 = 下载最新版。' },
      { key: 'downloadProxy', label: '下载时走的代理', kind: 'text', hint: '例如 http://127.0.0.1:7890。留空 = 先看环境变量，没有就直接下载。' },
      {
        key: 'onebotPort',
        label: 'OneBot 端口',
        kind: 'number',
        hint: '写进 NapCat 配置、也用来连接的端口。NapCat 如果是自己另外部署的，这里要和那边的端口一致。',
      },
      { key: 'qqNumber', label: '快速登录用的 QQ 号', kind: 'text', hint: '需要先在 NapCat 里成功登录过一次。' },
    ]

    function format(field, raw) {
      if (field.kind === 'list') return Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw)
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') return raw == null || raw === '' ? '' : String(raw)
      return raw == null ? '' : String(raw)
    }

    /** 表单值 → 要写进设置的 JSON；数字不合法返回 undefined（拦住保存）。 */
    function parse(field, raw) {
      if (field.kind === 'list') {
        return String(raw == null ? '' : raw)
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter((s) => s !== '')
      }
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') {
        const n = Number(raw)
        return Number.isFinite(n) ? n : undefined
      }
      return String(raw == null ? '' : raw).trim()
    }

    function draftFrom(value) {
      const v = value && typeof value === 'object' ? value : {}
      const draft = {}
      for (const f of FIELDS) draft[f.key] = format(f, v[f.key])
      return draft
    }

    function same(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /**
     * 会话下拉的选项：真实的会话列表 + “不驱动”+ 一个兜底项。
     *
     * **归档的会话不列出来**（用户报的 bug：下拉里混进了一堆早就归档的会话）——
     * 归档集在 workspace 域：`ctx.workspaces.list.getSnapshot().archivedSessionIds`。
     *
     * ⚠️ **TODO（下次修）：子代理会话也会被列进来。**
     * `SessionSummary` 上有 `origin?: 'subagent'` 与 `parentId?: SessionId`
     * （见 `@deepseek-ai/dsh-api-session-controller` 的 `SessionSummary`），据此可以剔除。
     * 剔除之后同样要给**当前选中项**兜底，规则与下面的归档处理一致 ——
     * 否则子代理会话是当前目标时，一保存就把目标会话清空。
     * 退化做法也可接受：把它们折叠进一个“显示子代理会话”的展开项，别一次铺开一长串。
     *
     * 两个兜底项都是必要的：
     * - 配置里那个 id 可能**不在**列表里（别的工作区、宿主还没加载完）；
     * - 也可能**正好是归档的**（用户刚把它归档了）。
     * 两种都必须保留成选项，否则用户一保存就把目标会话清空了。
     */
    function sessionOptions(state, current, archivedIds) {
      const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map((id) => String(id)))
      const out = [{ value: '', label: '（不接到任何会话）' }]
      const ids = Array.isArray(state?.ids) ? state.ids : []
      const byId = state && typeof state.byId === 'object' && state.byId ? state.byId : {}
      const cur = String(current ?? '')
      const seen = new Set([''])
      for (const id of ids) {
        const key = String(id)
        const isArchived = archived.has(key)
        // 归档的一律不显示 —— 除非它就是当前选中的那个（不显示的话就没法保留/换掉了）
        if (isArchived && key !== cur) continue
        seen.add(key)
        const row = byId[id] ?? {}
        const title = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : key
        out.push({
          value: key,
          label: `${title}${row.running ? '（运行中）' : ''}${isArchived ? '（已归档）' : ''}`,
        })
      }
      if (cur !== '' && !seen.has(cur)) {
        out.push({ value: cur, label: `${cur}（${archived.has(cur) ? '已归档' : '不在会话列表里'}）` })
      }
      return out
    }

    /** 没有 sessions / workspaces 服务（或它们还没就绪）时用的稳定空快照 —— 必须稳定，否则 useSyncExternalStore 会死循环。 */
    const EMPTY_SESSION_LIST = { ids: [], byId: {} }
    const EMPTY_WORKSPACES = { archivedSessionIds: [] }

    // ── 样式（内联，跟随主题文字色） ──────────────────────────────────────────
    const BORDER = '1px solid rgba(127,127,127,0.35)'
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px' },
      head: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '14px', fontWeight: 600 },
      sub: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 12px', alignItems: 'start' },
      label: { fontSize: '13px', paddingTop: '5px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
      },
      hint: { fontSize: '11px', opacity: 0.55, marginTop: '3px', lineHeight: 1.5 },
      check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', paddingTop: '4px' },
      foot: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      btn: {
        padding: '5px 14px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
      },
      primary: { background: 'rgba(127,127,127,0.18)', fontWeight: 600 },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      },
      chevron: { marginLeft: 'auto', opacity: 0.6 },
      note: { fontSize: '12px', opacity: 0.7 },
      err: { fontSize: '12px', color: '#e5534b' },
      overridden: { fontSize: '11px', opacity: 0.5, marginLeft: '4px' },
      // “撤销覆盖”：与“·已覆盖”并排的小按钮。文案本身就是动作，不加图标。
      link: {
        marginLeft: '4px',
        padding: '0 4px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.75,
        textDecoration: 'underline',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '11px',
      },
      ops: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    }

    function disabled(btn, off) {
      return off ? { ...btn, opacity: 0.5, cursor: 'default' } : btn
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────────

    function Card(props) {
      const scope = props.scope
      const subscribe = react.useCallback((cb) => scope.subscribe(cb), [scope])
      const getSnapshot = react.useCallback(() => scope.getSnapshot(), [scope])
      const snap = react.useSyncExternalStore(subscribe, getSnapshot)

      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')
      // 默认展开：字段直接可见。标题仍可收起。
      const [open, setOpen] = react.useState(true)
      // NapCat 的三个操作按钮：展开时拉一次接口；拿不到就保持 null（按钮禁用）。
      const [napcat, setNapcat] = react.useState(null)
      const [napcatBusy, setNapcatBusy] = react.useState('')

      const current = react.useMemo(() => draftFrom(snap.value), [snap.value])
      const shown = draft ?? current
      const dirty = draft !== null && !same(draft, current)
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}

      // ── 目标会话的下拉数据源 ──────────────────────────────────────────────
      // ctx.sessions.list 是客户端 SDK 暴露的会话列表快照（ObservableSnapshot）。
      // 取不到（这个部署没装 sessions 服务、或它还没就绪）就退回“只有兜底项”，
      // 卡片本身照常渲染 —— 宁可少一个下拉，也不要整张卡片消失。
      const sessions = props.sessionsOf ? props.sessionsOf() : undefined
      const listStore = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list : undefined
      const listSubscribe = react.useCallback((cb) => (listStore ? listStore.subscribe(cb) : () => {}), [listStore])
      const listGetSnapshot = react.useCallback(
        () => (listStore ? listStore.getSnapshot() : EMPTY_SESSION_LIST),
        [listStore],
      )
      const sessionList = react.useSyncExternalStore(listSubscribe, listGetSnapshot)
      react.useEffect(() => {
        // 进卡片时拉一次，免得显示的是很久以前的标题
        if (sessions && typeof sessions.refresh === 'function') Promise.resolve(sessions.refresh()).catch(() => {})
      }, [sessions])

      // 归档集在 workspace 域：ctx.workspaces.list 的快照里有 archivedSessionIds
      //（“Complete registry-global archive set”）。取不到就当作“没有归档的会话”——
      // 宁可多列几个，也别把用户能选的会话藏掉。
      const workspaces = props.workspacesOf ? props.workspacesOf() : undefined
      const wsStore =
        workspaces && workspaces.list && typeof workspaces.list.getSnapshot === 'function' ? workspaces.list : undefined
      const wsSubscribe = react.useCallback((cb) => (wsStore && typeof wsStore.subscribe === 'function' ? wsStore.subscribe(cb) : () => {}), [wsStore])
      const wsGetSnapshot = react.useCallback(() => {
        if (!wsStore) return EMPTY_WORKSPACES
        try {
          return wsStore.getSnapshot() ?? EMPTY_WORKSPACES
        } catch {
          return EMPTY_WORKSPACES
        }
      }, [wsStore])
      const workspaceSnapshot = react.useSyncExternalStore(wsSubscribe, wsGetSnapshot)

      /**
       * 拉一次 NapCat 状态（WebUI 地址 + 是否在运行）。
       * 没有 fetch 或响应不是 ok:true 时返回 undefined，调用方保持上一次的状态。
       */
      async function fetchNapcat() {
        if (typeof fetch !== 'function') return undefined
        const res = await fetch(NAPCAT_API, { credentials: 'include', headers: { accept: 'application/json' } })
        const body = await res.json().catch(() => ({}))
        return body && body.ok === true ? body : undefined
      }

      // 展开卡片时读一次 NapCat 状态，之后每 5 秒轮询一次。
      // 轮询用于识别外部启动：用户在别处手动跑了 bat 时，只有重新拉取才能把按钮改成“已在运行”。
      // 卡片收起或组件卸载时清掉定时器，不让它在后台一直跑。
      react.useEffect(() => {
        if (!open) return undefined
        let alive = true
        const pull = () => {
          fetchNapcat()
            .then((body) => {
              if (alive && body !== undefined) setNapcat(body)
            })
            .catch(() => {
              // 单次失败保留上一次的状态：轮询会再试，不给按钮闪一下禁用。
            })
        }
        pull()
        const timer = setInterval(pull, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [open])

      /** 两个 POST 按钮共用：动作没成（ok:false）也把宿主的 error 原文显示出来。 */
      async function postNapcat(action, okNote) {
        setNapcatBusy(action)
        setError('')
        setNote('')
        try {
          if (typeof fetch !== 'function') throw new Error('这个环境没有 fetch')
          // 显式声明 JSON：宿主接口对**带请求体**的 POST 只认 application/json。
          // 这两个动作本身没有请求体，服务端也放行无体的 POST —— 那条是给还没刷新的旧 bundle 兜底。
          const res = await fetch(`${NAPCAT_API}/${action}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          setNote(String(body?.message || okNote))
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setNapcatBusy('')
          // 成功或失败都重拉一次：启动成功后按钮要立刻变“已在运行”，
          // 被宿主拒绝（例如已在运行）时也要把真实状态显示出来。
          try {
            const fresh = await fetchNapcat()
            if (fresh !== undefined) setNapcat(fresh)
          } catch {
            // 拉取失败时保留上一次的状态
          }
        }
      }

      function change(key) {
        return (event) => {
          const next = { ...shown }
          next[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
          setDraft(next)
          setNote('')
          setError('')
        }
      }

      async function save() {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const writes = []
          for (const f of FIELDS) {
            if (same(current[f.key], shown[f.key])) continue
            const next = parse(f, shown[f.key])
            if (next === undefined) throw new Error(`「${f.label}」不是合法数字`)
            writes.push([f.key, next])
          }
          for (const [key, value] of writes) await scope.set(key, value)
          setDraft(null)
          setNote(writes.length === 0 ? '没有改动' : `已保存 ${writes.length} 项`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      /**
       * 撤销一个字段的本机覆盖。
       *
       * 设置读取优先级是“设置文件 > composition config”。卡片只发 set 时，
       * 用户从插件配置页改的值会被设置文件里的旧值盖住，且没有地方撤销。
       * 这里走设置源的 unset：清掉那一项，该键回落到 composition config 的值，
       * 刷新后“·已覆盖”标记消失。
       */
      async function unsetOverride(key) {
        const field = FIELDS.find((f) => f.key === key)
        setBusy(true)
        setError('')
        setNote('')
        try {
          if (typeof scope.unset !== 'function') throw new Error('这个设置源不支持撤销覆盖')
          await scope.unset(key)
          setDraft(null)
          setNote(`已撤销「${field ? field.label : key}」的本机覆盖`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      if (snap.status === 'loading') {
        return h('div', { style: S.wrap }, h('div', { style: S.sub }, '载入设置中…'))
      }
      if (snap.status === 'unavailable') {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, 'QQ 桥接'),
          h(
            'div',
            { style: S.sub },
            '这个部署没有为 qq-bridge 提供可写的设置服务（settings 提供者没挂载，或连接处于内存模式）。',
          ),
          h(
            'div',
            { style: S.hint },
            '宿主的两条设置通道都没拿到：插件配置表单（DSH 0.2.0 的 #677 迁移未完成）与本插件的本机设置接口。',
          ),
          h(
            'div',
            { style: S.hint },
            '先看诊断里「本机接口」那项：若宿主没有 webServer 服务，接口挂不上（此时仍可点右上角「打开配置文件」，改 profile 的 cordis.patch.yml 里 `- id: qq-bridge` 的 config 后重启）。',
          ),
          h(
            'div',
            { style: S.hint },
            `诊断：${typeof scope.detail === 'function' ? scope.detail() : '（无诊断信息）'}`,
          ),
        )
      }

      const rows = []
      for (const f of FIELDS) {
        const value = shown[f.key]
        const overridden = Object.prototype.hasOwnProperty.call(user, f.key)
        let control
        if (f.kind === 'boolean') {
          control = h(
            'label',
            { style: S.check },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: !snap.writable || busy,
              onChange: change(f.key),
            }),
            h('span', null, f.hint || ''),
          )
        } else if (f.kind === 'select') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            (f.options || []).map(([v, text]) => h('option', { key: v, value: v }, text)),
          )
        } else if (f.kind === 'session') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            sessionOptions(sessionList, value, workspaceSnapshot?.archivedSessionIds).map((o) =>
              h('option', { key: o.value || '(none)', value: o.value }, o.label),
            ),
          )
        } else {
          control = h('input', {
            type: f.kind === 'number' ? 'number' : 'text',
            ...(f.step ? { step: f.step } : {}),
            style: S.input,
            value: String(value),
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
          })
        }
        rows.push(
          h(
            'div',
            { key: f.key, style: S.label },
            f.label,
            overridden ? h('span', { style: S.overridden }, '·已覆盖') : null,
            // 每个字段都有自己的标签格，所以逐字段放按钮对所有类型都成立 —— 不必只给一个统一按钮。
            overridden
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: disabled(S.link, busy || !snap.writable),
                    disabled: busy || !snap.writable,
                    title: '清掉设置文件里的这一项，回落到 composition config 的值',
                    onClick: () => unsetOverride(f.key),
                  },
                  '撤销覆盖',
                )
              : null,
          ),
        )
        rows.push(
          h(
            'div',
            { key: `${f.key}-ctl` },
            control,
            f.kind !== 'boolean' && f.hint
              ? h(
                  'div',
                  { style: S.hint },
                  // 会话下拉额外把真实 id 显示出来：看着名字选，但真要手抄/核对时 id 就在旁边
                  (f.kind === 'session' && String(value) !== '' ? `${f.hint}当前：${value}` : f.hint) +
                    (typeof f.check === 'function' && f.check(value) ? `\n⚠️ ${f.check(value)}` : ''),
                )
              : null,
          ),
        )
      }

      // 地址由宿主拼好：填了「NapCat 网页管理地址」就用它，否则用 webui.json。
      // 回环地址按钮保持可点（本机用户需要），旁边说明只有跑着 NapCat 的机器打得开。
      const webuiUrl = napcat && typeof napcat.webuiUrl === 'string' ? napcat.webuiUrl : ''
      const webuiHint = napcat && typeof napcat.webuiHint === 'string' ? napcat.webuiHint : ''
      const dirHint = napcat && typeof napcat.installDirMissingHint === 'string' ? napcat.installDirMissingHint : ''
      // 宿主报的 running 是权威判据（含外部启动的 NapCat）。拿不到状态时按未运行处理。
      const napcatRunning = napcat !== null && napcat.running === true
      const napcatOps = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h(
          'div',
          { style: S.ops },
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, webuiUrl === '' || napcatBusy !== ''),
              disabled: webuiUrl === '' || napcatBusy !== '',
              onClick: () => {
                if (webuiUrl !== '') window.open(webuiUrl, '_blank', 'noopener')
              },
            },
            '打开 WebUI',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, napcatRunning || napcatBusy !== ''),
              disabled: napcatRunning || napcatBusy !== '',
              onClick: () => postNapcat('launch', '已启动 NapCat'),
            },
            napcatRunning ? '已在运行' : napcatBusy === 'launch' ? '启动中…' : '启动 NapCat',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, napcatBusy !== ''),
              disabled: napcatBusy !== '',
              onClick: () =>
                postNapcat('reveal', napcat && napcat.installDir ? `已打开文件夹：${napcat.installDir}` : '已打开文件夹'),
            },
            napcatBusy === 'reveal' ? '打开中…' : '打开文件夹',
          ),
        ),
        webuiUrl === ''
          ? h('div', { style: S.hint }, '没读到 webui.json。远程或自己部署时，请填写上面的「NapCat 网页管理地址」。')
          : null,
        webuiUrl !== '' && webuiHint !== '' ? h('div', { style: S.hint }, webuiHint) : null,
        dirHint !== '' ? h('div', { style: S.hint }, dirHint) : null,
      )

      const header = h(
        'button',
        { type: 'button', onClick: () => setOpen(!open), 'aria-expanded': open, style: S.header },
        h('span', { style: S.title }, 'QQ 桥接'),
        h('span', { style: S.sub }, dirty ? '有未保存的改动' : '把固定的 DSH 会话接到 QQ'),
        h('span', { style: S.chevron }, open ? '▴' : '▾'),
      )
      if (!open) return h('div', { style: S.wrap }, header)
      return h(
        'div',
        { style: S.wrap },
        header,
        h('div', { style: S.grid }, rows),
        napcatOps,
        h(
          'div',
          { style: S.foot },
          h(
            'button',
            {
              type: 'button',
              style: disabled({ ...S.btn, ...S.primary }, !dirty || busy || !snap.writable),
              disabled: !dirty || busy || !snap.writable,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, !dirty || busy),
              disabled: !dirty || busy,
              onClick: () => {
                setDraft(null)
                setError('')
                setNote('')
              },
            },
            '放弃修改',
          ),
          !snap.writable ? h('span', { style: S.note }, '（只读：这个连接不改宿主文档）') : null,
          error ? h('span', { style: S.err }, error) : null,
          !error && note ? h('span', { style: S.note }, note) : null,
        ),
      )
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────

    /** 需要的浏览器服务：slots（注册卡片）；settingsScope 在 apply 里等它出现。 */
    const inject = ['slots']

    // TODO(0.2.0): 平台把第三方插件的设置桥接上之后（web-all / DSH 修完 #677 的迁移），
    // 可以砍掉多余候选 key 与卡片上那行“诊断”；`namespaces` / `detail()` 建议保留（排障用）。
    // 详见 docs/dsh-0.2.0-migration.md 的 TODO 节。
    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑，谁 ready 用谁**。
     */
    /** 0.2.0 的兜底数据源：宿主自己挂的本机接口（见宿主半的 handleSettingsRequest）。 */
    const API_PATH = '/api/qq-bridge/settings'
    /** NapCat 操作接口（宿主半不受 legacy 门控，两代宿主都挂）。 */
    const NAPCAT_API = '/api/qq-bridge/napcat'
    /** 稳定引用：useSyncExternalStore 的 getSnapshot 每次返回新对象会死循环。 */
    const LOADING_SNAPSHOT = { status: 'loading' }
    const UNAVAILABLE_SNAPSHOT = { status: 'unavailable' }

    /**
     * 走宿主本机接口的设置域（0.2.0 用）。
     *
     * 为什么需要它：0.2.0 的 `webUiSettings` 桥对第三方插件永远返回 `unavailable`
     * （证据见 docs/dsh-0.2.0-migration.md）。范本：皮肤中心
     * `@linxin666/dsh-client-ui-skin-center` 就是自己 `inject: ["webServer"]` 挂
     * `/api/skin-center/...`，浏览器半直接 fetch 它，全程不碰宿主 settings 服务。
     *
     * 小 store：fetch 一次 → 缓存 snapshot → 通知订阅者；`set` 走 POST 再刷新。
     * 快照形状与宿主 scope 对齐（`status` / `value` / `user` / `writable`），卡片不用改。
     */
    function createApiScope() {
      const listeners = new Set()
      let snapshot = { status: 'idle' }
      let started = false
      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // 一个订阅者抛错不该影响别人
          }
        }
      }
      const accept = (body) => {
        const overridden = Array.isArray(body?.overridden) ? body.overridden : []
        publish({
          status: 'ready',
          value: body?.values && typeof body.values === 'object' ? body.values : {},
          user: Object.fromEntries(overridden.map((key) => [key, true])),
          writable: true,
        })
      }
      const load = async () => {
        if (typeof fetch !== 'function') {
          publish({ status: 'unavailable', reason: 'no-fetch' })
          return
        }
        publish({ status: 'loading' })
        try {
          const res = await fetch(API_PATH, { credentials: 'include', headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        } catch (error) {
          publish({ status: 'unavailable', reason: `api: ${error?.message ?? error}` })
        }
      }
      return {
        kind: 'api',
        getSnapshot: () => snapshot,
        start: () => {
          if (started) return
          started = true
          load()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: async (field, value) => {
          const res = await fetch(API_PATH, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { [field]: value } }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
        /** 撤销一个字段的本机覆盖：接口本来就支持 `unset`，这里只是把它暴露给卡片。 */
        unset: async (field) => {
          if (typeof fetch !== 'function') throw new Error('qq-bridge: 这个环境没有 fetch')
          const res = await fetch(API_PATH, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unset: [field] }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
      }
    }

    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑、谁 ready 用谁**；
     * **全都不 ready** 时再退到宿主自己的本机接口（0.2.0 的兜底，见 createApiScope）。
     */
    function bindSettings(service) {
      const unavailable = UNAVAILABLE_SNAPSHOT
      const candidates = []
      // 0.2.0 的表单 key 到底叫什么，源码里能看到的写法**全试一遍**（谁 ready 用谁）：
      // settings 命名空间 / profile entry id / 包名，以及带 include: 前缀的两种。
      for (const namespace of [NS, `include:${NS}`, 'dsh-qq-bot', 'include:dsh-qq-bot', 'dsh-qq-bridge', 'include:dsh-qq-bridge']) {
        try {
          const scope = service.bind({ namespace })
          if (scope && typeof scope === 'object') candidates.push({ namespace, scope })
        } catch (error) {
          // 某个候选绑不上不影响另一个。
          console?.debug?.(`qq-bridge: bind(${namespace}) 失败：${error?.message ?? error}`)
        }
      }
      const snapshotOf = (candidate) => {
        try {
          return candidate.scope.getSnapshot?.() ?? unavailable
        } catch {
          return unavailable
        }
      }
      const readyScope = () => candidates.find((candidate) => snapshotOf(candidate).status === 'ready')
      const anyLoading = () => candidates.some((candidate) => snapshotOf(candidate).status === 'loading')
      const api = createApiScope()
      return {
        // 供排障/测试看：这次到底绑到了哪些 key
        namespaces: candidates.map((candidate) => candidate.namespace),
        /** 这次数据从哪来（排障/测试用）：'scope' | 'api' | 'none'。 */
        via: () => {
          if (readyScope()) return 'scope'
          return api.getSnapshot().status === 'ready' ? 'api' : 'none'
        },
        /**
         * 每个候选的当前状态。直接显示在卡片上 —— 0.2.0 的 key 叫什么，
         * 与其猜，不如让它自己报（2026-10-01 真机就是靠这个收敛的）。
         */
        detail: () => {
          const scopes =
            candidates.length === 0
              ? '一个候选都没绑上（webUiSettings.bind 全部抛错）'
              : candidates.map((candidate) => `${candidate.namespace}=${snapshotOf(candidate).status}`).join('、')
          const apiSnap = api.getSnapshot()
          return `${scopes}；本机接口=${apiSnap.status}${apiSnap.reason ? `（${apiSnap.reason}）` : ''}`
        },
        getSnapshot: () => {
          const candidate = readyScope()
          if (candidate) return snapshotOf(candidate)
          // scope 全不可用 → 退到宿主本机接口；第一次问就把它跑起来。
          if (!anyLoading()) api.start()
          const apiSnap = api.getSnapshot()
          if (apiSnap.status === 'ready') return apiSnap
          if (apiSnap.status === 'loading' || apiSnap.status === 'idle') return LOADING_SNAPSHOT
          return unavailable
        },
        subscribe: (listener) => {
          const offs = []
          for (const candidate of candidates) {
            try {
              const off = candidate.scope.subscribe?.(listener)
              if (typeof off === 'function') offs.push(off)
            } catch {
              // 订阅失败不影响其它候选
            }
          }
          offs.push(api.subscribe(listener))
          if (!readyScope() && !anyLoading()) api.start()
          return () => {
            for (const off of offs) off()
          }
        },
        set: (field, value) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.set === 'function') return candidate.scope.set(field, value)
          if (api.getSnapshot().status === 'ready') return api.set(field, value)
          throw new Error('qq-bridge: 没有可写的设置源')
        },
        /**
         * 撤销一个字段的本机覆盖。
         *
         * 优先用设置域自己的 `unset`（DSH 的 SettingsScope 有这个能力）；
         * 设置域没有它时走本机接口的 `unset`（宿主半的 handleSettingsRequest 本来就支持）。
         */
        unset: (field) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.unset === 'function') return candidate.scope.unset(field)
          return api.unset(field)
        },
      }
    }

    /** 插件详情页只在这一包上显示设置。旧包名和 Cordis id 也认。 */
    function subjectIsOurs(subject) {
      if (!subject || typeof subject !== 'object') return false
      const pkgName = subject.pkg && typeof subject.pkg === 'object' ? String(subject.pkg.name ?? '') : ''
      if (pkgName === 'dsh-qq-bot' || pkgName === 'dsh-qq-bridge') return true
      const id = String(subject.id ?? '')
      if (id === NS || id === 'dsh-qq-bot' || id === 'dsh-qq-bridge') return true
      if (subject.kind === 'item' && id.includes('qq-bridge')) return true
      const pkg = String(subject.package ?? subject.packageName ?? '')
      return pkg === 'dsh-qq-bot' || pkg === 'dsh-qq-bridge'
    }

    /**
     * 不经过宿主设置服务，直接读写 `/api/qq-bridge/settings`。
     * DSH 0.2.x 上 `settingsScope` / `webUiSettings` 可能根本不存在；再等它们，卡片永远不会挂上。
     */
    function apiBoundScope() {
      const api = createApiScope()
      return {
        namespaces: [],
        via: () => (api.getSnapshot().status === 'ready' ? 'api' : 'none'),
        detail: () => {
          const apiSnap = api.getSnapshot()
          return `本机接口=${apiSnap.status}${apiSnap.reason ? `（${apiSnap.reason}）` : ''}`
        },
        getSnapshot: () => {
          api.start()
          const apiSnap = api.getSnapshot()
          if (apiSnap.status === 'ready') return apiSnap
          if (apiSnap.status === 'loading' || apiSnap.status === 'idle') return LOADING_SNAPSHOT
          return UNAVAILABLE_SNAPSHOT
        },
        subscribe: (listener) => {
          const off = api.subscribe(listener)
          api.start()
          return off
        },
        set: (field, value) => api.set(field, value),
        unset: (field) => api.unset(field),
      }
    }

    function apply(ctx) {
      // 卡片立刻挂上，不等 settingsScope / webUiSettings。
      // 这两个服务在部分 0.2.x 上不存在，ctx.inject 会一直等，回调永远不跑。
      // 设置数据：宿主设置域已经在就用它（0.1.5 的命名空间、以及还能 bind 的 webUiSettings）；
      // 否则用本插件自己的设置接口。请求带 credentials: 'include'，好把面板登录 cookie 带上。
      let registered = false
      let hostBound = false
      const listeners = new Set()
      let inner = null
      let innerOff = () => {}
      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // 一个订阅者抛错不影响别人
          }
        }
      }
      const adopt = (next) => {
        try {
          innerOff()
        } catch {
          // 旧订阅卸不掉就盖掉
        }
        inner = next
        const off = inner.subscribe?.(notify)
        innerOff = typeof off === 'function' ? off : () => {}
        notify()
      }
      const scope = {
        via: () => (typeof inner?.via === 'function' ? inner.via() : 'none'),
        detail: () => (typeof inner?.detail === 'function' ? inner.detail() : ''),
        getSnapshot: () => inner.getSnapshot(),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: (field, value) => inner.set(field, value),
        unset: (field) => inner.unset(field),
      }
      const mount = (scoped) => {
        if (registered) return
        if (!scoped?.slots || typeof scoped.slots.inject !== 'function') return
        registered = true
        const card = () =>
          h(Card, { scope, sessionsOf: () => ctx.get('sessions'), workspacesOf: () => ctx.get('workspaces') })
        // slots.inject 只在那个 slot 存在时才跑回调，多注册一个是安全的。
        const registerCard = (slot, options, render) => {
          try {
            scoped.slots.inject(slot, () => scoped.slots.register({ ...options, name: slot }, render || card))
          } catch (error) {
            console?.debug?.(`qq-bridge: slot ${slot} unavailable (${error?.message ?? error})`)
          }
        }
        registerCard('settings.plugins.tab', { id: NS, order: 100, label: () => 'QQ 桥接' })
        registerCard('settings.plugin.item', { key: NS })
        registerCard('plugins.tab', { id: NS, order: 100, label: () => 'QQ 桥接' })
        registerCard(
          'plugins.detail.section',
          { id: 'qq-bridge-settings', order: 50, label: () => 'QQ 桥接设置' },
          (props) => {
            const subject = props && props.subject
            if (subject && !subjectIsOurs(subject)) return null
            return card()
          },
        )
      }
      const preferHost = (service) => {
        if (hostBound) return
        if (!service || typeof service.bind !== 'function') return
        hostBound = true
        adopt(bindSettings(service))
      }
      const tryInject = (name, pick) => {
        if (typeof ctx.inject !== 'function') return
        try {
          ctx.inject([name], (scoped) => preferHost(pick(scoped)))
        } catch {
          // 没有这扇门：下面会改走设置接口。
        }
      }
      tryInject('webUiSettings', (scoped) => scoped.webUiSettings ?? scoped.get?.('settingsScope'))
      tryInject('settingsScope', (scoped) => scoped.settingsScope ?? scoped.get?.('webUiSettings'))
      if (!hostBound) adopt(apiBoundScope())
      mount(ctx)
    }

    exports.apply = apply
    exports.inject = inject
    // 导出 name：Cordis 用它做插件标识，Slots inspect 里的 registrant 会显示成它
    // （不导的话那边显示的是产物里的 fallback 短名，排障时认不出是谁注册的卡片）。
    exports.name = 'dsh-qq-bot'
    // 纯函数给离线测试用（test-smoke.mjs 会在假 ctx 里真跑这个 bundle）。
    // Cordis 只认 apply / inject / name / Config，多余的导出它不管。
    exports.__test = { sessionOptions, draftFrom, parse, fields: FIELDS, bindSettings }
    return module.exports
  },
})
