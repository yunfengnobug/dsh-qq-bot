// faces.js — 出站把「[笑哭]」这类表情名拆成 OneBot face 段。
//
// id 对齐 OneBot / CoolQ 的 face 表，以及 QQ 客户端里的系统表情：
// 笑哭 = 182，挥手 = 129。对不上的方括号保持文字，不猜。
// 纯数据 + 纯函数，方便测试；发送仍由 sendToQQ 负责。

/** @type {Array<[string, number]>} */
const FACE_ENTRIES = [
  // OneBot / CoolQ face id。笑哭、挥手与 QQ 系统表情编号一致。
  ['惊讶', 0],
  ['撇嘴', 1],
  ['色', 2],
  ['发呆', 3],
  ['得意', 4],
  ['流泪', 5],
  ['害羞', 6],
  ['闭嘴', 7],
  ['睡', 8],
  ['大哭', 9],
  ['尴尬', 10],
  ['发怒', 11],
  ['调皮', 12],
  ['呲牙', 13],
  ['微笑', 14],
  ['难过', 15],
  ['酷', 16],
  ['抓狂', 18],
  ['吐', 19],
  ['偷笑', 20],
  ['可爱', 21],
  ['白眼', 22],
  ['傲慢', 23],
  ['饥饿', 24],
  ['困', 25],
  ['惊恐', 26],
  ['流汗', 27],
  ['憨笑', 28],
  ['大兵', 29],
  ['奋斗', 30],
  ['咒骂', 31],
  ['疑问', 32],
  ['嘘', 33],
  ['晕', 34],
  ['折磨', 35],
  ['衰', 36],
  ['骷髅', 37],
  ['敲打', 38],
  ['再见', 39],
  ['发抖', 41],
  ['爱情', 42],
  ['跳跳', 43],
  ['猪头', 46],
  ['拥抱', 49],
  ['蛋糕', 53],
  ['闪电', 54],
  ['炸弹', 55],
  ['刀', 56],
  ['足球', 57],
  ['便便', 59],
  ['咖啡', 60],
  ['饭', 61],
  ['玫瑰', 63],
  ['凋谢', 64],
  ['爱心', 66],
  ['心碎', 67],
  ['礼物', 69],
  ['太阳', 74],
  ['月亮', 75],
  ['强', 76],
  ['弱', 77],
  ['握手', 78],
  ['胜利', 79],
  ['飞吻', 85],
  ['怄火', 86],
  ['西瓜', 89],
  ['冷汗', 96],
  ['擦汗', 97],
  ['抠鼻', 98],
  ['鼓掌', 99],
  ['糗大了', 100],
  ['坏笑', 101],
  ['左哼哼', 102],
  ['右哼哼', 103],
  ['哈欠', 104],
  ['鄙视', 105],
  ['委屈', 106],
  ['快哭了', 107],
  ['阴险', 108],
  ['亲亲', 109],
  ['吓', 110],
  ['可怜', 111],
  ['菜刀', 112],
  ['啤酒', 113],
  ['篮球', 114],
  ['乒乓', 115],
  ['示爱', 116],
  ['瓢虫', 117],
  ['抱拳', 118],
  ['勾引', 119],
  ['拳头', 120],
  ['差劲', 121],
  ['爱你', 122],
  ['NO', 123],
  ['OK', 124],
  ['转圈', 125],
  ['磕头', 126],
  ['回头', 127],
  ['跳绳', 128],
  ['挥手', 129],
  ['激动', 130],
  ['街舞', 131],
  ['献吻', 132],
  ['左太极', 133],
  ['右太极', 134],
  ['双喜', 136],
  ['鞭炮', 137],
  ['灯笼', 138],
  ['K歌', 140],
  ['喝彩', 144],
  ['祈祷', 145],
  ['爆筋', 146],
  ['棒棒糖', 147],
  ['喝奶', 148],
  ['飞机', 151],
  ['钞票', 158],
  ['药', 168],
  ['手枪', 169],
  ['茶', 171],
  ['眨眼睛', 172],
  ['泪奔', 173],
  ['无奈', 174],
  ['卖萌', 175],
  ['小纠结', 176],
  ['喷血', 177],
  ['斜眼笑', 178],
  ['doge', 179],
  ['惊喜', 180],
  ['骚扰', 181],
  ['笑哭', 182],
  ['我最美', 183],
  ['河蟹', 184],
  ['羊驼', 185],
  ['幽灵', 187],
  ['蛋', 188],
  ['菊花', 190],
  ['红包', 192],
  ['大笑', 193],
  ['不开心', 194],
  ['冷漠', 197],
  ['呃', 198],
  ['好棒', 199],
  ['拜托', 200],
  ['点赞', 201],
  ['无聊', 202],
  ['托脸', 203],
  ['吃', 204],
  ['送花', 205],
  ['害怕', 206],
  ['花痴', 207],
  ['小样儿', 208],
  ['飙泪', 210],
  ['我不看', 211],
  ['托腮', 212],
  // 客户端面板上的叫法和 CoolQ 旧表不一样，两个都认。
  ['悠闲', 29],
  ['赞', 76],
  ['踩', 77],
  ['左亲亲', 109],
  // QQ 系统表情里后来常用、旧表没列的。
  ['啵啵', 214],
  ['蹭一蹭', 219],
  ['抱抱', 222],
  ['拍手', 227],
  ['佛系', 232],
  ['喷脸', 240],
  ['甩头', 243],
  ['加油抱抱', 246],
  ['脑阔疼', 262],
  ['捂脸', 264],
  ['辣眼睛', 265],
  ['哦哟', 266],
  ['头秃', 267],
  ['问号脸', 268],
  ['暗中观察', 269],
  ['emm', 270],
  ['吃瓜', 271],
  ['呵呵哒', 272],
  ['我酸了', 273],
  ['汪汪', 277],
  ['汗', 278],
  ['无眼笑', 281],
  ['敬礼', 282],
  ['面无表情', 284],
  ['摸鱼', 285],
  ['哦', 287],
  ['睁眼', 289],
  ['敲开心', 290],
  ['摸锦鲤', 293],
  ['期待', 294],
  ['拜谢', 297],
  ['元宝', 298],
  ['牛啊', 299],
  ['右亲亲', 305],
  ['牛气冲天', 306],
  ['喵喵', 307],
  ['仔细分析', 314],
  ['加油', 315],
  ['崇拜', 318],
  ['比心', 319],
  ['庆祝', 320],
  ['拒绝', 322],
  ['吃糖', 324],
  ['生气', 326],
]

