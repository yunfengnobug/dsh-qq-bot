// 检查更新和一键安装。不连真 GitHub、不调真 dsh：fetch 和命令都由用例自己提供。
// 运行：node test-updates.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  applyPluginUpdate,
  assessUpdate,
  checkPluginUpdate,
  chooseApplyTarget,
  codeloadTarballUrl,
  githubArchiveUrl,
  compareSemver,
  dshPluginAddSpec,
  failureMessage,
  fixtureTarball,
  installCommand,
  npmInstallCommand,
  npmInstallSpec,
  npmPackageUrl,
  NPM_REGISTRY,
  normalizeRegistry,
  alignCordisNames,
  clearStaleRunRecord,
  parseRunRecord,
  parseSemver,
  profileDirectory,
  queryNpmVersions,
  rewriteCordisPackageName,
  runPluginAdd,
  runRecordPath,
  stopProcessTree,
  planPanelRestart,
  RESTART_HELPER,
  repackReleaseTarball,
  schedulePanelRestart,
  summarizeReleaseNotes,
  systemdUnitFromCgroup,
} from './updates.js'

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

check('parse：v 前缀与裸版本是同一个号', parseSemver('v0.2.3')?.raw === '0.2.3' && parseSemver('0.2.3')?.raw === '0.2.3')
check('parse：预发布留着', parseSemver('1.2.3-rc.1')?.raw === '1.2.3-rc.1')
check('parse：多出来的一段不算版本', parseSemver('1.2.3.4') === null && parseSemver('latest') === null && parseSemver('') === null)

check('0.2.4 比 0.2.3 新', compareSemver('0.2.4', '0.2.3') === 1)
check('0.2.10 比 0.2.9 新（不按字符串比）', compareSemver('0.2.10', '0.2.9') === 1)
check('v 前缀不影响大小', compareSemver('v0.2.3', '0.2.3') === 0)
check('正式版高于同号预发布', compareSemver('1.0.0', '1.0.0-rc.1') === 1)
check('预发布按段比：alpha 小于 alpha.1', compareSemver('1.0.0-alpha', '1.0.0-alpha.1') === -1)
check('数字段按数值比：beta.2 小于 beta.11', compareSemver('1.0.0-beta.2', '1.0.0-beta.11') === -1)
check('解析不了就没法比', compareSemver('nope', '1.0.0') === null)

const notes = summarizeReleaseNotes('# 标题\n\n- 商城表情按 mface 发送\n\n```js\nignore()\n```\n[链接](https://example.invalid/secret)')
check('摘要留下人话，去掉代码块和链接地址', notes.includes('商城表情按 mface 发送') && notes.includes('链接') && !notes.includes('example.invalid') && !notes.includes('ignore()'), notes)

function release(tag, extra = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    body: extra.body ?? '',
    html_url: extra.html_url,
    ...extra,
  }
}

const newer = assessUpdate({
  current: '0.2.3',
  releases: [
    release('v0.2.2', { body: '更旧的' }),
    release('v0.2.4-rc.1', { prerelease: true, body: '预发布不能当正式版' }),
    release('v0.2.4', { body: '- 设置页可以检查更新', draft: false }),
    release('v9.0.0', { draft: true, body: '草稿' }),
  ],
})
check('有新正式版：跳过草稿和预发布，取最高的', newer.updateAvailable === true && newer.latest === '0.2.4' && newer.kind === 'update')
check(
  '有新正式版：白话里有版本、摘要、安装命令和重启',
  newer.message.includes('有新版本 0.2.4') &&
    newer.message.includes('你现在是 0.2.3') &&
    newer.message.includes('设置页可以检查更新') &&
    newer.message.includes('装完请重启 dsh-web') &&
    newer.message.includes('更新到 v0.2.4') &&
    newer.command === installCommand('0.2.4') &&
    newer.install === 'github:yunfengnobug/dsh-qq-bot#v0.2.4',
  newer.message,
)
check('发布页只认本仓库', newer.url.startsWith('https://github.com/yunfengnobug/dsh-qq-bot/'))

const same = assessUpdate({ current: 'v0.2.4', releases: [release('v0.2.4')] })
check('版本相同：不用更新', same.updateAvailable === false && same.kind === 'current' && same.message.includes('已经是最新正式版 0.2.4'))

const ahead = assessUpdate({ current: '0.2.4', releases: [release('v0.2.3', { body: '旧版' })] })
check('本地比 Release 新：不要往回装', ahead.kind === 'ahead' && ahead.updateAvailable === false && ahead.message.includes('还新'))

const onlyRc = assessUpdate({ current: '0.2.3', releases: [release('v0.2.4-rc.1', { prerelease: true })] })
check('只有预发布：不当成可装的新版本', onlyRc.kind === 'no-release' && onlyRc.updateAvailable === false && /还没有可用的正式版/.test(onlyRc.message))

const badUrl = assessUpdate({
  current: '0.2.3',
  releases: [release('v0.2.4', { html_url: 'https://evil.example/releases/v0.2.4', body: '说明' })],
})
check('别人的 html_url 换成仓库自己的发布页', badUrl.url === 'https://github.com/yunfengnobug/dsh-qq-bot/releases/tag/v0.2.4' && !badUrl.message.includes('evil.example'), badUrl.url)

const badCurrent = assessUpdate({ current: 'not-a-version', releases: [release('v0.2.4')] })
check('当前版本读不出来', badCurrent.ok === false && badCurrent.message.includes('读不出来'))

check('限流文案不带英文堆栈', failureMessage(403, 'API rate limit exceeded for 203.0.113.8') === 'GitHub 限流了，等一会儿再点「检查更新」。')
check('404 是白话', failureMessage(404, 'Not Found') === '没有查到这个仓库的 Release。')
check('其它失败不带状态码堆栈', failureMessage(500, 'Internal Server Error') === '连不上 GitHub，这次没有检查到更新。稍后再试。')

const offline = await checkPluginUpdate({
  current: '0.2.4',
  fetchImpl: async () => {
    throw new TypeError('fetch failed')
  },
})
check(
  'fetch 抛错：白话，且不出现 fetch failed',
  offline.ok === false && /连不上 GitHub/.test(offline.error) && !/fetch failed|TypeError/.test(offline.error),
  String(offline.error),
)

const limited = await checkPluginUpdate({
  current: '0.2.4',
  fetchImpl: async () => ({
    ok: false,
    status: 429,
    text: async () => 'secondary rate limit for 198.51.100.20',
  }),
})
check(
  '429：限流白话，不带回源地址',
  limited.ok === false && /限流/.test(limited.message) && !/198\.51\.100\.20/.test(limited.message),
  String(limited.message),
)

const garbled = await checkPluginUpdate({
  current: '0.2.4',
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token')
    },
  }),
})
check('JSON 读不懂：白话', garbled.ok === false && /读不懂/.test(garbled.error) && !/Unexpected token|SyntaxError/.test(garbled.error), String(garbled.error))

const notAFunction = await checkPluginUpdate({ current: '0.2.4', fetchImpl: /** @type {any} */ (null) })
check('没有 fetch：不抛、白话失败', notAFunction.ok === false && /连不上 GitHub/.test(notAFunction.error), String(notAFunction.error))

check(
  '给人看的安装命令仍是 github 标签',
  installCommand('v0.2.5') === 'dsh plugin --profile web add github:yunfengnobug/dsh-qq-bot#v0.2.5',
)
check(
  '先下载 GitHub 官方源码包，codeload 只是同一标签的备用地址',
  githubArchiveUrl('v0.2.5') === 'https://github.com/yunfengnobug/dsh-qq-bot/archive/refs/tags/v0.2.5.tar.gz' &&
    codeloadTarballUrl('v0.2.5') === 'https://codeload.github.com/yunfengnobug/dsh-qq-bot/tar.gz/refs/tags/v0.2.5' &&
    !githubArchiveUrl('v0.2.5').includes('codeload') &&
    !/ghproxy|fastgit|gitclone|kgithub/i.test(`${githubArchiveUrl('0.2.5')} ${codeloadTarballUrl('0.2.5')}`),
)
check('仓库名不合法时不拼下载地址', githubArchiveUrl('0.2.5', 'evil/../other') === '' && codeloadTarballUrl('0.2.5-rc.1') === '')

const unflaggedRc = assessUpdate({
  current: '0.2.3',
  releases: [release('v0.2.4-rc.1', { prerelease: false, body: '漏标的预发布' })],
})
check('标签里带预发布、即使没标 prerelease，也不当正式版', unflaggedRc.kind === 'no-release' && unflaggedRc.updateAvailable === false)

function packageJson(version, name = '@fengye_nobug/dsh-qq-bot') {
  return JSON.stringify({ name, version })
}

