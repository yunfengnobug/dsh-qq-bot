// 检查 GitHub Release 上有没有比当前包更新的正式版。
//
// 只比较版本、拼白话说明。不下载、不安装、不改配置。
// 网络细节留在 checkPluginUpdate；界面和测试都吃这里的返回值。

export const UPDATE_REPO = 'yunfengnobug/dsh-qq-bot'

const RELEASES_PER_PAGE = 30

/** @param {string} [repo] */
export function releasesApiUrl(repo = UPDATE_REPO) {
  return `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}`
}

/**
 * 解析 `v1.2.3` / `1.2.3-rc.1`。对不上返回 null。
 * @param {unknown} input
 */
export function parseSemver(input) {
  const text = String(input ?? '').trim()
  const match = text.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.').filter((part) => part !== '') : [],
    raw: match[4] ? `${match[1]}.${match[2]}.${match[3]}-${match[4]}` : `${match[1]}.${match[2]}.${match[3]}`,
  }
}

function compareIdentifiers(left, right) {
  const leftNum = /^[0-9]+$/.test(left)
  const rightNum = /^[0-9]+$/.test(right)
  if (leftNum && rightNum) {
    const diff = Number(left) - Number(right)
    if (diff !== 0) return diff > 0 ? 1 : -1
    return 0
  }
  if (leftNum) return -1
  if (rightNum) return 1
  if (left === right) return 0
  return left > right ? 1 : -1
}

