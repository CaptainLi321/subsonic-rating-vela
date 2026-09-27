/**
 * Subsonic API 客户端 (Vela quickapp)
 * - MD5 salt+token 认证 (与 dnf 版一致: t = md5(password + salt))
 * - getNowPlaying / setRating / ping
 */
import fetch from '@system.fetch'

// ── MD5 纯 JS 实现 (QuickJS 无内置 md5, 需手写) ──
// 注意: Vela 运行时是 QuickJS, 没有 node crypto, 需要纯 JS 实现
const md5 = (function () {
  // 移位表
  var s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
  var K = []
  for (var i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
  }

  function toUTF8Array(str) {
    var out = []
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i)
      if (c < 0x80) { out.push(c) }
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)) }
      else if (c < 0xd800 || c >= 0xe000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
      } else {
        i++
        c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff))
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
      }
    }
    return out
  }

  function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3]
    for (var i = 0; i < 64; i++) {
      var f, g
      if (i < 16) { f = (b & c) | ((~b) & d); g = i }
      else if (i < 32) { f = (d & b) | ((~d) & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | (~d)); g = (7 * i) % 16 }
      var temp = d
      d = c
      c = b
      b = (b + leftRotate((a + f + K[i] + k[g]) | 0, s[i])) | 0
      a = temp
    }
    x[0] = (x[0] + a) | 0
    x[1] = (x[1] + b) | 0
    x[2] = (x[2] + c) | 0
    x[3] = (x[3] + d) | 0
  }

  function leftRotate(x, n) {
    return (x << n) | (x >>> (32 - n))
  }

  function md5blk(s) {
    var md5blks = []
    for (var i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s[i] | (s[i + 1] << 8) | (s[i + 2] << 16) | (s[i + 3] << 24)
    }
    return md5blks
  }

  function add32(a, b) { return (a + b) & 0xFFFFFFFF }

  return function md5(str) {
    var bytes = toUTF8Array(str)
    var origLen = bytes.length * 8
    bytes.push(0x80)
    while (bytes.length % 64 !== 56) bytes.push(0)
    // 追加原始长度 (64-bit little-endian, 低 32 位在前)
    // 注意: JS >>> 位移量是 mod 32, 高 32 位需单独算
    var lowLen = origLen >>> 0
    var highLen = Math.floor(origLen / 0x100000000) >>> 0
    for (var i = 0; i < 4; i++) {
      bytes.push((lowLen >>> (i * 8)) & 0xFF)
    }
    for (var i = 0; i < 4; i++) {
      bytes.push((highLen >>> (i * 8)) & 0xFF)
    }
    var state = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476]
    for (var j = 0; j < bytes.length; j += 64) {
      md5cycle(state, md5blk(bytes.slice(j, j + 64)))
    }
    var hex = ''
    for (var k = 0; k < 4; k++) {
      var word = state[k]
      // MD5 输出按 little-endian 字节序 (每个 word 最低字节在前)
      for (var b = 0; b < 4; b++) {
        hex += ('0' + ((word >>> (b * 8)) & 0xFF).toString(16)).slice(-2)
      }
    }
    return hex
  }
})()

// ── 认证参数 ──
function getAuthParams(serverConfig, clientName) {
  var salt = String(Date.now()) + 'vela'
  var token = md5(serverConfig.password + salt)
  return {
    u: serverConfig.username,
    t: token,
    s: salt,
    v: '1.16.1',
    c: clientName,
    f: 'json'
  }
}

function buildUrl(serverConfig, endpoint, extraParams) {
  var params = getAuthParams(serverConfig, 'vela_remote')
  for (var key in extraParams) {
    params[key] = extraParams[key]
  }
  var qs = []
  for (var k in params) {
    qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
  }
  return serverConfig.serverUrl + '/rest/' + endpoint + '?' + qs.join('&')
}

// ── API 方法 (Promise 化) ──
// Vela fetch 回调式, 用 Promise 包装便于调用
function doRequest(url, responseType) {
  return new Promise(function (resolve, reject) {
    fetch.fetch({
      url: url,
      method: 'GET',
      responseType: responseType || 'json',
      timeout: 10000,
      success: function (res) {
        resolve(res.data)
      },
      fail: function (data, code) {
        reject({ data: data, code: code })
      }
    })
  })
}

// ping 验证
function ping(serverConfig) {
  return doRequest(buildUrl(serverConfig, 'ping')).then(function (data) {
    var json = data
    if (typeof json === 'string') {
      try { json = JSON.parse(json) } catch (e) { json = null }
    }
    return json
  })
}

// 获取正在播放
// 返回解析后的 nowPlaying.entry[] (按 username 过滤)
function getNowPlaying(serverConfig) {
  return doRequest(buildUrl(serverConfig, 'getNowPlaying')).then(function (data) {
    var json = data
    if (typeof json === 'string') {
      try { json = JSON.parse(json) } catch (e) { json = null }
    }
    var resp = json ? (json['subsonic-response'] || json.subsonicResponse) : null
    if (!resp || resp.status !== 'ok') {
      throw new Error('getNowPlaying failed: ' + (resp ? JSON.stringify(resp) : 'no response'))
    }
    var np = resp.nowPlaying || {}
    var entries = np.entry || []
    if (!Array.isArray(entries)) entries = [entries]
    // 过滤: 只显示自己的播放 (username 匹配), 若配置了则过滤
    var filtered = entries.filter(function (e) {
      if (serverConfig.username && e.username) {
        return e.username === serverConfig.username
      }
      return true
    })
    return filtered.length > 0 ? filtered[0] : null
  })
}

// 获取歌曲实时信息 (userRating 以 getSong 为准, getNowPlaying 快照可能滞后)
function getSong(serverConfig, songId) {
  return doRequest(buildUrl(serverConfig, 'getSong', {
    id: songId
  })).then(function (data) {
    var json = data
    if (typeof json === 'string') {
      try { json = JSON.parse(json) } catch (e) { json = null }
    }
    var resp = json ? (json['subsonic-response'] || json.subsonicResponse) : null
    if (!resp || resp.status !== 'ok') {
      throw new Error('getSong failed: ' + (resp ? JSON.stringify(resp) : 'no response'))
    }
    return resp.song || null
  })
}

// 评分 1-5, 0=移除
function setRating(serverConfig, songId, rating) {
  return doRequest(buildUrl(serverConfig, 'setRating', {
    id: songId,
    rating: rating
  })).then(function (data) {
    var json = data
    if (typeof json === 'string') {
      try { json = JSON.parse(json) } catch (e) { json = null }
    }
    var resp = json ? (json['subsonic-response'] || json.subsonicResponse) : null
    if (!resp || resp.status !== 'ok') {
      throw new Error('setRating failed: ' + (resp ? JSON.stringify(resp) : 'no response'))
    }
    return true
  })
}

export default {
  md5: md5,
  ping: ping,
  getNowPlaying: getNowPlaying,
  getSong: getSong,
  setRating: setRating
}