const packed = repackReleaseTarball(
  fixtureTarball([
    { name: 'package.json', data: packageJson('9.9.9') },
    { name: 'index.js', data: 'export const name = "qq-bridge"\n' },
    { name: `nested/${'long-'.repeat(30)}file.js`, data: 'x' },
  ]),
  { version: '9.9.9' },
)
const packedRaw = gunzipSync(packed)
check(
  '重打包后是 package/ 开头，长文件名还在',
  packedRaw.includes(Buffer.from('package/package.json')) && packedRaw.includes(Buffer.from('package/index.js')) && packedRaw.includes(Buffer.from('long-long-')),
)

let rejectedName = false
try {
  repackReleaseTarball(fixtureTarball([{ name: 'package.json', data: packageJson('9.9.9', 'other-plugin') }]), { version: '9.9.9' })
} catch (error) {
  rejectedName = error?.code === 'wrong-name'
}
let legacyName = false
try {
  repackReleaseTarball(fixtureTarball([{ name: 'package.json', data: packageJson('9.9.9', 'dsh-qq-bot') }]), { version: '9.9.9' })
  legacyName = true
} catch {
  legacyName = false
}
let rejectedOtherScope = false
try {
  repackReleaseTarball(fixtureTarball([{ name: 'package.json', data: packageJson('9.9.9', '@other/dsh-qq-bot') }]), { version: '9.9.9' })
} catch (error) {
  rejectedOtherScope = error?.code === 'wrong-name'
}
check('包名不是这个插件就拒绝，GitHub 旧标签里的无作用域名仍可装', rejectedName && legacyName && rejectedOtherScope)

let rejectedVersion = false
try {
  repackReleaseTarball(fixtureTarball([{ name: 'package.json', data: packageJson('0.0.1') }]), { version: '9.9.9' })
} catch (error) {
  rejectedVersion = error?.code === 'wrong-version'
}
check('压缩包里的版本和标签对不上就拒绝', rejectedVersion)

let rejectedPath = false
try {
  repackReleaseTarball(
    fixtureTarball([
      { name: 'package.json', data: packageJson('9.9.9') },
      { name: '../../outside.txt', data: 'nope' },
    ]),
    { version: '9.9.9' },
  )
} catch (error) {
  rejectedPath = error?.code === 'bad-package'
}
check('压缩包里的路径跳出目录就拒绝', rejectedPath)

const linuxAdd = dshPluginAddSpec({ tarballPath: '/tmp/dsh-qq-bot-9.9.9.tgz', platform: 'linux' })
check(
  'Linux 上就是 dsh plugin add 这个压缩包',
  linuxAdd.command === 'dsh' && linuxAdd.shell === false && linuxAdd.args.join(' ') === 'plugin --profile web add /tmp/dsh-qq-bot-9.9.9.tgz',
)
const windowsAdd = dshPluginAddSpec({
  tarballPath: 'C:\\Temp\\dsh qq bot\\dsh-qq-bot-9.9.9.tgz',
  platform: 'win32',
  comSpec: 'cmd.exe',
})
check(
  'Windows 用 dsh.cmd，路径里的空格被引号包住',
  windowsAdd.command === 'cmd.exe' &&
    windowsAdd.args[0] === '/d' &&
    windowsAdd.args[3].includes('dsh.cmd plugin --profile web add "C:\\Temp\\dsh qq bot\\dsh-qq-bot-9.9.9.tgz"'),
  windowsAdd.args[3],
)
let rejectedMeta = false
try {
  dshPluginAddSpec({ tarballPath: '/tmp/a&b.tgz', platform: 'win32' })
} catch {
  rejectedMeta = true
}
check('路径里有命令分隔符时不交给 cmd', rejectedMeta)

check(
  'cgroup 里取具体服务，不取 user@',
  systemdUnitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n') === 'dsh-web.service',
)
check('只有用户会话时不猜服务名', systemdUnitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service\n') === null)

const systemdPlan = planPanelRestart({
  platform: 'linux',
  env: { INVOCATION_ID: 'abc' },
  cgroup: '0::/system.slice/dsh-web.service\n',
  execPath: '/usr/bin/node',
  argv: ['/usr/bin/dsh', 'web'],
  pid: 4242,
  cwd: '/tmp',
})
check(
  'systemd 下预约重启那个服务，而不是再拉起一份',
  systemdPlan.mode === 'systemd' &&
    systemdPlan.scope === 'system' &&
    systemdPlan.command === 'systemd-run' &&
    systemdPlan.args.includes('restart') &&
    systemdPlan.args.includes('dsh-web.service') &&
    !systemdPlan.args.includes('--user') &&
    !systemdPlan.args.includes('4242'),
  JSON.stringify(systemdPlan.args),
)
const userPlan = planPanelRestart({
  platform: 'linux',
  env: { INVOCATION_ID: 'abc' },
  cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n',
})
check(
  '用户服务用 systemctl --user 重启，不碰 user@',
  userPlan.mode === 'systemd' &&
    userPlan.scope === 'user' &&
    userPlan.unit === 'dsh-web.service' &&
    userPlan.args.includes('--user') &&
    userPlan.args.includes('dsh-web.service') &&
    !userPlan.args.includes('user@1000.service'),
  JSON.stringify(userPlan.args),
)
let cgroupReads = 0
const readPlan = planPanelRestart({
  platform: 'linux',
  env: { INVOCATION_ID: 'abc' },
  readCgroup: () => {
    cgroupReads += 1
    return '0::/system.slice/dsh-web.service\n'
  },
})
check(
  '没传入 cgroup 时读取本进程的 cgroup',
  cgroupReads === 1 && readPlan.mode === 'systemd' && readPlan.unit === 'dsh-web.service' && readPlan.scope === 'system',
)
let skippedReads = 0
const notSystemd = planPanelRestart({
  platform: 'linux',
  env: {},
  readCgroup: () => {
    skippedReads += 1
    return '0::/system.slice/dsh-web.service'
  },
  execPath: '/usr/bin/node',
  argv: ['bin.js', 'web'],
  pid: 7,
  cwd: '/work',
})
check('没被 systemd 拉起时不读 cgroup', skippedReads === 0 && notSystemd.mode === 'reexec')
check(
  '认不出单独服务时不重启整个登录',
  planPanelRestart({ platform: 'linux', env: { NOTIFY_SOCKET: '/run/systemd/notify' }, cgroup: '0::/user.slice/user@1000.service' }).mode === 'manual',
)
check(
  '没被 systemd 拉起时，即使 cgroup 里有服务名，也按当前命令行重启',
  planPanelRestart({
    platform: 'linux',
    env: {},
    cgroup: '0::/system.slice/dsh-web.service',
    execPath: '/usr/bin/node',
    argv: ['bin.js', 'web'],
    pid: 7,
    cwd: '/work',
  }).mode === 'reexec',
)
check(
  '重启脚本只杀给定进程并按原命令拉起，不提 NapCat 或设置文件',
  RESTART_HELPER.includes('SIGTERM') &&
    RESTART_HELPER.includes('DSH_QQ_BOT_RESTART') &&
    !/napcat|qq-bridge-settings|shell\s*:/i.test(RESTART_HELPER),
)

function laterClose(code) {
  return (command, args, options) => {
    const handlers = {}
    const child = {
      stdout: { on() {} },
      stderr: { on() {} },
      on(name, fn) {
        handlers[name] = fn
        return child
      },
      kill() {},
      unref() {},
    }
    queueMicrotask(() => handlers.close?.(code))
    child.command = command
    child.args = args
    child.options = options
    return child
  }
}

const systemdSpawned = []
const systemdOk = await schedulePanelRestart({
  plan: systemdPlan,
  spawnImpl: (command, args, options) => {
    systemdSpawned.push({ command, args, options })
    return laterClose(0)(command, args, options)
  },
})
check('systemd-run 成功就认为重启已安排', systemdOk.ok === true && systemdOk.mode === 'systemd' && systemdSpawned[0]?.command === 'systemd-run' && systemdSpawned[0]?.options?.detached !== true)
const privilegeSteps = []
const privilegeFallback = await schedulePanelRestart({
  plan: systemdPlan,
  execPath: '/usr/bin/node',
  argv: ['bin.js', 'web'],
  pid: 4242,
  cwd: '/work',
  env: { PATH: '/usr/bin' },
  spawnImpl: (command, args, options) => {
    privilegeSteps.push(command)
    if (command === 'systemd-run') return laterClose(1)(command, args, options)
    return { on() {}, unref() {}, command, args, options }
  },
})
check(
  'systemd-run 失败时改按当前命令行重启',
  privilegeFallback.ok === true &&
    privilegeFallback.mode === 'reexec' &&
    privilegeSteps[0] === 'systemd-run' &&
    privilegeSteps[1] === '/usr/bin/node' &&
    !privilegeFallback.error,
  JSON.stringify(privilegeSteps),
)
const restartGiveUp = await schedulePanelRestart({
  plan: systemdPlan,
  spawnImpl: () => {
    throw new Error('EPERM')
  },
})
check(
  'systemd 和命令行都拉不起来才是白话',
  restartGiveUp.ok === false &&
    restartGiveUp.mode === 'manual' &&
    /已经装上/.test(restartGiveUp.error) &&
    /请自己重启/.test(restartGiveUp.error) &&
    /登录口令/.test(restartGiveUp.error) &&
    !/Error|EPERM|ENOENT/.test(restartGiveUp.error),
  String(restartGiveUp.error),
)
const manualSpawn = []
const manualRestart = await schedulePanelRestart({
  plan: { mode: 'manual' },
  execPath: '/usr/bin/node',
  argv: ['bin.js', 'web'],
  pid: 9,
  cwd: '/work',
  env: { PATH: '/usr/bin' },
  spawnImpl: (command, args, options) => {
    manualSpawn.push({ command, args, options })
    return { on() {}, unref() {} }
  },
})
check(
  '认不出单独服务时不重启整个登录，改为重启当前进程',
  manualRestart.ok === true &&
    manualRestart.mode === 'reexec' &&
    manualSpawn[0]?.command === '/usr/bin/node' &&
    manualSpawn[0]?.args?.[0] === '-e' &&
    !JSON.stringify(manualSpawn).includes('systemctl') &&
    !JSON.stringify(manualSpawn).includes('user@'),
  JSON.stringify(manualSpawn.map((item) => item.command)),
)

const reexecCalls = []
const reexecOk = await schedulePanelRestart({
  plan: {
    mode: 'reexec',
    execPath: '/usr/bin/node',
    argv: ['bin.js', 'web'],
    pid: 4242,
    cwd: '/work',
    delayMs: 2500,
  },
  env: { PATH: '/usr/bin', TOKEN: 'panel-secret' },
  spawnImpl: (command, args, options) => {
    reexecCalls.push({ command, args, options })
    return { on() {}, unref() {} }
  },
})
const reexecPayload = JSON.parse(reexecCalls[0]?.options?.env?.DSH_QQ_BOT_RESTART || '{}')
check(
  '脱离的重启进程带着原命令行，并且是 detached',
  reexecOk.ok === true &&
    reexecOk.mode === 'reexec' &&
    reexecCalls[0]?.options?.detached === true &&
    reexecCalls[0]?.options?.stdio === 'ignore' &&
    reexecPayload.pid === 4242 &&
    reexecPayload.argv?.[1] === 'web' &&
    !/panel-secret/.test(reexecCalls[0]?.args?.join(' ') || ''),
  JSON.stringify(reexecPayload),
)

function releasesOf(...tags) {
  return tags.map((tag) => release(tag, { body: `${tag} 的说明`, html_url: 'https://evil.example/nope' }))
}

function tarballFor(version) {
  return fixtureTarball([{ name: 'package.json', data: packageJson(version) }, { name: 'index.js', data: 'ok' }], `dsh-qq-bot-${version}`)
}

function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const href = String(url)
    calls.push({ url: href, redirect: init?.redirect })
    return handler(href, calls)
  }
  return { fetchImpl, calls }
}

