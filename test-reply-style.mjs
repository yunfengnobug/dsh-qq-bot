// reply-style.js：只删掉已安装人设里鼓励使用 emoji 的那一句。
// 纯离线，零依赖。运行：node test-reply-style.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EMOJI_WELCOME_SENTENCE,
  installedReplyStylePath,
  packagedReplyStylePath,
  stripEmojiEncouragement,
  syncInstalledReplyStyle,
} from './reply-style.js'

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

const packaged = readFileSync(packagedReplyStylePath(), 'utf8')
const rule3 = '3. Avoid Markdown formatting. Use plain text.'
const oldRule3 = `${rule3} ${EMOJI_WELCOME_SENTENCE}`

check('包内回复风格还在', packaged.startsWith('# Reply Style\n') && packaged.includes('Put the conclusion first.'))
check('规则 3 只保留纯文本', packaged.includes(`${rule3}\n`) && !packaged.includes(EMOJI_WELCOME_SENTENCE))
check(
  '没有另加禁用表情的规矩',
  !packaged.includes('笑哭') && !packaged.includes('不要用表情') && !packaged.includes('少用') && !packaged.includes('trailing emoji'),
)
check(
  '删掉那一句之后与包内原文一致',
  stripEmojiEncouragement(packaged.replace(rule3, oldRule3)) === packaged,
)

const home = mkdtempSync(join(tmpdir(), 'qq-bridge-reply-style-'))
const target = installedReplyStylePath(home)
const upstream = packaged.replace(rule3, oldRule3)

check('人设文件不存在时不创建', syncInstalledReplyStyle(home).reason === 'missing' && !existsSync(target))
check('空的或相对的家目录不动', syncInstalledReplyStyle('').reason === 'bad-home' && syncInstalledReplyStyle('relative').reason === 'bad-home')

mkdirSync(join(target, '..'), { recursive: true })
writeFileSync(target, upstream)
const stripped = syncInstalledReplyStyle(home)
check('已安装的原文会去掉那一句', stripped.changed === true && stripped.reason === 'stripped' && readFileSync(target, 'utf8') === packaged)
check('再启动一次不再改写', syncInstalledReplyStyle(home).reason === 'unchanged' && readFileSync(target, 'utf8') === packaged)

const custom = `${upstream}\nKeep this custom line.\n`
writeFileSync(target, custom)
syncInstalledReplyStyle(home)
const customNext = readFileSync(target, 'utf8')
check('其它行还在', customNext.includes('Keep this custom line.') && customNext.includes('list only the modified file names'))
check('自定义文件也只删那一句', !customNext.includes(EMOJI_WELCOME_SENTENCE) && customNext.includes(rule3))

writeFileSync(target, '3. Avoid Markdown formatting. Use plain text.\nAlready edited.\n')
const kept = readFileSync(target, 'utf8')
check('没有那一句时整份不动', syncInstalledReplyStyle(home).changed === false && readFileSync(target, 'utf8') === kept)

rmSync(home, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
