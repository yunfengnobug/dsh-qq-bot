// 检查有没有新版本，以及在用户明确要求时把新版本装进 DSH 的 web profile。
//
// checkPluginUpdate 只比较版本、拼白话说明，不下载、不安装、不改配置。
// 启动时检查必须走这一条，不能调用 applyPluginUpdate。
// 有新版本时，applyPluginUpdate 先执行 `dsh plugin --profile web add @fengye_nobug/dsh-qq-bot@x.y.z`，
// 走这台机器 npm / pnpm 已经配好的 registry（可以是官方，也可以是用户自己的镜像）。
// 插件不写死第三方镜像。包还没发到 npm，或 registry 里没有这个版本时，才改从 GitHub 下载：
// 先要 github.com 上的官方源码包，连不上再试同一标签的 codeload。只跟随仍指向同一标签的
// github.com、api.github.com 或 codeload.github.com。不用 git 协议。

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

export const UPDATE_REPO = 'yunfengnobug/dsh-qq-bot'
/** npm 上的包名。无作用域的 dsh-qq-bot 发不出去（和已有的 dsh-qqbot 太像）。本地压缩包文件名仍不带作用域，避免路径里出现斜杠。 */
export const PACKAGE_NAME = '@fengye_nobug/dsh-qq-bot'
/** GitHub 上 v0.2.3 及更早标签的 package.json 仍是这个无作用域名。下载校验认它，不认别的作用域。 */
const LEGACY_UNSCOPED_NAME = 'dsh-qq-bot'
/** 没读到用户自己的 registry 时用官方源。不把第三方镜像写进默认值。 */
export const NPM_REGISTRY = 'https://registry.npmjs.org/'
/** 下载下来的压缩包上限。本仓库是源码包，远小于这个数。 */
const MAX_TARBALL_BYTES = 20 * 1024 * 1024
/** 解压后的上限，挡住异常膨胀的包。 */
const MAX_UNPACKED_BYTES = 40 * 1024 * 1024
const MAX_TAR_ENTRIES = 4000
const INSTALL_TIMEOUT_MS = 180000
const DOWNLOAD_TIMEOUT_MS = 60000
/** 先把 HTTP 响应发出去，再重启，避免面板还没回答就被掐掉。 */
const RESTART_DELAY_MS = 2500

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

/** 只接受 https、没有账号口令、没有路径的 registry。别的都丢掉。 */
export function normalizeRegistry(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  let url
  try {
    url = new URL(text)
  } catch {
    return ''
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return ''
  if (url.pathname !== '/' && url.pathname !== '') return ''
  if (url.search !== '' || url.hash !== '') return ''
  return `${url.origin}/`
}

function isOurNpmName(name) {
  return name === PACKAGE_NAME
}

/** npm 上的安装说明。只拼这个作用域包的正式版，别的名字和预发布都不出命令。 */
export function npmInstallSpec(version, name = PACKAGE_NAME) {
  const parsed = parseSemver(version)
  if (!parsed || parsed.pre.length > 0) return ''
  if (!isOurNpmName(name)) return ''
  return `${PACKAGE_NAME}@${parsed.raw}`
}

export function npmInstallCommand(version, name = PACKAGE_NAME) {
  const spec = npmInstallSpec(version, name)
  return spec === '' ? '' : `dsh plugin --profile web add ${spec}`
}

/** registry 路径把作用域里的斜杠编码成 %2F，@ 保留。 */
export function npmPackageUrl(registry = NPM_REGISTRY, name = PACKAGE_NAME) {
  const base = normalizeRegistry(registry)
  if (base === '' || !isOurNpmName(name)) return ''
  return `${base}${name.replace('/', '%2F')}`
}

function registryPackagePath(pathname) {
  try {
    return decodeURIComponent(String(pathname ?? '')).replace(/\/+$/, '')
  } catch {
    return ''
  }
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

function isSafeRepo(repo) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo ?? ''))
}

/** 正式版：跳过草稿、预发布和读不懂的标签。版本号从高到低。 */
export function stableReleases(releases) {
  const stable = []
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (!rel || typeof rel !== 'object') continue
    if (rel.draft === true || rel.prerelease === true) continue
    const tag = String(rel.tag_name ?? '')
    const parsed = parseSemver(tag)
    if (!parsed || parsed.pre.length > 0) continue
    stable.push({ rel, parsed, tag })
  }
  stable.sort((left, right) => compareSemver(right.parsed, left.parsed) ?? 0)
  return stable
}

/**
 * @param {{ current: unknown, releases: unknown, repo?: string }} input
 */