const checkOnly = fakeFetch(() => ({
  ok: true,
  status: 200,
  json: async () => releasesOf('v9.9.9'),
  text: async () => '',
}))
await checkPluginUpdate({ current: '0.2.3', fetchImpl: checkOnly.fetchImpl })
check(
  '只检查时不会去下压缩包',
  checkOnly.calls.length === 2 &&
    checkOnly.calls[0].url === npmPackageUrl() &&
    checkOnly.calls[1].url.includes('api.github.com') &&
    checkOnly.calls.every((call) => !call.url.includes('codeload') && !call.url.includes('/archive/')),
)

async function applyWith(options) {
  const seen = []
  const fetchBox = fakeFetch(options.onFetch)
  const result = await applyPluginUpdate({
    current: options.current,
    version: options.version,
    force: options.force,
    platform: 'linux',
    fetchImpl: fetchBox.fetchImpl,
    proxy: options.proxy,
    spawnImpl: options.spawnImpl,
    runCommand: async (spec) => {
      seen.push(spec)
      if (options.runCommand) return options.runCommand(spec)
      return { ok: true, code: 0 }
    },
    scheduleRestart: options.scheduleRestart || (async () => ({ ok: true, mode: 'reexec' })),
  })
  return { result, calls: fetchBox.calls, seen }
}

const installed = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) {
      return { ok: true, status: 200, json: async () => releasesOf('v9.9.9', 'v0.2.4'), text: async () => '' }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => '' },
      arrayBuffer: async () => tarballFor('9.9.9'),
    }
  },
  runCommand: async (spec) => {
    const raw = gunzipSync(readFileSync(spec.tarballPath))
    return {
      ok: existsSync(spec.tarballPath) && raw.includes(Buffer.from('package/package.json')),
      code: 0,
      spec,
    }
  },
})
check(
  '有新版：先下 GitHub 官方源码包，装进 web，并安排重启',
  installed.result.ok === true &&
    installed.result.applied === true &&
    installed.result.restarting === true &&
    installed.result.tag === 'v9.9.9' &&
    installed.result.install === 'github:yunfengnobug/dsh-qq-bot#v9.9.9' &&
    installed.result.command === installCommand('9.9.9') &&
    /已经装上 v9.9.9/.test(installed.result.message) &&
    /登录口令可能会变/.test(installed.result.message) &&
    /没有改动 NapCat/.test(installed.result.message) &&
    !installed.result.message.includes('codeload') &&
    !installed.result.message.includes('evil.example') &&
    !/TypeError|fetch failed|\n\s+at /.test(installed.result.message) &&
    installed.calls.some((call) => call.url === githubArchiveUrl('9.9.9') && call.redirect === 'manual') &&
    !installed.calls.some((call) => call.url.includes('codeload')),
  JSON.stringify({ message: installed.result.message, urls: installed.calls.map((call) => call.url) }).slice(0, 500),
)
check(
  '安装参数只有 web profile 和压缩包，不碰设置或 NapCat',
  installed.seen.length === 1 &&
    installed.seen[0].profile === 'web' &&
    String(installed.seen[0].tarballPath).endsWith('dsh-qq-bot-9.9.9.tgz') &&
    !JSON.stringify(installed.seen[0]).includes('qq-bridge-settings') &&
    !JSON.stringify(installed.seen[0]).includes('napcat') &&
    !existsSync(installed.seen[0].tarballPath),
)

const already = await applyWith({
  current: '0.2.4',
  onFetch: () => ({ ok: true, status: 200, json: async () => releasesOf('v0.2.4'), text: async () => '' }),
})
check(
  '已经是最新：不下载、不安装',
  already.result.ok === false &&
    already.result.stage === 'refused' &&
    /已经是最新正式版/.test(already.result.error) &&
    already.seen.length === 0 &&
    already.calls.length === 2 &&
    already.calls[0].url === npmPackageUrl() &&
    already.calls.every((call) => !call.url.includes('/archive/') && !call.url.includes('codeload')),
  String(already.result.error),
)

const explicitSame = await applyWith({
  current: '0.2.4',
  version: 'v0.2.4',
  onFetch: () => ({ ok: true, status: 200, json: async () => releasesOf('v0.2.4'), text: async () => '' }),
})
check('点了当前版本：不重装', explicitSame.result.ok === false && /没有重装/.test(explicitSame.result.error) && explicitSame.seen.length === 0)

const forced = await applyWith({
  current: '0.2.4',
  version: '0.2.4',
  force: true,
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v0.2.4'), text: async () => '' }
    return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('0.2.4') }
  },
})
check('force 才重装同一个正式版', forced.result.ok === true && forced.result.tag === 'v0.2.4' && forced.seen.length === 1 && forced.seen[0].profile === 'web')

const forceText = await applyWith({
  current: '0.2.4',
  version: '0.2.4',
  force: 'true',
  onFetch: () => ({ ok: true, status: 200, json: async () => releasesOf('v0.2.4'), text: async () => '' }),
})
check('force 必须是布尔真，字符串不算', forceText.result.ok === false && forceText.seen.length === 0)

