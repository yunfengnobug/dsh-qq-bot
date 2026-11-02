// 已装上的 QQ 人设不在插件目录里。
// DSH 升级插件时只换 node_modules，不会改写 $DSH_HOME/.agent-presets。
// reply-style.md 是人设安装时复制进去的。插件每次启动时，如果那份文件还在鼓励使用 emoji，
// 就只删这一句。其它行保持原样。人设目录或这份文件不存在时，不新建。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 磁盘上的相对路径，挂在 $DSH_HOME 下面。 */
export const INSTALLED_REPLY_STYLE_SEGMENTS = [
  '.agent-presets',
  'dsh-qq-bridge',
  'skills',
  'qq-session-reply-style',
  'references',
  'reply-style.md',
]

/** 要删掉的那一句。前后其它文字不动。 */
export const EMOJI_WELCOME_SENTENCE = 'Emoji are welcome when they make the answer friendlier.'

export function packagedReplyStylePath() {
  return fileURLToPath(
    new URL('./agent-presets/dsh-qq-bridge/skills/qq-session-reply-style/references/reply-style.md', import.meta.url),
  )
}

export function installedReplyStylePath(home) {
  return join(home, ...INSTALLED_REPLY_STYLE_SEGMENTS)
}

/**
 * 去掉鼓励使用 emoji 的那一句，以及它前面紧挨着的空格或制表符。
 * 不改其它字符，也不另加规矩。
 */
export function stripEmojiEncouragement(text) {
  return String(text ?? '').replaceAll(` ${EMOJI_WELCOME_SENTENCE}`, '').replaceAll(EMOJI_WELCOME_SENTENCE, '')
}

/**
 * 启动时刷新已经复制到 $DSH_HOME 的回复风格。
 * 文件不在就不创建；没有那一句就原样留下。
 * @returns {{ changed: boolean, path: string, reason: 'bad-home' | 'missing' | 'unchanged' | 'stripped' }}
 */
export function syncInstalledReplyStyle(home) {
  if (typeof home !== 'string' || !isAbsolute(home)) {
    return { changed: false, path: '', reason: 'bad-home' }
  }
  const target = installedReplyStylePath(home)
  if (!existsSync(target)) return { changed: false, path: target, reason: 'missing' }
  const current = readFileSync(target, 'utf8')
  if (!current.includes(EMOJI_WELCOME_SENTENCE)) {
    return { changed: false, path: target, reason: 'unchanged' }
  }
  const next = stripEmojiEncouragement(current)
  if (next === current) return { changed: false, path: target, reason: 'unchanged' }
  writeFileSync(target, next)
  return { changed: true, path: target, reason: 'stripped' }
}