export function assessUpdate({ current, releases, repo = UPDATE_REPO, channel = 'github' }) {
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
  const stable = stableReleases(releases)
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
  const useNpm = channel === 'npm'
  const spec = useNpm ? npmInstallSpec(latest.parsed.raw) : installSpec(latest.parsed.raw, repo)
  const command = useNpm ? npmInstallCommand(latest.parsed.raw) : installCommand(latest.parsed.raw, repo)
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
    if (useNpm) lines.push(`也可以在设置卡片里点「更新到 v${latest.parsed.raw}」，面板会从 npm 装上并重启。`)
    else lines.push(`也可以在设置卡片里点「更新到 v${latest.parsed.raw}」，面板会自己装并重启。`)
    if (!useNpm) lines.push(`发布页：${url}`)
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

function versionsToReleases(versions) {
  return versions.map((version) => {
    const parsed = parseSemver(version)
    const tag = parsed ? `v${parsed.raw}` : String(version)
    return { tag_name: tag, draft: false, prerelease: false, body: '' }
  })
}

function stableVersionList(data) {
  const versions = data && typeof data === 'object' && !Array.isArray(data) ? data.versions : null
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return null
  const stable = []
  for (const key of Object.keys(versions)) {
    const parsed = parseSemver(key)
    if (!parsed || parsed.pre.length > 0) continue
    stable.push(parsed.raw)
  }
  return stable
}

/**
 * 读用户已经配好的 npm registry。只认 https 且没有路径的地址，读不到就用官方源。
 * @param {typeof spawn} [spawnImpl]
 * @param {string} [platform]
 */
export async function readNpmRegistry(spawnImpl = spawn, platform = process.platform) {
  const fromEnv = normalizeRegistry(process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || '')
  if (fromEnv !== '') return fromEnv
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm'
  const ran = await runChild(spawnImpl, npm, ['config', 'get', 'registry'], { timeoutMs: 5000, capture: true })
  const configured = normalizeRegistry(ran.stdout)
  return configured === '' ? NPM_REGISTRY : configured
}

/**
 * 向 registry 要这个包的正式版列表。404 表示还没发布。跳转只留在同一个源上。
 * @param {{ registry?: string, name?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [input]
 */
export async function queryNpmVersions(input = {}) {
  const registry = normalizeRegistry(input.registry || NPM_REGISTRY) || NPM_REGISTRY
  const name = input.name || PACKAGE_NAME
  const url = npmPackageUrl(registry, name)
  if (url === '') return { ok: false, code: 'unpublished' }
  const fetchFn = input.fetchImpl === undefined ? globalThis.fetch : input.fetchImpl
  if (typeof fetchFn !== 'function') return { ok: false, code: 'network' }
  const timeoutMs = input.timeoutMs ?? 15000
  let current = url
  const origin = new URL(url).origin
  for (let hop = 0; hop < 3; hop++) {
    let response
    try {
      response = await fetchFn(current, {
        redirect: 'manual',
        headers: { accept: 'application/json', 'user-agent': 'dsh-qq-bot' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return { ok: false, code: 'network' }
    }
    const status = Number(response?.status)
    if (status >= 300 && status < 400) {
      const location = headerValue(response, 'location')
      let next
      try {
        next = new URL(location, current)
      } catch {
        return { ok: false, code: 'network' }
      }
      if (next.origin !== origin || registryPackagePath(next.pathname) !== `/${name}` || next.username !== '' || next.password !== '') {
        return { ok: false, code: 'network' }
      }
      current = next.toString()
      continue
    }
    if (status === 404) return { ok: false, code: 'unpublished' }
    if (!response || response.ok !== true) return { ok: false, code: 'network' }
    let data
    try {
      data = await response.json()
    } catch {
      return { ok: false, code: 'network' }
    }
    const versions = stableVersionList(data)
    if (!versions) return { ok: false, code: 'unpublished' }
    if (versions.length === 0) return { ok: false, code: 'unpublished' }
    return { ok: true, versions, channel: 'npm' }
  }
  return { ok: false, code: 'network' }
}

function noteGithubFallback(assessed) {
  if (!assessed || assessed.updateAvailable !== true) return assessed
  const message = String(assessed.message ?? '')
  if (message.includes('还没发到 npm') || !message.includes('也可以在设置卡片里点')) return assessed
  return {
    ...assessed,
    message: message.replace(
      '也可以在设置卡片里点',
      '这一版还没发到 npm，一键更新会改从 GitHub 下载。\n也可以在设置卡片里点',
    ),
  }
}

function lookupFailure(npmCode, githubError, applying) {
  const raw = String(githubError ?? '')
  if (npmCode === 'network' && /连不上 GitHub/.test(raw)) {
    return applying
      ? '连不上 npm 的源，也连不上 GitHub，这次没有把新版本下下来。稍后再试。'
      : '连不上 npm 的源，也连不上 GitHub，这次没有检查到更新。稍后再试。'
  }
  return applying ? applyGithubError(raw) : raw
}

/**
 * 先看 npm。有比当前新的正式版就用它，不再问 GitHub。
 * npm 上没有更新时，再用很短的时间看 GitHub 有没有还没发出去的版本；连不上就沿用 npm 的结论。
 * 包还没发布，或 npm 本身连不上时，改问 GitHub Releases。
 * @param {{ current: unknown, version?: unknown, force?: boolean, repo?: string, fetchImpl?: typeof fetch, registry?: string, spawnImpl?: typeof spawn, platform?: string, timeoutMs?: number, applying?: boolean }} input
 */
async function findUpdate(input) {
  const repo = input.repo || UPDATE_REPO
  const registry = input.registry || (input.fetchImpl !== undefined ? NPM_REGISTRY : await readNpmRegistry(input.spawnImpl, input.platform))
  const npm = await queryNpmVersions({ registry, fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs, name: PACKAGE_NAME })
  const wanted = String(input.version ?? '').trim()
  if (npm.ok) {
    const releases = versionsToReleases(npm.versions)
    const assessed = assessUpdate({ current: input.current, releases, repo, channel: 'npm' })
    if (assessed.ok === false) return { ok: false, error: assessed.message }
    const onNpm = wanted === '' || releases.some((rel) => {
      const parsed = parseSemver(rel.tag_name)
      const asked = parseSemver(wanted)
      return parsed && asked && parsed.raw === asked.raw
    })
    if (wanted === '' && assessed.updateAvailable === true) return { ok: true, channel: 'npm', releases, assessed }
    if (wanted !== '' && onNpm) return { ok: true, channel: 'npm', releases, assessed }
    const peek = wanted === ''
    const gh = await queryGithubReleases(input.fetchImpl, { repo, timeoutMs: peek ? (input.timeoutMs ?? 4000) : input.timeoutMs })
    if (!gh.ok) {
      if (wanted !== '') return { ok: false, error: '这次检查到的正式版里没有这个版本，没有安装。' }
      return { ok: true, channel: 'npm', releases, assessed }
    }
    const ghAssessed = noteGithubFallback(assessUpdate({ current: input.current, releases: gh.releases, repo, channel: 'github' }))
    if (ghAssessed.ok === false) return { ok: false, error: ghAssessed.message }
    const npmLatest = assessed.latest || '0.0.0'
    const githubNewer = ghAssessed.updateAvailable === true && (compareSemver(ghAssessed.latest, npmLatest) ?? 0) > 0
    const githubHasWanted = wanted !== '' && stableReleases(gh.releases).some((item) => {
      const asked = parseSemver(wanted)
      return asked && item.parsed.raw === asked.raw
    })
    if ((wanted === '' && githubNewer) || githubHasWanted) {
      return { ok: true, channel: 'github', releases: gh.releases, assessed: ghAssessed }
    }
    if (wanted !== '') return { ok: false, error: '这次检查到的正式版里没有这个版本，没有安装。' }
    return { ok: true, channel: 'npm', releases, assessed }
  }
  const gh = await queryGithubReleases(input.fetchImpl, { repo, timeoutMs: input.timeoutMs })
  if (!gh.ok) return { ok: false, error: lookupFailure(npm.code, gh.error, input.applying === true) }
  const assessed = noteGithubFallback(assessUpdate({ current: input.current, releases: gh.releases, repo, channel: 'github' }))
  if (assessed.ok === false) return { ok: false, error: assessed.message }
  return { ok: true, channel: 'github', releases: gh.releases, assessed }
}

/**
 * @param {{ current: unknown, fetchImpl?: typeof fetch, repo?: string, registry?: string, spawnImpl?: typeof spawn, platform?: string, timeoutMs?: number }} [input]
 */
export async function checkPluginUpdate(input = {}) {
  const found = await findUpdate({ ...input, applying: false })
  if (!found.ok) {
    const current = String(input.current ?? '')
    return { ok: false, current, error: found.error, message: found.error }
  }
  return found.assessed
}

function stableTag(version, repo = UPDATE_REPO) {
  const parsed = parseSemver(version)
  if (!parsed || parsed.pre.length > 0 || !isSafeRepo(repo)) return ''
  if (!/^[0-9.]+$/.test(parsed.raw)) return ''
  return `v${parsed.raw}`
}

/**
 * Release 页面上的官方源码包。先请求这个地址，不采用正文里的链接，也不用第三方镜像。
 * @param {unknown} version
 * @param {string} [repo]
 */
export function githubArchiveUrl(version, repo = UPDATE_REPO) {
  const tag = stableTag(version, repo)
  if (tag === '') return ''
  return `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`
}

/**
 * 同一标签在 codeload 上的地址。只在 github.com 连不上时作备用，仍然是 GitHub。
 * @param {unknown} version
 * @param {string} [repo]
 */
export function codeloadTarballUrl(version, repo = UPDATE_REPO) {
  const tag = stableTag(version, repo)
  if (tag === '') return ''
  return `https://codeload.github.com/${repo}/tar.gz/refs/tags/${tag}`
}

/**
 * 决定这次允许安装哪个标签。
 * 没给版本就用本次检查里最新的正式版，而且必须比当前新。
 * 给了版本就必须出现在本次正式版列表里，并且更新；force 为真时才允许重装同一个版本。
 * 更旧的标签即使 force 也不装。
 * @param {{ current: unknown, releases: unknown, version?: unknown, force?: boolean, repo?: string, channel?: 'npm' | 'github' }} input
 */
export function chooseApplyTarget(input) {
  const repo = input.repo || UPDATE_REPO
  const assessed = assessUpdate({ current: input.current, releases: input.releases, repo })
  if (assessed.ok === false) return { ok: false, error: assessed.message }
  const stable = stableReleases(input.releases)
  const requested = String(input.version ?? '').trim()
  /** @type {ReturnType<typeof parseSemver>} */
  let parsed
  if (requested === '') {
    if (assessed.updateAvailable !== true) return { ok: false, error: assessed.message }
    parsed = parseSemver(assessed.latest)
  } else {
    parsed = parseSemver(requested)
    if (!parsed || parsed.pre.length > 0) return { ok: false, error: '版本号格式不对，没有安装。' }
  }
  if (!parsed) return { ok: false, error: '版本号格式不对，没有安装。' }
  const match = stable.find((item) => item.parsed.raw === parsed.raw)
  if (!match) return { ok: false, error: '这次检查到的正式版里没有这个版本，没有安装。' }
  const compared = compareSemver(parsed, assessed.current)
  if (compared == null) return { ok: false, error: '版本号对不上，没有安装。' }
  if (compared < 0) return { ok: false, error: '不会安装比当前更旧的版本。' }
  if (compared === 0 && input.force !== true) return { ok: false, error: '已经是这个版本，没有重装。' }
  const channel = input.channel === 'npm' ? 'npm' : 'github'
  const tarballUrl = githubArchiveUrl(parsed.raw, repo)
  const fallbackUrl = codeloadTarballUrl(parsed.raw, repo)
  const install = channel === 'npm' ? npmInstallSpec(parsed.raw) : installSpec(parsed.raw, repo)
  const command = channel === 'npm' ? npmInstallCommand(parsed.raw) : installCommand(parsed.raw, repo)
  if (tarballUrl === '' || fallbackUrl === '' || install === '' || command === '') {
    return { ok: false, error: '这个版本的安装说明拼不出来，没有安装。' }
  }
  return {
    ok: true,
    version: parsed.raw,
    tag: `v${parsed.raw}`,
    channel,
    install,
    command,
    tarballUrl,
    fallbackUrl,
    summary: summarizeReleaseNotes(match.rel.body),
    url: safeReleaseUrl(match.rel, match.tag, repo),
    current: assessed.current,
  }
}

function applyGithubError(text) {
  const raw = String(text ?? '')
  if (/限流/.test(raw)) return 'GitHub 限流了，这次没有更新。等一会儿再试。'
  if (/没有查到/.test(raw)) return '没有查到这个仓库的 Release，没有安装。'
  if (/读不懂/.test(raw)) return 'GitHub 返回的内容读不懂，没有安装。'
  return '连不上 GitHub，这次没有把新版本下下来。稍后再试。'
}

function downloadError(code) {
  if (code === 'rate') return 'GitHub 限流了，这次没有把新版本下下来。等一会儿再试。'
  if (code === 'missing') return '没有下到这个版本的安装包。'
  if (code === 'huge') return '安装包太大，没有安装。'
  return '连不上 GitHub，这次没有把新版本下下来。稍后再试。'
}

function installError(code, command) {
  const hint = command ? `也可以自己执行：${command}` : '也可以按卡片上的安装命令自己装。'
  if (code === 'ENOENT') return `没找到 dsh 命令，没有安装。${hint}`
  if (code === 'timeout') return `安装超时，没有确认装上。${hint}`
  if (code === 'wrong-name') return '下到的安装包不是这个插件，没有安装。'
  if (code === 'wrong-version') return '下到的版本和发布标签对不上，没有安装。'
  if (code === 'bad-package') return '下到的安装包读不懂，没有安装。'
  return `安装没有成功。${hint}`
}

function restartError() {
  return '新版本已经装上，但面板没有重启。请自己重启 dsh-web，装好的才会生效。重启后请刷新页面，登录口令可能会变。'
}

function headerValue(response, name) {
  const headers = response?.headers
  if (!headers) return ''
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '')
  const key = String(name).toLowerCase()
  if (typeof headers === 'object') {
    for (const [candidate, value] of Object.entries(headers)) {
      if (String(candidate).toLowerCase() === key) return String(value ?? '')
    }
  }
  return ''
}

/** 只认 GitHub 自己的三个主机，并且路径必须还是这个仓库的这个标签。 */
function officialDownloadKind(url, repo, tag) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return ''
  const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, '')
  if (parsed.hostname === 'github.com') {
    if (path === `/${repo}/archive/refs/tags/${tag}.tar.gz` || path === `/${repo}/archive/${tag}.tar.gz`) return 'github'
    return ''
  }
  if (parsed.hostname === 'api.github.com') {
    if (path === `/repos/${repo}/tarball/${tag}` || path === `/repos/${repo}/tarball/refs/tags/${tag}`) return 'api'
    return ''
  }
  if (parsed.hostname === 'codeload.github.com') {
    if (path === `/${repo}/tar.gz/refs/tags/${tag}` || path === `/${repo}/legacy.tar.gz/refs/tags/${tag}`) return 'codeload'
    return ''
  }
  return ''
}

function assertReleaseDownloadUrl(url, repo, tag) {
  if (officialDownloadKind(url, repo, tag) === '') {
    const error = new Error('bad-host')
    error.code = 'network'
    throw error
  }
}

/**
 * 下载标签压缩包。先请求官方地址；只有连不上时才改试 codeload。
 * 跳转只跟到同一标签的 GitHub 地址，第三方镜像直接丢掉。
 * @param {{ url: string, fallbackUrl?: string, repo?: string, tag: string, fetchImpl?: typeof fetch, proxy?: string, timeoutMs?: number, maxBytes?: number, spawnImpl?: typeof spawn, platform?: string }} input
 */
export async function downloadReleaseTarball(input) {
  try {
    return await downloadReleaseOnce(input)
  } catch (error) {
    const fallback = String(input.fallbackUrl ?? '')
    if (error?.code !== 'network' || fallback === '' || fallback === input.url) throw error
    return await downloadReleaseOnce({ ...input, url: fallback })
  }
}

async function downloadReleaseOnce(input) {
  const repo = input.repo || UPDATE_REPO
  const proxy = String(input.proxy ?? '').trim()
  if (proxy !== '') return downloadReleaseViaCurl(input, proxy)
  const fetchFn = input.fetchImpl === undefined ? globalThis.fetch : input.fetchImpl
  if (typeof fetchFn !== 'function') {
    const error = new Error('no-fetch')
    error.code = 'network'
    throw error
  }
  const maxBytes = input.maxBytes ?? MAX_TARBALL_BYTES
  const timeoutMs = input.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  let current = input.url
  for (let hop = 0; hop < 4; hop++) {
    assertReleaseDownloadUrl(current, repo, input.tag)
    let response
    try {
      response = await fetchFn(current, {
        redirect: 'manual',
        headers: { accept: 'application/octet-stream', 'user-agent': 'dsh-qq-bot' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      const error = new Error('fetch')
      error.code = 'network'
      throw error
    }
    const status = Number(response?.status)
    if (status >= 300 && status < 400) {
      const location = headerValue(response, 'location')
      if (location === '') {
        const error = new Error('redirect')
        error.code = 'network'
        throw error
      }
      try {
        current = new URL(location, current).toString()
      } catch {
        const error = new Error('redirect')
        error.code = 'network'
        throw error
      }
      continue
    }
    if (status === 403 || status === 429) {
      const error = new Error('rate')
      error.code = 'rate'
      throw error
    }
    if (status === 404) {
      const error = new Error('missing')
      error.code = 'missing'
      throw error
    }
    if (!response || response.ok !== true) {
      const error = new Error('status')
      error.code = 'network'
      throw error
    }
    const declared = Number(headerValue(response, 'content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      const error = new Error('huge')
      error.code = 'huge'
      throw error
    }
    let bytes
    try {
      bytes = Buffer.from(await response.arrayBuffer())
    } catch {
      const error = new Error('body')
      error.code = 'network'
      throw error
    }
    if (bytes.length > maxBytes) {
      const error = new Error('huge')
      error.code = 'huge'
      throw error
    }
    return bytes
  }
  const error = new Error('redirect')
  error.code = 'network'
  throw error
}

function splitCurlStatus(buffer) {
  const marker = Buffer.from('\n__HTTP__')
  const at = buffer.lastIndexOf(marker)
  if (at < 0) return null
  const meta = buffer.slice(at + marker.length).toString('utf8').trim()
  const line = meta.split('\n')
  const status = Number(line[0])
  const redirectUrl = (line[1] ?? '').trim()
  if (!Number.isFinite(status)) return null
  return { status, redirectUrl, body: buffer.slice(0, at) }
}

async function curlOnce(spawnImpl, curl, args, maxBytes) {
  const chunks = []
  let size = 0
  let settled = false
  return await new Promise((resolve) => {
    let child
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      child = spawnImpl(curl, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish({ ok: false, code: 'network' })
      return
    }
    if (!child || typeof child.on !== 'function') {
      finish({ ok: false, code: 'network' })
      return
    }
    child.stdout?.on?.('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes + 1024) {
        try { child.kill('SIGTERM') } catch { /* 超限就停 */ }
        finish({ ok: false, code: 'huge' })
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    child.stderr?.on?.('data', () => {})
    child.on('error', () => finish({ ok: false, code: 'network' }))
    child.on('close', (code) => {
      if (code !== 0) finish({ ok: false, code: 'network' })
      else finish({ ok: true, body: Buffer.concat(chunks) })
    })
  })
}

async function downloadReleaseViaCurl(input, proxy) {
  const spawnImpl = input.spawnImpl || spawn
  const platform = input.platform || process.platform
  const curl = platform === 'win32' ? 'curl.exe' : 'curl'
  const timeoutSec = Math.max(1, Math.ceil((input.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) / 1000))
  const maxBytes = input.maxBytes ?? MAX_TARBALL_BYTES
  const repo = input.repo || UPDATE_REPO
  let current = input.url
  for (let hop = 0; hop < 4; hop++) {
    assertReleaseDownloadUrl(current, repo, input.tag)
    const ran = await curlOnce(spawnImpl, curl, [
      '-sS',
      '--max-time',
      String(timeoutSec),
      '--retry',
      '0',
      '-A',
      'dsh-qq-bot',
      '-x',
      proxy,
      '-w',
      '\n__HTTP__%{http_code}\n%{redirect_url}',
      current,
    ], maxBytes)
    if (!ran.ok) {
      const error = new Error(String(ran.code || 'network'))
      error.code = ran.code === 'huge' ? 'huge' : 'network'
      throw error
    }
    const parsed = splitCurlStatus(ran.body)
    if (!parsed) {
      const error = new Error('curl-status')
      error.code = 'network'
      throw error
    }
    if (parsed.status >= 300 && parsed.status < 400) {
      if (parsed.redirectUrl === '') {
        const error = new Error('redirect')
        error.code = 'network'
        throw error
      }
      try {
        current = new URL(parsed.redirectUrl, current).toString()
      } catch {
        const error = new Error('redirect')
        error.code = 'network'
        throw error
      }
      continue
    }
    if (parsed.status === 403 || parsed.status === 429) {
      const error = new Error('rate')
      error.code = 'rate'
      throw error
    }
    if (parsed.status === 404) {
      const error = new Error('missing')
      error.code = 'missing'
      throw error
    }
    if (parsed.status !== 200) {
      const error = new Error('status')
      error.code = 'network'
      throw error
    }
    if (parsed.body.length > maxBytes) {
      const error = new Error('huge')
      error.code = 'huge'
      throw error
    }
    return parsed.body
  }
  const error = new Error('redirect')
  error.code = 'network'
  throw error
}

function parseOctal(field) {
  const text = Buffer.from(field).toString('utf8').replace(/\0.*$/, '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) return null
  return Number.parseInt(text, 8)
}

function readTarEntries(raw) {
  const entries = []
  let offset = 0
  let longName = ''
  let unpacked = 0
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    if (entries.length > MAX_TAR_ENTRIES) {
      const error = new Error('too-many')
      error.code = 'bad-package'
      throw error
    }
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
    const stored = parseOctal(header.subarray(148, 156))
    const size = parseOctal(header.subarray(124, 136))
    if (stored == null || size == null || stored !== sum || size < 0) {
      const error = new Error('checksum')
      error.code = 'bad-package'
      throw error
    }
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    if (longName !== '') {
      name = longName
      longName = ''
    } else if (prefix !== '') {
      name = `${prefix}/${name}`
    }
    const type = String.fromCharCode(header[156] || 0)
    offset += 512
    unpacked += size
    if (unpacked > MAX_UNPACKED_BYTES) {
      const error = new Error('unpacked')
      error.code = 'bad-package'
      throw error
    }
    const data = raw.subarray(offset, offset + size)
    if (data.length !== size) {
      const error = new Error('truncated')
      error.code = 'bad-package'
      throw error
    }
    offset += Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '')
      continue
    }
    if (type === '0' || type === '\0') entries.push({ name, data: Buffer.from(data) })
  }
  return entries
}

function inflateTarball(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf, { maxOutputLength: MAX_UNPACKED_BYTES })
    } catch {
      const error = new Error('gzip')
      error.code = 'bad-package'
      throw error
    }
  }
  return buf
}

function entryParts(name) {
  return String(name ?? '').replace(/^\.\//, '').split('/').filter((part) => part !== '' && part !== '.')
}

function writeOctal(header, offset, value, length) {
  const text = Number(value).toString(8).padStart(length - 1, '0').slice(-(length - 1))
  header.write(text, offset, length - 1, 'ascii')
  header[offset + length - 1] = 0
}

function tarHeader(name, size, typeflag = '0') {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8')
  writeOctal(header, 100, 0o644, 8)
  writeOctal(header, 108, 0, 8)
  writeOctal(header, 116, 0, 8)
  writeOctal(header, 124, size, 12)
  writeOctal(header, 136, 0, 12)
  for (let i = 148; i < 156; i++) header[i] = 32
  header[156] = typeflag.charCodeAt(0)
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  const checksum = sum.toString(8).padStart(6, '0')
  header.write(checksum, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 32
  return header
}

function appendTarFile(chunks, name, data) {
  if (Buffer.byteLength(name) > 100) {
    const long = Buffer.from(`${name}\0`)
    chunks.push(tarHeader('././@LongLink', long.length, 'L'))
    chunks.push(long)
    const pad = (512 - (long.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad))
    chunks.push(tarHeader(name.slice(0, 100), data.length, '0'))
  } else {
    chunks.push(tarHeader(name, data.length, '0'))
  }
  chunks.push(data)
  const pad = (512 - (data.length % 512)) % 512
  if (pad > 0) chunks.push(Buffer.alloc(pad))
}

/**
 * 核对包名和版本，并重打包成 `package/` 开头的 npm 压缩包。
 * `dsh plugin add` 认这种包，不认 git 仓库。
 * @param {Buffer} bytes
 * @param {{ name?: string, version: string }} expected
 */
export function repackReleaseTarball(bytes, expected) {
  let raw
  try {
    raw = inflateTarball(bytes)
  } catch (error) {
    if (error?.code === 'bad-package') throw error
    const wrapped = new Error('inflate')
    wrapped.code = 'bad-package'
    throw wrapped
  }
  let entries
  try {
    entries = readTarEntries(raw)
  } catch (error) {
    if (error?.code === 'bad-package') throw error
    const wrapped = new Error('tar')
    wrapped.code = 'bad-package'
    throw wrapped
  }
  const manifests = []
  for (const entry of entries) {
    const parts = entryParts(entry.name)
    if (parts.length === 2 && parts[1] === 'package.json' && !parts.some((part) => part === '..' || part.includes('\\') || part.includes('\0'))) {
      manifests.push({ root: parts[0], data: entry.data })
    }
  }
  if (manifests.length !== 1) {
    const error = new Error('manifest-count')
    error.code = 'bad-package'
    throw error
  }
  let manifest
  try {
    manifest = JSON.parse(manifests[0].data.toString('utf8'))
  } catch {
    const error = new Error('json')
    error.code = 'bad-package'
    throw error
  }
  const wantName = expected.name || ''
  const nameOk = wantName !== ''
    ? manifest?.name === wantName
    : manifest?.name === PACKAGE_NAME || manifest?.name === LEGACY_UNSCOPED_NAME
  if (!nameOk) {
    const error = new Error('name')
    error.code = 'wrong-name'
    throw error
  }
  if (compareSemver(manifest.version, expected.version) !== 0) {
    const error = new Error('version')
    error.code = 'wrong-version'
    throw error
  }
  const root = manifests[0].root
  const files = []
  for (const entry of entries) {
    const parts = entryParts(entry.name)
    if (parts.length < 2 || parts[0] !== root) continue
    if (parts.some((part) => part === '..' || part.includes('\\') || part.includes('\0') || part.startsWith('/'))) {
      const error = new Error('path')
      error.code = 'bad-package'
      throw error
    }
    const packedName = `package/${parts.slice(1).join('/')}`
    files.push({ name: packedName, data: entry.data })
  }
  if (!files.some((file) => file.name === 'package/package.json')) {
    const error = new Error('missing-manifest')
    error.code = 'bad-package'
    throw error
  }
  const chunks = []
  for (const file of files) appendTarFile(chunks, file.name, file.data)
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

/** 给测试造一个和 GitHub 标签包一样、根目录套了一层的 tar.gz。 */
export function fixtureTarball(files, root = 'dsh-qq-bot-9.9.9') {
  const chunks = []
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data))
    appendTarFile(chunks, `${root}/${file.name}`, data)
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function quoteCmdArg(arg) {
  const text = String(arg)
  if (text === '' || /["&|<>^%\n\r]/.test(text)) {
    const error = new Error('bad-path')
    error.code = 'error'
    throw error
  }
  return /\s/.test(text) ? `"${text}"` : text
}

function isRegistryMiss(text) {
  return /ERR_PNPM_FETCH_404|ERR_PNPM_NO_MATCHING_VERSION|E404|404 Not Found|is not in this registry|No matching version|not found in the registry/i.test(String(text ?? ''))
}

/**
 * `dsh plugin --profile web add <包@版本>` 或本地压缩包。
 * Windows 用 cmd 调 dsh.cmd，避免直接敲到被拦截的 ps1。
 * @param {{ tarballPath?: string, packageSpec?: string, platform?: string, profile?: string, comSpec?: string }} spec
 */
export function dshPluginAddSpec(spec) {
  const profile = spec.profile || 'web'
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(profile)) {
    const error = new Error('profile')
    error.code = 'bad-package'
    throw error
  }
  const packageSpec = spec.packageSpec == null ? '' : String(spec.packageSpec)
  const tarballPath = spec.tarballPath == null ? '' : String(spec.tarballPath)
  if (packageSpec !== '') {
    const version = packageSpec.startsWith(`${PACKAGE_NAME}@`) ? packageSpec.slice(PACKAGE_NAME.length + 1) : ''
    if (npmInstallSpec(version) !== packageSpec) {
      const error = new Error('spec')
      error.code = 'bad-package'
      throw error
    }
  }
  if (packageSpec === '' && tarballPath === '') {
    const error = new Error('target')
    error.code = 'bad-package'
    throw error
  }
  const pluginArgs = ['plugin', '--profile', profile, 'add', packageSpec !== '' ? packageSpec : tarballPath]
  const platform = spec.platform || process.platform
  if (platform === 'win32') {
    const line = ['dsh.cmd', ...pluginArgs].map(quoteCmdArg).join(' ')
    return { command: spec.comSpec || 'cmd.exe', args: ['/d', '/s', '/c', line], shell: false }
  }
  return { command: 'dsh', args: pluginArgs, shell: false }
}

function runChild(spawnImpl, command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        shell: false,
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, code: error?.code === 'ENOENT' ? 'ENOENT' : 'error' })
      return
    }
    if (!child || typeof child.on !== 'function') {
      finish({ ok: false, code: 'error' })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on?.('data', (chunk) => {
      if (!options.capture || stdout.length >= 2000) return
      stdout += chunk.toString().slice(0, 2000 - stdout.length)
    })
    child.stderr?.on?.('data', (chunk) => {
      if (stderr.length >= 4000) return
      stderr += chunk.toString().slice(0, 4000 - stderr.length)
    })
    child.on('error', (error) => finish({ ok: false, code: error?.code === 'ENOENT' ? 'ENOENT' : 'error', stdout, stderr }))
    timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* 超时就停 */ }
      finish({ ok: false, code: 'timeout' })
    }, options.timeoutMs ?? INSTALL_TIMEOUT_MS)
    child.on('close', (code) => finish({ ok: code === 0, code: code === 0 ? 0 : 'exit', stdout, stderr }))
  })
}