const older = await applyWith({
  current: '0.2.4',
  version: 'v0.2.3',
  force: true,
  onFetch: () => ({ ok: true, status: 200, json: async () => releasesOf('v0.2.4', 'v0.2.3'), text: async () => '' }),
})
check('更旧的标签即使 force 也不装', older.result.ok === false && /更旧/.test(older.result.error) && older.seen.length === 0 && !older.calls.some((call) => call.url.includes('codeload')))

const missingTag = await applyWith({
  current: '0.2.3',
  version: 'v8.8.8',
  onFetch: () => ({ ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }),
})
check('没在这次检查里出现的版本不装', missingTag.result.ok === false && /没有这个版本/.test(missingTag.result.error) && missingTag.seen.length === 0)

const invented = await applyWith({
  current: '0.2.3',
  version: '9.9.9; rm -rf /',
  onFetch: () => ({ ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }),
})
check('版本号里夹命令就不装', invented.result.ok === false && /格式不对/.test(invented.result.error) && invented.seen.length === 0)

const middle = await applyWith({
  current: '0.2.3',
  version: 'v0.2.4',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9', 'v0.2.4'), text: async () => '' }
    return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('0.2.4') }
  },
})
check(
  '可以装检查结果里比当前新、但不是最高的那个标签',
  middle.result.ok === true &&
    middle.result.tag === 'v0.2.4' &&
    middle.calls.some((call) => call.url === githubArchiveUrl('0.2.4')) &&
    !middle.calls.some((call) => call.url.includes('v9.9.9')),
)

const prerelease = chooseApplyTarget({ current: '0.2.3', releases: releasesOf('v0.2.4'), version: 'v0.2.4-rc.1' })
check('预发布标签直接拒绝', prerelease.ok === false && /格式不对|没有这个版本/.test(prerelease.error))

const offlineApply = await applyWith({
  current: '0.2.3',
  onFetch: () => {
    throw new TypeError('fetch failed')
  },
})
check(
  '安装前连不上 GitHub：白话，且不会去执行 dsh',
  offlineApply.result.ok === false &&
    offlineApply.result.stage === 'github' &&
    /连不上 GitHub/.test(offlineApply.result.error) &&
    !/fetch failed|TypeError/.test(offlineApply.result.error) &&
    offlineApply.seen.length === 0,
  String(offlineApply.result.error),
)

const redirected = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    if (url.includes('evil.example')) return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
    return { ok: false, status: 302, headers: { get: (name) => (String(name).toLowerCase() === 'location' ? 'https://evil.example/pkg.tgz' : '') } }
  },
})
check(
  '压缩包跳到别的网站就不下，文案里也不出现那个地址',
  redirected.result.ok === false &&
    redirected.result.stage === 'github' &&
    !/evil\.example/.test(redirected.result.error) &&
    redirected.seen.length === 0 &&
    !redirected.calls.some((call) => call.url.includes('evil.example')),
  String(redirected.result.error),
)

let hugeRead = false
const huge = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(50 * 1024 * 1024) : '') },
      arrayBuffer: async () => {
        hugeRead = true
        return tarballFor('9.9.9')
      },
    }
  },
})
check('声明过大的包不读正文', huge.result.ok === false && /太大/.test(huge.result.error) && hugeRead === false && huge.seen.length === 0, String(huge.result.error))

const wrongPackage = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    return {
      ok: true,
      status: 200,
      headers: { get: () => '' },
      arrayBuffer: async () => fixtureTarball([{ name: 'package.json', data: packageJson('9.9.9', 'other-plugin') }]),
    }
  },
})
check(
  '包名不对：不调用 dsh，也不把包名里的字当堆栈',
  wrongPackage.result.stage === 'install' && /不是这个插件/.test(wrongPackage.result.error) && wrongPackage.seen.length === 0 && !/other-plugin/.test(wrongPackage.result.error),
  String(wrongPackage.result.error),
)

const proxyCalls = []
const proxied = await applyWith({
  current: '0.2.3',
  proxy: 'http://proxy.invalid:9',
  spawnImpl: (_command, args) => {
    proxyCalls.push(args)
    throw new Error('curl failed s3cret-token http://proxy.invalid:9')
  },
  onFetch: (url) => {
    if (url.includes('codeload') || url.includes('/archive/')) {
      return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
    }
    return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
  },
})
check(
  '走代理时先请求 GitHub 官方地址，失败再试 codeload；口令和代理不回出去',
  proxied.result.stage === 'github' &&
    /连不上 GitHub/.test(proxied.result.error) &&
    !/s3cret-token|proxy\.invalid|ghproxy/.test(proxied.result.error) &&
    !proxied.calls.some((call) => call.url.includes('codeload') || call.url.includes('/archive/')) &&
    String(proxyCalls[0]).includes(githubArchiveUrl('9.9.9')) &&
    String(proxyCalls[1]).includes(codeloadTarballUrl('9.9.9')) &&
    proxyCalls.length === 2 &&
    proxied.seen.length === 0,
  `${proxied.result.error} calls=${proxyCalls.length}`,
)

const fellBack = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    if (url === githubArchiveUrl('9.9.9')) throw new TypeError('fetch failed')
    if (url === codeloadTarballUrl('9.9.9')) {
      return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
    }
    return { ok: false, status: 404, headers: { get: () => '' } }
  },
})
check(
  'github.com 连不上时改下 codeload，仍然不碰第三方镜像',
  fellBack.result.ok === true &&
    fellBack.result.tag === 'v9.9.9' &&
    fellBack.calls.some((call) => call.url === githubArchiveUrl('9.9.9')) &&
    fellBack.calls.some((call) => call.url === codeloadTarballUrl('9.9.9')) &&
    !fellBack.calls.some((call) => /ghproxy|fastgit|gitclone|kgithub|mirror\./i.test(call.url)),
  fellBack.calls.map((call) => call.url).join(' | '),
)

const mirrored = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    if (url.includes('ghproxy.example') || url.includes('evil.example')) {
      return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
    }
    return {
      ok: false,
      status: 302,
      headers: { get: (name) => (String(name).toLowerCase() === 'location' ? 'https://ghproxy.example/github.com/yunfengnobug/dsh-qq-bot/archive/refs/tags/v9.9.9.tar.gz' : '') },
    }
  },
})
check(
  '官方地址若跳到第三方镜像，不跟随，文案里也不出现那个地址',
  mirrored.result.ok === false &&
    mirrored.seen.length === 0 &&
    !/ghproxy\.example/.test(mirrored.result.error) &&
    !mirrored.calls.some((call) => call.url.includes('ghproxy.example')),
  `${mirrored.result.error} ${mirrored.calls.map((call) => call.url).join(' | ')}`,
)

let leakedPath = ''
const thrownInstall = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
  },
  runCommand: async (spec) => {
    leakedPath = spec.tarballPath
    throw new Error(`EPERM ${spec.tarballPath} qq-bridge-settings.json`)
  },
  scheduleRestart: async () => {
    throw new Error('should not restart')
  },
})
check(
  '安装抛错：白话，临时文件删掉，不重启',
  thrownInstall.result.stage === 'install' &&
    /安装没有成功/.test(thrownInstall.result.error) &&
    thrownInstall.result.command === installCommand('9.9.9') &&
    !thrownInstall.result.error.includes(leakedPath) &&
    !/qq-bridge-settings|EPERM/.test(thrownInstall.result.error) &&
    leakedPath !== '' &&
    !existsSync(leakedPath),
  String(thrownInstall.result.error),
)

const missingDsh = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
  },
  runCommand: async () => ({ ok: false, code: 'ENOENT' }),
})
check('找不到 dsh：告诉人自己执行 github 那条命令', missingDsh.result.stage === 'install' && /没找到 dsh/.test(missingDsh.result.error) && missingDsh.result.error.includes('github:yunfengnobug/dsh-qq-bot#v9.9.9'))

const restartFailed = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
  },
  scheduleRestart: async () => ({ ok: false, error: undefined }),
})
check(
  '装上了但没重启：说清楚已经装上，并提醒登录口令',
  restartFailed.result.ok === false &&
    restartFailed.result.stage === 'restart' &&
    restartFailed.result.installed === true &&
    /已经装上/.test(restartFailed.result.error) &&
    /登录口令/.test(restartFailed.result.error) &&
    !/TypeError|\n\s+at /.test(restartFailed.result.error),
  String(restartFailed.result.error),
)

const target = chooseApplyTarget({ current: '0.2.3', releases: releasesOf('v9.9.9'), version: '9.9.9' })
check(
  '选定的标签在 GitHub 这条路上给人看 github:，下载先用 github.com，备用才是 codeload',
  target.ok === true &&
    target.channel === 'github' &&
    target.install.startsWith('github:') &&
    target.tarballUrl === githubArchiveUrl('9.9.9') &&
    target.fallbackUrl === codeloadTarballUrl('9.9.9') &&
    !target.url.includes('evil.example'),
)

