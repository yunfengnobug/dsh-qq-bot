// 检查更新的版本比较。不连网：fetch 由用例自己提供。
// 运行：node test-updates.mjs
import {
  assessUpdate,
  checkPluginUpdate,
  compareSemver,
  failureMessage,
  installCommand,
  parseSemver,
  summarizeReleaseNotes,
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

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