async function defaultRunCommand(spec) {
  const planned = dshPluginAddSpec(spec)
  const ran = await runChild(spec.spawnImpl || spawn, planned.command, planned.args, {
    cwd: spec.cwd || process.cwd(),
    env: spec.env || process.env,
    timeoutMs: spec.timeoutMs ?? INSTALL_TIMEOUT_MS,
    capture: true,
  })
  if (ran.ok) return { ok: true, code: 0 }
  if (spec.packageSpec && isRegistryMiss(ran.stderr)) return { ok: false, code: 'unpublished' }
  if (ran.code === 'ENOENT' || ran.code === 'timeout') return { ok: false, code: ran.code }
  return { ok: false, code: 'error' }
}

function readOwnCgroup() {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8')
  } catch {
    return ''
  }
}

/** 从 cgroup 里取直接托管本进程的服务名。用户会话本身（user@1000.service）不算。 */
export function systemdUnitFromCgroup(text) {
  const names = []
  for (const line of String(text ?? '').split('\n')) {
    for (const part of line.split('/')) {
      const name = part.trim()
      if (/^[A-Za-z0-9][A-Za-z0-9:_.@+-]*\.service$/.test(name)) names.push(name)
    }
  }
  const specific = names.filter((name) => !/^user@\d+\.service$/.test(name))
  return specific.length > 0 ? specific[specific.length - 1] : null
}