check('官方 registry 是默认值，不把镜像写进默认地址', NPM_REGISTRY === 'https://registry.npmjs.org/' && !String(NPM_REGISTRY).includes('npmmirror') && !String(NPM_REGISTRY).includes('ghproxy'))
check(
  'registry 只接受没有路径的 https',
  normalizeRegistry('https://registry.npmjs.org') === 'https://registry.npmjs.org/' &&
    normalizeRegistry('https://registry.npmmirror.com/') === 'https://registry.npmmirror.com/' &&
    normalizeRegistry('http://registry.npmjs.org/') === '' &&
    normalizeRegistry('https://user:s3cret@registry.npmjs.org/') === '' &&
    normalizeRegistry('https://ghproxy.example/github.com/') === '',
)
check(
  'npm 安装命令是包名加版本',
  npmInstallSpec('v9.9.9') === '@fengye_nobug/dsh-qq-bot@9.9.9' &&
    npmInstallCommand('9.9.9') === 'dsh plugin --profile web add @fengye_nobug/dsh-qq-bot@9.9.9' &&
    npmInstallSpec('9.9.9-rc.1') === '' &&
    npmInstallSpec('9.9.9;rm') === '' &&
    npmInstallSpec('9.9.9', 'dsh-qq-bot') === '' &&
    npmPackageUrl() === 'https://registry.npmjs.org/@fengye_nobug%2Fdsh-qq-bot',
)
const npmAdd = dshPluginAddSpec({ packageSpec: '@fengye_nobug/dsh-qq-bot@9.9.9', platform: 'linux' })
check(
  'Linux 上优先 dsh plugin add 这个 npm 包',
  npmAdd.command === 'dsh' && npmAdd.shell === false && npmAdd.args.join(' ') === 'plugin --profile web add @fengye_nobug/dsh-qq-bot@9.9.9',
)
let badSpec = false
try {
  dshPluginAddSpec({ packageSpec: 'dsh-qq-bot@9.9.9', platform: 'linux' })
} catch (error) {
  badSpec = error?.code === 'bad-package'
}
check('无作用域包名和夹命令的说明都不交给 dsh', badSpec)

const npmPack = fakeFetch((url) => {
  if (url === npmPackageUrl()) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ versions: { '0.2.4': { version: '0.2.4' }, '9.9.9': { version: '9.9.9' }, '9.9.9-rc.1': { version: '9.9.9-rc.1' } } }),
    }
  }
  throw new Error(`不该访问 ${url}`)
})
const npmChecked = await checkPluginUpdate({ current: '0.2.3', fetchImpl: npmPack.fetchImpl })
check(
  'npm 上有新版时不再问 GitHub',
  npmChecked.ok === true &&
    npmChecked.updateAvailable === true &&
    npmChecked.latest === '9.9.9' &&
    npmChecked.install === '@fengye_nobug/dsh-qq-bot@9.9.9' &&
    npmChecked.command === npmInstallCommand('9.9.9') &&
    npmChecked.message.includes('从 npm 装上') &&
    !npmChecked.message.includes('github:') &&
    npmPack.calls.length === 1,
  npmChecked.message,
)

const viaNpm = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url === npmPackageUrl()) {
      return { ok: true, status: 200, json: async () => ({ versions: { '9.9.9': { version: '9.9.9' } } }) }
    }
    throw new Error(`不该访问 ${url}`)
  },
  runCommand: async (spec) => ({ ok: spec.packageSpec === '@fengye_nobug/dsh-qq-bot@9.9.9' && spec.tarballPath == null, code: 0 }),
})
check(
  '有新版：先装 npm 上的包，不下载 GitHub',
  viaNpm.result.ok === true &&
    viaNpm.result.channel === 'npm' &&
    viaNpm.result.install === '@fengye_nobug/dsh-qq-bot@9.9.9' &&
    viaNpm.result.command === npmInstallCommand('9.9.9') &&
    /已经装上 v9.9.9/.test(viaNpm.result.message) &&
    /从 npm 装的/.test(viaNpm.result.message) &&
    /没有改动 NapCat/.test(viaNpm.result.message) &&
    viaNpm.seen.length === 1 &&
    viaNpm.seen[0].packageSpec === '@fengye_nobug/dsh-qq-bot@9.9.9' &&
    viaNpm.seen[0].profile === 'web' &&
    !viaNpm.calls.some((call) => /github\.com|codeload|ghproxy|npmmirror/.test(call.url)),
  JSON.stringify({ message: viaNpm.result.message, urls: viaNpm.calls.map((call) => call.url) }),
)

const npmMissThenGithub = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url === npmPackageUrl()) {
      return { ok: true, status: 200, json: async () => ({ versions: { '9.9.9': { version: '9.9.9' } } }) }
    }
    if (url === githubArchiveUrl('9.9.9')) {
      return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
    }
    throw new Error(`不该访问 ${url}`)
  },
  runCommand: async (spec) => {
    if (spec.packageSpec) return { ok: false, code: 'unpublished' }
    return { ok: Boolean(spec.tarballPath), code: 0 }
  },
})
check(
  'registry 里临时没有这个版本时改从 GitHub 官方源码包装',
  npmMissThenGithub.result.ok === true &&
    npmMissThenGithub.result.channel === 'github' &&
    npmMissThenGithub.result.install === 'github:yunfengnobug/dsh-qq-bot#v9.9.9' &&
    /从 GitHub 装上/.test(npmMissThenGithub.result.message) &&
    npmMissThenGithub.seen.length === 2 &&
    npmMissThenGithub.seen[0].packageSpec === '@fengye_nobug/dsh-qq-bot@9.9.9' &&
    String(npmMissThenGithub.seen[1].tarballPath).endsWith('dsh-qq-bot-9.9.9.tgz') &&
    npmMissThenGithub.calls.some((call) => call.url === githubArchiveUrl('9.9.9')) &&
    !npmMissThenGithub.calls.some((call) => /ghproxy|npmmirror|codeload/.test(call.url)),
)

const unpublished = await queryNpmVersions({
  fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) }),
})
check('npm 404 表示包还没发布', unpublished.ok === false && unpublished.code === 'unpublished')

const redirectedRegistry = await queryNpmVersions({
  fetchImpl: async (url) => {
    if (String(url).includes('ghproxy.example')) throw new Error('跟着跳走了')
    return { ok: false, status: 302, headers: { get: () => 'https://ghproxy.example/dsh-qq-bot' } }
  },
})
check('registry 跳到别的网站就不跟', redirectedRegistry.ok === false && redirectedRegistry.code === 'network')

const profileSample = [
  '# 用户覆盖',
  '- id: qq-bridge',
  '  name: dsh-qq-bot  # 旧包名',
  '  config:',
  "    onebotUrl: 'ws://127.0.0.1:3001'",
  "    nicknames: ['244', '小助手']",
  '- id: other-plugin',
  '  name: dsh-qq-bot',
  '  config:',
  '    keep: true',
].join('\n') + '\n'
const rewritten = rewriteCordisPackageName(profileSample, '@fengye_nobug/dsh-qq-bot')
check(
  '只改 qq-bridge 的旧包名，config 和别的插件不动',
  rewritten.changed === true &&
    rewritten.text.includes("name: '@fengye_nobug/dsh-qq-bot' # 旧包名") &&
    rewritten.text.includes("onebotUrl: 'ws://127.0.0.1:3001'") &&
    rewritten.text.includes("nicknames: ['244', '小助手']") &&
    rewritten.text.includes('- id: other-plugin\n  name: dsh-qq-bot'),
  rewritten.text,
)
const keptDev = rewriteCordisPackageName('- id: qq-bridge\n  name: ./local-dev\n  config:\n    keep: 1\n', '@fengye_nobug/dsh-qq-bot')
check('qq-bridge 上不是我们的包名时不改', keptDev.changed === false && keptDev.text.includes('name: ./local-dev'))
const alreadyScoped = "- id: qq-bridge\n  name: '@fengye_nobug/dsh-qq-bot'\n"
check('已经是作用域包名时原样返回', rewriteCordisPackageName(alreadyScoped, '@fengye_nobug/dsh-qq-bot').changed === false)
check('不把别的字符串写进 name', rewriteCordisPackageName(profileSample, 'not a package').changed === false)
check(
  'profile 目录只拼合法的 profile 名',
  profileDirectory('/dsh', 'web').endsWith('/profiles/web') && profileDirectory('/dsh', '../web') === '' && profileDirectory('', 'web') === '',
)

const alignRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-align-'))
const alignProfile = profileDirectory(alignRoot, 'web')
const alignPkg = join(alignProfile, 'node_modules', '@fengye_nobug', 'dsh-qq-bot')
mkdirSync(alignPkg, { recursive: true })
writeFileSync(
  join(alignPkg, 'package.json'),
  JSON.stringify({
    name: '@fengye_nobug/dsh-qq-bot',
    version: '9.9.9',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }),
)
const pluginPatch = "- insert:\n    - id: qq-bridge\n      name: dsh-qq-bridge\n      config:\n        targetSessionId: ''\n"
writeFileSync(join(alignPkg, 'cordis.patch.yml'), pluginPatch)
writeFileSync(join(alignProfile, 'cordis.patch.yml'), profileSample)
writeFileSync(join(alignRoot, 'cordis.patch.yml'), '- id: qq-bridge\n  name: "dsh-qq-bot"\n  config:\n    statePath: \'\'\n')
const aligned = alignCordisNames({ profileDir: alignProfile, home: alignRoot })
const pluginAfter = readFileSync(join(alignPkg, 'cordis.patch.yml'), 'utf8')
const profileAfter = readFileSync(join(alignProfile, 'cordis.patch.yml'), 'utf8')
const homeAfter = readFileSync(join(alignRoot, 'cordis.patch.yml'), 'utf8')
check(
  '安装目录、profile 和 home 三处都改成实际包名',
  aligned.ok === true &&
    aligned.name === '@fengye_nobug/dsh-qq-bot' &&
    aligned.changed.length === 3 &&
    pluginAfter.includes("name: '@fengye_nobug/dsh-qq-bot'") &&
    pluginAfter.includes("targetSessionId: ''") &&
    profileAfter.includes("name: '@fengye_nobug/dsh-qq-bot' # 旧包名") &&
    profileAfter.includes('name: dsh-qq-bot', profileAfter.indexOf('other-plugin')) &&
    homeAfter.includes("name: '@fengye_nobug/dsh-qq-bot'"),
  JSON.stringify({ changed: aligned.changed.length, pluginAfter, homeAfter }),
)
const untouched = alignCordisNames({ profileDir: alignProfile, home: alignRoot })
check('包名已经对齐时不再改文件', untouched.changed.length === 0 && readFileSync(join(alignPkg, 'cordis.patch.yml'), 'utf8') === pluginAfter)

const legacyRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-legacy-'))
const legacyProfile = profileDirectory(legacyRoot, 'web')
const legacyPkg = join(legacyProfile, 'node_modules', 'dsh-qq-bot')
mkdirSync(legacyPkg, { recursive: true })
writeFileSync(join(legacyPkg, 'package.json'), JSON.stringify({ name: 'dsh-qq-bot', version: '0.2.3' }))
writeFileSync(join(legacyPkg, 'cordis.patch.yml'), "- insert:\n    - id: qq-bridge\n      name: '@fengye_nobug/dsh-qq-bot'\n")
writeFileSync(join(legacyProfile, 'cordis.patch.yml'), '- id: qq-bridge\n  name: \'@fengye_nobug/dsh-qq-bot\'\n')
const legacyAligned = alignCordisNames({ profileDir: legacyProfile, expectedVersion: '0.2.3' })
check(
  '磁盘上仍是无作用域包时，name 改回那个包名',
  legacyAligned.name === 'dsh-qq-bot' &&
    readFileSync(join(legacyPkg, 'cordis.patch.yml'), 'utf8').includes("name: 'dsh-qq-bot'") &&
    readFileSync(join(legacyProfile, 'cordis.patch.yml'), 'utf8').includes("name: 'dsh-qq-bot'"),
)
const versionMiss = alignCordisNames({ profileDir: legacyProfile, expectedVersion: '9.9.9' })
check('版本对不上就不改包名', versionMiss.reason === 'version' && versionMiss.changed.length === 0)

writeFileSync(join(alignPkg, 'cordis.patch.yml'), pluginPatch)
writeFileSync(join(alignProfile, 'cordis.patch.yml'), profileSample)
writeFileSync(join(alignRoot, 'cordis.patch.yml'), '- id: qq-bridge\n  name: "dsh-qq-bot"\n  config:\n    statePath: \'\'\n')
const appliedAlign = await applyWith({
  current: '0.2.3',
  onFetch: (url) => {
    if (url === npmPackageUrl()) {
      return { ok: true, status: 200, json: async () => ({ versions: { '9.9.9': { version: '9.9.9' } } }) }
    }
    throw new Error(`不该访问 ${url}`)
  },
  runCommand: async (spec) => {
    if (spec.packageSpec !== '@fengye_nobug/dsh-qq-bot@9.9.9') return { ok: false, code: 'error' }
    return { ok: true, code: 0 }
  },
})
const appliedWithHome = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  home: alignRoot,
  profile: 'web',
  fetchImpl: async (url) => {
    if (String(url) === npmPackageUrl()) {
      return { ok: true, status: 200, json: async () => ({ versions: { '9.9.9': { version: '9.9.9' } } }) }
    }
    throw new Error(`不该访问 ${url}`)
  },
  runCommand: async () => ({ ok: true, code: 0 }),
  scheduleRestart: async () => ({ ok: true, mode: 'reexec' }),
})
check(
  '一键安装成功后说明 Cordis 包名已改成实际安装的包',
  appliedWithHome.ok === true &&
    appliedWithHome.channel === 'npm' &&
    /已经装上 v9.9.9/.test(appliedWithHome.message) &&
    /Cordis 里 qq-bridge 的包名已经改成实际安装的 @fengye_nobug\/dsh-qq-bot/.test(appliedWithHome.message) &&
    /没有改动 NapCat/.test(appliedWithHome.message) &&
    appliedAlign.result.ok === true &&
    !/Cordis 里 qq-bridge/.test(appliedAlign.result.message),
  appliedWithHome.message,
)
rmSync(alignRoot, { recursive: true, force: true })
rmSync(legacyRoot, { recursive: true, force: true })

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function npmReady(version = '9.9.9') {
  return async (url) => {
    if (String(url) === npmPackageUrl()) {
      return { ok: true, status: 200, json: async () => ({ versions: { [version]: { version } } }) }
    }
    throw new Error(`不该访问 ${url}`)
  }
}

function plantScoped(root, version) {
  const profile = profileDirectory(root, 'web')
  const pkgDir = join(profile, 'node_modules', '@fengye_nobug', 'dsh-qq-bot')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@fengye_nobug/dsh-qq-bot', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  const patch = "- insert:\n    - id: qq-bridge\n      name: dsh-qq-bot\n      config:\n        targetSessionId: ''\n"
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), patch)
  writeFileSync(join(profile, 'cordis.patch.yml'), "- id: qq-bridge\n  name: dsh-qq-bot\n  config:\n    keep: 1\n")
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: qq-bridge\n  name: "dsh-qq-bot"\n  config:\n    statePath: \'\'\n')
  return profile
}

function writeRunRecord(profile, pid, grouped = false) {
  const dir = join(profile, '.plugin-manager')
  mkdirSync(dir, { recursive: true })
  writeFileSync(runRecordPath(profile), `${JSON.stringify({ pid, grouped })}\n`)
}

function hangSpawn(pid, sink = {}) {
  return (command, args, options) => {
    const handlers = {}
    const child = {
      pid,
      stdout: { on() {} },
      stderr: { on() {} },
      on(name, fn) {
        handlers[name] = fn
        return child
      },
      kill() {},
      unref() {},
    }
    sink.handlers = handlers
    sink.options = options
    sink.calls = (sink.calls || 0) + 1
    sink.command = command
    sink.args = args
    return child
  }
}

check('安装记录只认整数 pid 和 grouped', parseRunRecord('{"pid":4242,"grouped":false}\n')?.pid === 4242 && parseRunRecord('{"pid":1,"grouped":true}') === null && parseRunRecord('{') === null)

const recordRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-run-'))
const recordProfile = profileDirectory(recordRoot, 'web')
mkdirSync(join(recordProfile, '.plugin-manager'), { recursive: true })
writeFileSync(runRecordPath(recordProfile), '{not-json')
const badCleared = clearStaleRunRecord(recordProfile, {
  alive() {
    throw new Error('读不懂的记录不该探测进程')
  },
})
check(
  '读不懂的安装记录会删掉，而且不去探测进程',
  badCleared.invalid === true && badCleared.removed === true && !existsSync(runRecordPath(recordProfile)),
)
writeRunRecord(recordProfile, 4242, true)
let seenAtSpawn = null
const deadAdded = await runPluginAdd({
  packageSpec: '@fengye_nobug/dsh-qq-bot@9.9.9',
  platform: 'linux',
  profile: 'web',
  profileDir: recordProfile,
  timeoutMs: 1000,
  alive: () => false,
  kill() {},
  spawnImpl: () => {
    seenAtSpawn = existsSync(runRecordPath(recordProfile))
    return laterClose(0)()
  },
})
check('已经退出的安装记录会先删掉再启动安装', deadAdded.ok === true && seenAtSpawn === false)