/** @type {Record<string, number>} */
export const FACE_NAME_TO_ID = Object.create(null)
/** @type {Map<string, number>} */
const FACE_LOOKUP = new Map()

for (const [name, id] of FACE_ENTRIES) {
  const key = String(name).trim().toLowerCase()
  if (!key || FACE_LOOKUP.has(key)) throw new Error(`faces.js：表情名重复（${name}）`)
  if (!Number.isInteger(id) || id < 0) throw new Error(`faces.js：表情 id 不合法（${name}=${id}）`)
  FACE_LOOKUP.set(key, id)
  FACE_NAME_TO_ID[name] = id
}
Object.freeze(FACE_NAME_TO_ID)

/** 把数字串收成十进制 id。空、非数字、过长都返回 null。 */
function canonicalFaceId(digits) {
  if (!/^\d{1,10}$/.test(digits)) return null
  const n = Number(digits)
  if (!Number.isSafeInteger(n)) return null
  return String(n)
}

/**
 * 方括号里的内容是不是一个系统表情。
 * 认三种写法：表情名、`表情182`（入站占位符）、`CQ:face,id=182`。
 * @param {string} raw
 * @returns {string | null}
 */
function faceIdFromBracket(raw) {
  const inner = String(raw).trim()
  if (inner === '') return null
  const byLabel = /^表情\s*(\d+)$/.exec(inner)
  if (byLabel) return canonicalFaceId(byLabel[1])
  const cq = /^cq:face\b([\s\S]*)$/i.exec(inner)
  if (cq) {
    const id = /(?:^|,)\s*id\s*=\s*(\d+)\s*(?:,|$)/i.exec(cq[1])
    return id ? canonicalFaceId(id[1]) : null
  }
  const named = FACE_LOOKUP.get(inner.toLowerCase())
  return named === undefined ? null : String(named)
}

/**
 * 把出站正文拆成有序的 OneBot 消息段。
 *
 * - `[笑哭]` → `{ type:'face', data:{ id:'182' } }`
 * - `[表情182]`、`[CQ:face,id=182]` 同样是 face 段
 * - 对不上的 `[…]` 留在 text 段里，不另起一段
 * - 纯文本返回恰好一段 text；空串返回 []
 *
 * id 用字符串：NapCat 的 face 段把 id 定义成 string。
 * @param {string} body
 * @returns {Array<{ type: string, data: Record<string, string> }>}
 */
export function textToOneBotSegments(body) {
  const text = String(body ?? '')
  if (text === '') return []
  const segments = []
  let cursor = 0
  for (const match of text.matchAll(/\[([^\[\]]*)\]/g)) {
    const id = faceIdFromBracket(match[1])
    if (id === null) continue
    const start = match.index ?? 0
    if (start > cursor) segments.push({ type: 'text', data: { text: text.slice(cursor, start) } })
    segments.push({ type: 'face', data: { id } })
    cursor = start + match[0].length
  }
  if (cursor < text.length) segments.push({ type: 'text', data: { text: text.slice(cursor) } })
  return segments
}