/**
 * 脱离父进程之后再重启的小脚本。只杀给定 pid，再按原来的命令行拉起，不碰别的进程。
 * 用 node -e 跑，所以是 CommonJS。
 */
export const RESTART_HELPER = `
const { spawn } = require('node:child_process')
let spec = {}
try { spec = JSON.parse(process.env.DSH_QQ_BOT_RESTART || '{}') } catch { spec = {} }
const env = { ...process.env }
delete env.DSH_QQ_BOT_RESTART
const delay = Number(spec.delayMs) > 0 ? Number(spec.delayMs) : ${RESTART_DELAY_MS}
function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
setTimeout(() => {
  const pid = Number(spec.pid)
  const known = Number.isInteger(pid) && pid > 1
  if (known) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  const started = Date.now()
  const timer = setInterval(() => {
    const still = known && alive(pid)
    if (!still || Date.now() - started > 20000) {
      clearInterval(timer)
      if (still) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
      setTimeout(() => {
        if (typeof spec.execPath === 'string' && Array.isArray(spec.argv)) {
          const child = spawn(spec.execPath, spec.argv, {
            cwd: typeof spec.cwd === 'string' && spec.cwd !== '' ? spec.cwd : undefined,
            env,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          })
          child.unref()
        }
        process.exit(0)
      }, still ? 400 : 200)
    }
  }, 200)
}, delay)
`.trim()