writeRunRecord(recordProfile, 4242, false)
const busySink = {}
let busyRestarted = false
const busyUpdate = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  home: recordRoot,
  profile: 'web',
  timeoutMs: 80,
  fetchImpl: npmReady(),
  alive: () => true,
  kill() {
    throw new Error('还在跑的安装不该被发信号')
  },
  spawnImpl: hangSpawn(4242, busySink),
  scheduleRestart: async () => {
    busyRestarted = true
    return { ok: true }
  },
})
check(
  '已有安装进程还在跑时不再开第二个，记录留着',
  busyUpdate.ok === false &&
    busyUpdate.restarting !== true &&
    busyRestarted === false &&
    busySink.calls == null &&
    existsSync(runRecordPath(recordProfile)) &&
    /已经有一个安装进程还在跑（进程 4242）/.test(busyUpdate.message) &&
    /再点「更新」/.test(busyUpdate.message) &&
    !busyUpdate.message.includes(recordRoot) &&
    !/Error|at\s/.test(busyUpdate.message),
  busyUpdate.message,
)

const treeSignals = []
const tree = stopProcessTree(
  { pid: 4242 },
  {
    platform: 'linux',
    graceMs: 30,
    kill(target, signal) {
      treeSignals.push([target, signal])
    },
  },
)
await delay(80)
tree.stop()
check(
  '超时先停进程组，宽限后再强制停',
  treeSignals[0]?.[0] === -4242 &&
    treeSignals[0]?.[1] === 'SIGTERM' &&
    treeSignals[1]?.[0] === 4242 &&
    treeSignals[1]?.[1] === 'SIGTERM' &&
    treeSignals.some(([target, signal]) => target === -4242 && signal === 'SIGKILL') &&
    treeSignals.some(([target, signal]) => target === 4242 && signal === 'SIGKILL'),
  JSON.stringify(treeSignals),
)
const winSignals = []
stopProcessTree(
  { pid: 4242, kill(signal) { winSignals.push(['child', signal]) } },
  {
    platform: 'win32',
    graceMs: 20,
    taskkill(pid) {
      winSignals.push(['taskkill', pid])
    },
  },
)
await delay(50)
check(
  'Windows 上强制停用 taskkill 结束整棵进程，不用负 pid',
  winSignals.some(([kind, signal]) => kind === 'child' && signal === 'SIGTERM') &&
    winSignals.some(([kind, pid]) => kind === 'taskkill' && pid === 4242) &&
    !winSignals.some(([target]) => typeof target === 'number' && target < 0),
  JSON.stringify(winSignals),
)

const hungRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-hang-'))
const hungProfile = plantScoped(hungRoot, '9.9.9')
const hungSignals = []
const hungSink = {}
let hungRestarted = false
const hung = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  home: hungRoot,
  profile: 'web',
  timeoutMs: 40,
  killGraceMs: 20,
  fetchImpl: npmReady(),
  alive: () => false,
  kill(target, signal) {
    hungSignals.push([target, signal])
  },
  spawnImpl: hangSpawn(4242, hungSink),
  scheduleRestart: async () => {
    hungRestarted = true
    return { ok: true }
  },
})
const hungPatch = readFileSync(join(hungProfile, 'cordis.patch.yml'), 'utf8')
const hungPlugin = readFileSync(join(hungProfile, 'node_modules', '@fengye_nobug', 'dsh-qq-bot', 'cordis.patch.yml'), 'utf8')
check(
  '安装超时但目标版本已经在磁盘上时改包名，并安排重启',
  hung.ok === true &&
    hung.restarting === true &&
    hung.channel === 'npm' &&
    hungRestarted === true &&
    hungSink.options?.detached === true &&
    hungSignals.some(([target, signal]) => target === -4242 && signal === 'SIGTERM') &&
    hungSignals.some(([target, signal]) => target === 4242 && signal === 'SIGTERM') &&
    hungSignals.some(([target, signal]) => target === -4242 && signal === 'SIGKILL') &&
    /已经装上 v9.9.9/.test(hung.message) &&
    /即将重启/.test(hung.message) &&
    /从 npm 装的/.test(hung.message) &&
    /包名已经改成实际安装的 @fengye_nobug\/dsh-qq-bot/.test(hung.message) &&
    !/请自己重启|请重启 dsh-web/.test(hung.message) &&
    hungPatch.includes("name: '@fengye_nobug/dsh-qq-bot'") &&
    hungPatch.includes('keep: 1') &&
    hungPlugin.includes("targetSessionId: ''") &&
    !hung.message.includes(hungRoot) &&
    !/Error|at\s|ENOENT/.test(hung.message),
  `${hung.message} ${JSON.stringify(hungSignals)}`,
)

const alignedRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-aligned-'))
const alignedProfile = plantScoped(alignedRoot, '9.9.9')
for (const file of [
  join(alignedProfile, 'cordis.patch.yml'),
  join(alignedProfile, 'node_modules', '@fengye_nobug', 'dsh-qq-bot', 'cordis.patch.yml'),
  join(alignedRoot, 'cordis.patch.yml'),
]) {
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('dsh-qq-bot', '@fengye_nobug/dsh-qq-bot'))
}
let alignedRestarted = false
const alignedHung = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  home: alignedRoot,
  profile: 'web',
  timeoutMs: 40,
  killGraceMs: 20,
  fetchImpl: npmReady(),
  alive: () => false,
  kill() {},
  spawnImpl: hangSpawn(4242),
  scheduleRestart: async () => {
    alignedRestarted = true
    return { ok: true, mode: 'reexec' }
  },
})
check(
  '超时且包名已经对齐时仍然重启，不再请人自己重启',
  alignedHung.ok === true &&
    alignedHung.restarting === true &&
    alignedHung.channel === 'npm' &&
    alignedRestarted === true &&
    /即将重启/.test(alignedHung.message) &&
    !/请自己重启|请重启 dsh-web/.test(alignedHung.message),
  alignedHung.message,
)

const giveUpRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-giveup-'))
plantScoped(giveUpRoot, '9.9.9')
let giveUpRestarted = false
const giveUpHung = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  home: giveUpRoot,
  profile: 'web',
  timeoutMs: 40,
  killGraceMs: 20,
  fetchImpl: npmReady(),
  alive: () => false,
  kill() {},
  spawnImpl: hangSpawn(4242),
  scheduleRestart: async () => {
    giveUpRestarted = true
    return { ok: false, error: undefined }
  },
})
check(
  '超时后版本已在磁盘上，但自动重启失败，才请人自己重启',
  giveUpHung.ok === false &&
    giveUpHung.installed === true &&
    giveUpHung.restarting !== true &&
    giveUpHung.channel === 'npm' &&
    giveUpRestarted === true &&
    /已经装上/.test(giveUpHung.message) &&
    /请自己重启/.test(giveUpHung.message) &&
    !/Error|at\s/.test(giveUpHung.message),
  giveUpHung.message,
)

const ghHungRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-gh-hang-'))
plantScoped(ghHungRoot, '9.9.9')
let ghHungRestarted = false
const ghHung = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  home: ghHungRoot,
  profile: 'web',
  timeoutMs: 40,
  killGraceMs: 20,
  fetchImpl: async (url) => {
    const href = String(url)
    if (href === npmPackageUrl()) return { ok: false, status: 404, json: async () => ({}) }
    if (href.includes('api.github.com')) return { ok: true, status: 200, json: async () => releasesOf('v9.9.9'), text: async () => '' }
    if (href === githubArchiveUrl('9.9.9')) {
      return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => tarballFor('9.9.9') }
    }
    throw new Error(`不该访问 ${href}`)
  },
  alive: () => false,
  kill() {},
  spawnImpl: hangSpawn(4242),
  scheduleRestart: async () => {
    ghHungRestarted = true
    return { ok: true, mode: 'reexec' }
  },
})
check(
  'GitHub 安装超时但目标版本已在磁盘上时也安排重启',
  ghHung.ok === true && ghHung.restarting === true && ghHung.channel === 'github' && ghHungRestarted === true && /从 GitHub 装上/.test(ghHung.message),
  ghHung.message,
)

const missRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-miss-'))
const missProfile = plantScoped(missRoot, '0.2.3')
const missed = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  home: missRoot,
  profile: 'web',
  timeoutMs: 40,
  killGraceMs: 20,
  fetchImpl: npmReady(),
  alive: () => false,
  kill() {},
  spawnImpl: hangSpawn(4242),
  scheduleRestart: async () => ({ ok: true }),
})
const missedPatch = readFileSync(join(missProfile, 'cordis.patch.yml'), 'utf8')
check(
  '超时且磁盘上还不是目标版本时不改包名，并说明没有装上',
  missed.ok === false &&
    missed.restarting !== true &&
    /没有确认装上/.test(missed.message) &&
    /清掉这次留下的安装记录/.test(missed.message) &&
    missedPatch.includes('name: dsh-qq-bot') &&
    !/包名也改成了/.test(missed.message) &&
    !missed.message.includes(missRoot),
  missed.message,
)

const leftRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-left-'))
const leftProfile = plantScoped(leftRoot, '9.9.9')
const leftBehind = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  home: leftRoot,
  profile: 'web',
  timeoutMs: 40,
  killGraceMs: 20,
  fetchImpl: npmReady(),
  alive: () => true,
  kill() {},
  spawnImpl: (command, args, options) => {
    writeRunRecord(leftProfile, 4242, false)
    return hangSpawn(4242)(command, args, options)
  },
  scheduleRestart: async () => ({ ok: true }),
})
check(
  '停不干净时留下安装记录，并请人先停掉 dsh 和 pnpm',
  leftBehind.ok === false &&
    /还没停干净/.test(leftBehind.message) &&
    /请先停掉 dsh 和 pnpm/.test(leftBehind.message) &&
    existsSync(runRecordPath(leftProfile)) &&
    readFileSync(join(leftProfile, 'cordis.patch.yml'), 'utf8').includes('name: dsh-qq-bot') &&
    !leftBehind.message.includes(leftRoot),
  leftBehind.message,
)

const otherRoot = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-other-'))
const otherProfile = profileDirectory(otherRoot, 'web')
mkdirSync(otherProfile, { recursive: true })
const otherSignals = []
const otherAdded = await runPluginAdd({
  packageSpec: '@fengye_nobug/dsh-qq-bot@9.9.9',
  platform: 'linux',
  profile: 'web',
  profileDir: otherProfile,
  timeoutMs: 40,
  killGraceMs: 20,
  alive: () => false,
  kill(target, signal) {
    otherSignals.push([target, signal])
  },
  spawnImpl: (command, args, options) => {
    writeRunRecord(otherProfile, 5252, false)
    return hangSpawn(4242)(command, args, options)
  },
})
await delay(30)
check(
  '超时后如果记录里是另一个进程，也会停掉，死记录会删掉',
  otherAdded.ok === false &&
    otherAdded.code === 'timeout' &&
    otherAdded.leftover !== true &&
    otherSignals.some(([target, signal]) => target === 5252 && signal === 'SIGTERM') &&
    otherSignals.some(([target, signal]) => target === 5252 && signal === 'SIGKILL') &&
    !otherSignals.some(([target]) => target === -5252) &&
    !existsSync(runRecordPath(otherProfile)),
  JSON.stringify(otherSignals),
)

const quickSink = {}
let quickRestarted = false
const quick = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  timeoutMs: 40,
  killGraceMs: 200,
  fetchImpl: npmReady(),
  alive: () => false,
  kill(target, signal) {
    if (signal === 'SIGTERM') quickSink.handlers?.close?.(0)
  },
  spawnImpl: hangSpawn(4242, quickSink),
  scheduleRestart: async () => {
    quickRestarted = true
    return { ok: true, mode: 'reexec' }
  },
})
check(
  '宽限期内安装进程以 0 退出仍算装上，并安排重启',
  quick.ok === true && quick.restarting === true && quickRestarted === true && /已经装上 v9.9.9/.test(quick.message),
  quick.message,
)

const autoSpawn = []
const autoRestart = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  env: {},
  execPath: '/usr/bin/node',
  argv: ['bin.js', 'web'],
  pid: 77,
  cwd: '/work',
  fetchImpl: npmReady(),
  runCommand: async () => ({ ok: true, code: 0 }),
  spawnImpl: (command, args, options) => {
    autoSpawn.push({ command, args, detached: options?.detached })
    return { on() {}, unref() {} }
  },
})
check(
  '安装成功会自己安排重启，不靠外层再传重启函数',
  autoRestart.ok === true &&
    autoRestart.restarting === true &&
    autoRestart.channel === 'npm' &&
    autoSpawn[0]?.command === '/usr/bin/node' &&
    autoSpawn[0]?.args?.[0] === '-e' &&
    autoSpawn[0]?.detached === true &&
    /即将重启/.test(autoRestart.message) &&
    !/请自己重启/.test(autoRestart.message),
  `${autoRestart.message} ${JSON.stringify(autoSpawn)}`,
)

const userSpawn = []
const userService = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  env: { INVOCATION_ID: 'run' },
  readCgroup: () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n',
  fetchImpl: npmReady(),
  runCommand: async () => ({ ok: true, code: 0 }),
  spawnImpl: (command, args, options) => {
    userSpawn.push({ command, args })
    return laterClose(0)(command, args, options)
  },
})
check(
  '安装成功且跑在用户服务里时，用 systemd-run --user 重启 dsh-web',
  userService.ok === true &&
    userService.restarting === true &&
    userSpawn[0]?.command === 'systemd-run' &&
    userSpawn[0]?.args?.includes('--user') &&
    userSpawn[0]?.args?.includes('dsh-web.service') &&
    !userSpawn[0]?.args?.includes('user@1000.service'),
  JSON.stringify(userSpawn[0]),
)

const deniedSpawn = []
const denied = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  env: { INVOCATION_ID: 'run' },
  readCgroup: () => '0::/system.slice/dsh-web.service\n',
  execPath: '/usr/bin/node',
  argv: ['bin.js', 'web'],
  pid: 88,
  cwd: '/work',
  fetchImpl: npmReady(),
  runCommand: async () => ({ ok: true, code: 0 }),
  spawnImpl: (command, args, options) => {
    deniedSpawn.push(command)
    if (command === 'systemd-run') return laterClose(1)(command, args, options)
    return { on() {}, unref() {} }
  },
})
check(
  'systemd-run 没权限时，安装成功仍按当前命令行重启',
  denied.ok === true &&
    denied.restarting === true &&
    deniedSpawn[0] === 'systemd-run' &&
    deniedSpawn[1] === '/usr/bin/node' &&
    !/请自己重启/.test(denied.message),
  `${denied.message} ${JSON.stringify(deniedSpawn)}`,
)

const sessionSpawn = []
const sessionOnly = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  env: { NOTIFY_SOCKET: '/run/systemd/notify' },
  readCgroup: () => '0::/user.slice/user-1000.slice/user@1000.service\n',
  execPath: '/usr/bin/node',
  argv: ['bin.js', 'web'],
  pid: 89,
  cwd: '/work',
  fetchImpl: npmReady(),
  runCommand: async () => ({ ok: true, code: 0 }),
  spawnImpl: (command, args) => {
    sessionSpawn.push({ command, args })
    return { on() {}, unref() {} }
  },
})
check(
  '只看见用户会话时不重启整个登录，改为拉起当前命令',
  sessionOnly.ok === true &&
    sessionOnly.restarting === true &&
    sessionSpawn[0]?.command === '/usr/bin/node' &&
    !JSON.stringify(sessionSpawn).includes('systemctl') &&
    !JSON.stringify(sessionSpawn).includes('user@1000'),
  JSON.stringify(sessionSpawn),
)

const cannot = await applyPluginUpdate({
  current: '0.2.3',
  platform: 'linux',
  env: {},
  execPath: '/usr/bin/node',
  argv: ['bin.js', 'web'],
  pid: 90,
  cwd: '/work',
  fetchImpl: npmReady(),
  runCommand: async () => ({ ok: true, code: 0 }),
  spawnImpl: () => {
    throw new Error('EPERM restart')
  },
})
check(
  '自动重启确实失败时才请人自己重启',
  cannot.ok === false &&
    cannot.installed === true &&
    cannot.restarting !== true &&
    cannot.channel === 'npm' &&
    /请自己重启 dsh-web/.test(cannot.message) &&
    !/EPERM|Error|at\s/.test(cannot.message),
  cannot.message,
)

rmSync(recordRoot, { recursive: true, force: true })
rmSync(hungRoot, { recursive: true, force: true })
rmSync(alignedRoot, { recursive: true, force: true })
rmSync(giveUpRoot, { recursive: true, force: true })
rmSync(ghHungRoot, { recursive: true, force: true })
rmSync(missRoot, { recursive: true, force: true })
rmSync(leftRoot, { recursive: true, force: true })
rmSync(otherRoot, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