function comparePre(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const count = Math.max(left.length, right.length)
  for (let i = 0; i < count; i++) {
    if (left[i] === undefined) return -1
    if (right[i] === undefined) return 1
    const diff = compareIdentifiers(left[i], right[i])
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * `a > b` 返回 1，相等返回 0，`a < b` 返回 -1。有一边解析不了返回 null。
 * 正式版高于同号的预发布版。
 * @param {unknown} a
 * @param {unknown} b
 */
export function compareSemver(a, b) {
  const left = typeof a === 'object' && a ? a : parseSemver(a)
  const right = typeof b === 'object' && b ? b : parseSemver(b)
  if (!left?.raw || !right?.raw) return null
  if (left.major !== right.major) return left.major > right.major ? 1 : -1
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1
  return comparePre(left.pre ?? [], right.pre ?? [])
}

/** 安装命令里的 spec。版本号不带 v 时补上。 */
export function installSpec(version, repo = UPDATE_REPO) {
  const parsed = parseSemver(version)
  const raw = parsed?.raw ?? String(version ?? '').trim().replace(/^v/i, '')
  return `github:${repo}#v${raw}`
}

export function installCommand(version, repo = UPDATE_REPO) {
  return `dsh plugin --profile web add ${installSpec(version, repo)}`
}

export function releasePage(tag, repo = UPDATE_REPO) {
  const parsed = parseSemver(tag)
  const name = parsed ? `v${parsed.raw}` : String(tag ?? '').trim()
  return `https://github.com/${repo}/releases/tag/${name}`
}

/**
 * Release 正文收成一两句白话。去掉围栏代码和链接，避免把整篇更新日志贴进卡片。
 * @param {unknown} body
 * @param {number} [maxChars]
 */
export function summarizeReleaseNotes(body, maxChars = 240) {
  const lines = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/[`*_>]/g, '').trim())
    .filter((line) => line !== '' && !/^[-—]+$/.test(line))
  const joined = lines.slice(0, 4).join(' ')
  if (joined.length <= maxChars) return joined
  return `${joined.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function safeReleaseUrl(rel, tag, repo) {
  const raw = typeof rel?.html_url === 'string' ? rel.html_url : ''
  const prefix = `https://github.com/${repo}/`
  if (raw.startsWith(prefix)) return raw
  return releasePage(tag, repo)
}

/**
 * @param {{ current: unknown, releases: unknown, repo?: string }} input
 */
export function assessUpdate({ current, releases, repo = UPDATE_REPO }) {
  const parsedCurrent = parseSemver(current)
  if (!parsedCurrent) {
    return {
      ok: false,
      kind: 'bad-current',
      current: String(current ?? ''),
      updateAvailable: false,
      message: '当前版本号读不出来，没法对比。',
    }
  }
  const stable = []
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (!rel || typeof rel !== 'object') continue
    if (rel.draft === true || rel.prerelease === true) continue
    const tag = String(rel.tag_name ?? '')
    const parsed = parseSemver(tag)
    if (!parsed) continue
    stable.push({ rel, parsed, tag })
  }
  if (stable.length === 0) {
    return {
      ok: true,
      kind: 'no-release',
      current: parsedCurrent.raw,
      updateAvailable: false,
      message: 'GitHub 上还没有可用的正式版，没法对比新版本。',
    }
  }
  stable.sort((left, right) => compareSemver(right.parsed, left.parsed) ?? 0)
  const latest = stable[0]
  const summary = summarizeReleaseNotes(latest.rel.body)
  const spec = installSpec(latest.parsed.raw, repo)
  const command = installCommand(latest.parsed.raw, repo)
  const url = safeReleaseUrl(latest.rel, latest.tag, repo)
  const compared = compareSemver(latest.parsed, parsedCurrent)
  const base = {
    ok: true,
    current: parsedCurrent.raw,
    latest: latest.parsed.raw,
    tag: `v${latest.parsed.raw}`,
    summary,
    install: spec,
    command,
    url,
  }
  if (compared > 0) {
    const lines = [`有新版本 ${latest.parsed.raw}（你现在是 ${parsedCurrent.raw}）。`]
    if (summary) lines.push(`说明：${summary}`)
    lines.push(`升级命令：${command}`)
    lines.push('装完请重启 dsh-web。')
    lines.push(`发布页：${url}`)
    return { ...base, kind: 'update', updateAvailable: true, message: lines.join('\n') }
  }
  if (compared < 0) {
    return {
      ...base,
      kind: 'ahead',
      updateAvailable: false,
      message: `你现在的 ${parsedCurrent.raw} 比 GitHub 上最新正式版 ${latest.parsed.raw} 还新，不用按 Release 往回装。`,
    }
  }
  return {
    ...base,
    kind: 'current',
    updateAvailable: false,
    message: `已经是最新正式版 ${parsedCurrent.raw}，不用更新。`,
  }
}

/**
 * 把 GitHub / 网络失败收成一句白话。不要把英文堆栈或限流正文里的地址回给界面。
 * @param {unknown} status
 * @param {unknown} snippet
 */
export function failureMessage(status, snippet) {
  const code = Number(status)
  const text = String(snippet ?? '')
  if (code === 403 || code === 429 || /rate limit/i.test(text)) {
    return 'GitHub 限流了，等一会儿再点「检查更新」。'
  }
  if (code === 404) return '没有查到这个仓库的 Release。'
  return '连不上 GitHub，这次没有检查到更新。稍后再试。'
}

async function readSnippet(response) {
  try {
    if (typeof response?.text === 'function') return String(await response.text()).slice(0, 500)
  } catch {
    // 读失败也按连不上处理，不把读取异常的英文抛出去。
  }
  return ''
}

/**
 * @param {typeof fetch | undefined} fetchImpl
 * @param {{ repo?: string, timeoutMs?: number }} [options]
 */
export async function queryGithubReleases(fetchImpl, options = {}) {
  // 显式传入 null 表示「不要上网」。只有没传时才用全局 fetch。
  const fetchFn = fetchImpl === undefined ? globalThis.fetch : fetchImpl
  if (typeof fetchFn !== 'function') {
    return { ok: false, error: failureMessage(0, '') }
  }
  const repo = options.repo || UPDATE_REPO
  const timeoutMs = options.timeoutMs ?? 15000
  let response
  try {
    response = await fetchFn(releasesApiUrl(repo), {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-qq-bot',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { ok: false, error: failureMessage(0, '') }
  }
  if (!response || response.ok !== true) {
    const snippet = await readSnippet(response)
    return { ok: false, error: failureMessage(response?.status, snippet), status: response?.status }
  }
  let data
  try {
    data = await response.json()
  } catch {
    return { ok: false, error: 'GitHub 返回的内容读不懂，这次没有检查到更新。' }
  }
  if (!Array.isArray(data)) {
    const message = data && typeof data === 'object' ? data.message : ''
    return { ok: false, error: failureMessage(response.status, message) }
  }
  return { ok: true, releases: data }
}

/**
 * @param {{ current: unknown, fetchImpl?: typeof fetch, repo?: string }} [input]
 */
export async function checkPluginUpdate(input = {}) {
  const current = input.current
  const queried = await queryGithubReleases(input.fetchImpl, { repo: input.repo })
  if (!queried.ok) {
    return { ok: false, current: String(current ?? ''), error: queried.error, message: queried.error }
  }
  const assessed = assessUpdate({ current, releases: queried.releases, repo: input.repo })
  if (assessed.ok === false) {
    return { ok: false, current: assessed.current, error: assessed.message, message: assessed.message }
  }
  return assessed
}