/**
 * 重启计划。systemd 里只重启 cgroup 里那个具体服务，用 systemd-run 把动作放到服务外面。
 * 认不出单独服务时不重启整个登录会话。其余情况等响应发出后，按当前进程的命令行再拉起一次。
 */
export function planPanelRestart(input = {}) {
  const platform = input.platform || process.platform
  const env = input.env || process.env
  const invocation = platform !== 'win32' && Boolean(env && (env.INVOCATION_ID || env.NOTIFY_SOCKET))
  const unit = invocation ? systemdUnitFromCgroup(input.cgroup ?? '') : null
  if (invocation && !unit) return { mode: 'manual' }
  if (unit) {
    return {
      mode: 'systemd',
      command: 'systemd-run',
      args: ['--quiet', '--collect', '--on-active=3s', '--timer-property=AccuracySec=1s', '--', 'systemctl', 'restart', unit],
      unit,
    }
  }
  return {
    mode: 'reexec',
    execPath: input.execPath || process.execPath,
    argv: Array.isArray(input.argv) ? input.argv : process.argv.slice(1),
    pid: input.pid || process.pid,
    cwd: input.cwd || process.cwd(),
    delayMs: RESTART_DELAY_MS,
  }
}

/**
 * @param {{ plan?: ReturnType<typeof planPanelRestart>, spawnImpl?: typeof spawn, env?: NodeJS.ProcessEnv, platform?: string, cgroup?: string, execPath?: string, argv?: string[], pid?: number, cwd?: string }} input
 */
export async function schedulePanelRestart(input = {}) {
  const plan = input.plan || planPanelRestart(input)
  if (plan.mode === 'manual') return { ok: false, mode: 'manual', error: restartError() }
  const spawnImpl = input.spawnImpl || spawn
  if (plan.mode === 'systemd') {
    const ran = await runChild(spawnImpl, plan.command, plan.args, { timeoutMs: 20000, stdio: 'ignore' })
    if (!ran.ok) return { ok: false, mode: 'systemd', error: restartError() }
    return { ok: true, mode: 'systemd' }
  }
  const payload = JSON.stringify({
    pid: plan.pid,
    cwd: plan.cwd,
    execPath: plan.execPath,
    argv: plan.argv,
    delayMs: plan.delayMs,
  })
  const env = { ...(input.env || process.env) }
  delete env.DSH_QQ_BOT_RESTART
  env.DSH_QQ_BOT_RESTART = payload
  let child
  try {
    child = spawnImpl(plan.execPath, ['-e', RESTART_HELPER], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env,
      cwd: plan.cwd,
    })
  } catch {
    return { ok: false, mode: 'reexec', error: restartError() }
  }
  if (!child || typeof child.on !== 'function') return { ok: false, mode: 'reexec', error: restartError() }
  child.on('error', () => {})
  if (typeof child.unref === 'function') child.unref()
  return { ok: true, mode: 'reexec' }
}

function successMessage(tag, channel) {
  const via = channel === 'npm'
    ? '这次是从 npm 装的。'
    : '这一版在 npm 上还没有，所以从 GitHub 装上。'
  return `已经装上 ${tag}，面板即将重启。请刷新页面；登录口令可能会变，用新的面板地址再打开。${via}现有设置还在，没有改动 NapCat。`
}

function shownInstall(channel, version, repo) {
  if (channel === 'npm') return { install: npmInstallSpec(version), command: npmInstallCommand(version) }
  return { install: installSpec(version, repo), command: installCommand(version, repo) }
}

/**
 * 下载并安装一次检查允许的版本，然后安排重启。
 * 调用方要自己做登录校验。这里不读设置文件，也不碰 NapCat。
 * 先 `dsh plugin add @fengye_nobug/dsh-qq-bot@版本`。registry 里没有这个版本时，才下载 GitHub 上的同一标签。
 * @param {{ current: unknown, version?: unknown, force?: boolean, repo?: string, fetchImpl?: typeof fetch, registry?: string, proxy?: string, platform?: string, profile?: string, runCommand?: (spec: object) => Promise<{ ok: boolean, code?: string | number }>, scheduleRestart?: (spec: object) => Promise<{ ok: boolean, error?: string }>, spawnImpl?: typeof spawn, timeoutMs?: number, downloadTimeoutMs?: number, maxBytes?: number }} input
 */
export async function applyPluginUpdate(input = {}) {
  const repo = input.repo || UPDATE_REPO
  const found = await findUpdate({ ...input, applying: true })
  if (!found.ok) {
    return { ok: false, stage: 'github', current: String(input.current ?? ''), error: found.error, message: found.error }
  }
  const decision = chooseApplyTarget({
    current: input.current,
    releases: found.releases,
    version: input.version,
    force: input.force === true,
    repo,
    channel: found.channel,
  })
  if (!decision.ok) {
    return {
      ok: false,
      stage: 'refused',
      current: String(input.current ?? ''),
      error: decision.error,
      message: decision.error,
      updateAvailable: false,
    }
  }
  let channel = decision.channel
  if (channel === 'npm') {
    let ran
    try {
      const run = input.runCommand || defaultRunCommand
      ran = await run({
        packageSpec: decision.install,
        platform: input.platform,
        profile: 'web',
        spawnImpl: input.spawnImpl,
        timeoutMs: input.timeoutMs,
      })
    } catch {
      ran = { ok: false, code: 'error' }
    }
    if (ran?.ok === true) return finishApply(input, decision, 'npm')
    if (ran?.code !== 'unpublished') {
      const message = installError(ran?.code, decision.command)
      return {
        ok: false,
        stage: 'install',
        current: decision.current,
        error: message,
        message,
        tag: decision.tag,
        version: decision.version,
        command: decision.command,
        install: decision.install,
      }
    }
    channel = 'github'
  }
  const shown = shownInstall(channel, decision.version, repo)
  let bytes
  try {
    bytes = await downloadReleaseTarball({
      url: decision.tarballUrl,
      fallbackUrl: decision.fallbackUrl,
      repo,
      tag: decision.tag,
      fetchImpl: input.fetchImpl,
      proxy: input.proxy,
      timeoutMs: input.downloadTimeoutMs,
      maxBytes: input.maxBytes,
      spawnImpl: input.spawnImpl,
      platform: input.platform,
    })
  } catch (error) {
    const message = downloadError(error?.code)
    return { ok: false, stage: 'github', current: decision.current, error: message, message, tag: decision.tag, command: shown.command, install: shown.install }
  }
  let packed
  try {
    packed = repackReleaseTarball(bytes, { name: PACKAGE_NAME, version: decision.version })
  } catch (error) {
    const message = installError(error?.code, shown.command)
    return { ok: false, stage: 'install', current: decision.current, error: message, message, tag: decision.tag, command: shown.command, install: shown.install }
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-update-'))
  const tarballPath = join(dir, `dsh-qq-bot-${decision.version}.tgz`)
  let ran
  try {
    writeFileSync(tarballPath, packed)
    const run = input.runCommand || defaultRunCommand
    ran = await run({
      tarballPath,
      platform: input.platform,
      profile: 'web',
      spawnImpl: input.spawnImpl,
      timeoutMs: input.timeoutMs,
    })
  } catch {
    ran = { ok: false, code: 'error' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  if (!ran || ran.ok !== true) {
    const message = installError(ran?.code, shown.command)
    return { ok: false, stage: 'install', current: decision.current, error: message, message, tag: decision.tag, version: decision.version, command: shown.command, install: shown.install }
  }
  return finishApply(input, { ...decision, install: shown.install, command: shown.command }, 'github')
}

async function finishApply(input, decision, channel) {
  let restart
  try {
    const schedule = input.scheduleRestart || schedulePanelRestart
    restart = await schedule({ spawnImpl: input.spawnImpl, platform: input.platform })
  } catch {
    restart = { ok: false, error: restartError() }
  }
  if (!restart || restart.ok !== true) {
    const message = restart?.error || restartError()
    return {
      ok: false,
      stage: 'restart',
      installed: true,
      channel,
      current: decision.current,
      version: decision.version,
      tag: decision.tag,
      install: decision.install,
      command: decision.command,
      error: message,
      message,
    }
  }
  const message = successMessage(decision.tag, channel)
  return {
    ok: true,
    applied: true,
    restarting: true,
    stage: 'restart',
    channel,
    current: decision.current,
    version: decision.version,
    latest: decision.version,
    tag: decision.tag,
    summary: decision.summary,
    install: decision.install,
    command: decision.command,
    url: decision.url,
    updateAvailable: false,
    message,
  }
}
