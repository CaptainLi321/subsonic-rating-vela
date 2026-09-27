# 红米手表 6 (Vela) Subsonic 遥控器 — 开发经验总结

> 记录完整开发过程: 调研结论、踩坑、解决方案、可用性验证
> 时间: 2026-08-10 | 产物: `dist/com.captainli.subsonic.release.1.0.0.rpk`
> 源码: 本项目根目录

---

## 一、核心结论速览

| 项 | 结论 |
|---|---|
| 平台 | Vela quickapp (JS + 类Vue `.ux`), QuickJS+LVGL 运行时 |
| 工具链 | `aiot-toolkit` 2.0.5 (npm), 无需 AIoT-IDE 图形界面, 纯命令行可完成全流程 |
| 网络 | `@system.fetch` **支持 HTTPS** (实测可连公网 frp/反代服务器) |
| 认证 | Subsonic salt+token (MD5), **纯 JS 实现 MD5** (QuickJS 无内置 crypto) |
| 轮询 | setInterval 15s + 曲目 id 缓存 (省 83% 请求) |
| 切歌 | ❌ **协议+平台双重不可行** (Subsonic 无法控制第三方客户端; Vela JS 无媒体控制 API) |
| 小部件 | ⚠️ 有 `compile lite card` 机制 (hap-toolkit), **未完全证实可用性**, 见 §七 |
| 分发 | 侧载 rpk (官方商店无个人渠道) |

---

## 二、环境与工具链 (纯命令行)

### 安装
```bash
# Node ≥18 必需
npm i -g aiot-toolkit create-aiot     # 若权限不足: --prefix ~/.local/share/npm-global
npm config get prefix                  # 确认全局 bin 在 PATH
```

### 关键命令 (aiot-toolkit 2.0.5)
```bash
aiot build          # debug 构建 → dist/*.debug.rpk
aiot release --drop-console=true       # release 构建 (去 console, 省电)
aiot start          # 交互式: 构建+启动模拟器+安装运行
aiot initEmulatorEnv   # 首次: 下载模拟器内核(~200MB)+镜像(~383MB)
aiot createVVD      # 创建虚拟设备 (交互式)
```

### 签名 (release 必需)
```bash
mkdir -p sign && cd sign
openssl req -newkey rsa:2048 -nodes -keyout private.pem -x509 -days 3650 -out certificate.pem -subj "/CN=x/OU=x/O=x"
```

### package.json scripts
```json
{ "build": "aiot build",
  "release": "aiot release --drop-console=true" }
```

---

## 三、项目结构

```
src/
├── app.ux              # 应用入口: 全局配置 ($app.$def)
├── manifest.json       # features 声明 + designWidth + background
├── common/
│   ├── images/logo.png
│   └── scripts/
│       ├── secret.js   # 凭据 (gitignore)
│       └── subsonic.js # API 客户端 (MD5 + fetch 封装)
└── pages/
    └── index/index.ux  # 唯一页面 (3行2列大按钮)
```

### manifest.json 要点
```json
{
  "features": [{ "name": "system.fetch" }, { "name": "system.vibrator" }],
  "config": {
    "designWidth": "device-width",     // 自动适配, 或写具体值如 432
    "background": { "features": ["system.fetch"] }  // 后台跑 fetch
  }
}
```
> `device-width` 模式下 1px = 1 物理像素 (432×514)。

---

## 四、踩坑记录 (重要!)

### 1. 纯 JS MD5 两个坑
- **JS 位移是 mod 32**: `origLen >>> 32` 等于 `origLen >>> 0` → 高位长度字段需单独算 (`Math.floor(origLen / 0x100000000)`)
- **输出字节序**: MD5 输出按 little-endian 每 word 最低字节在前, 不能直接 `word.toString(16)`

验证方法: 与 `crypto.createHash('md5')` 对比含中文的输入。

### 2. `fetch is not defined`
Vela 的 fetch **不是全局对象**, 必须 `import fetch from '@system.fetch'` 并在 manifest 声明 `system.fetch`。放公共模块时在模块内 import。

### 3. Vela 不支持 CSS 后代选择器
`.rate-active .rate-btn-text {}` 会报 `Selector type unsupport Descendant Selector`。
解决: 用 JS 预计算 class 字符串, 模板里拼接; 或直接给子元素加条件 class。

### 4. 模板不支持复杂嵌套三元
`class="a ? b : (c ? d : e)"` 会解析错。解决: JS 里算好放数据, 模板只引用。

### 5. 模拟器创建 VVD 有 bug
`aiot createVVD` / `aiot start` 的交互式名称校验会在 `getVvdDir` 抛 "VVD directory not found"。
**解决**: 手工创建 `~/.vela/vvd/<Name>.ini` + `<Name>.vvd/config.ini` (参考 `avdConfigIni.json` 模板, 指向已下载镜像和皮肤)。红米手表6: 皮肤 `redmi_watch` (原生 432×514), 镜像 `vela-miwear-watch-5.0`。

### 6. rpk 安装到模拟器
```bash
adb push x.rpk /data/local/tmp/
adb shell "pm install /data/local/tmp/x.rpk"    # 注意: 是 pm, 不是 android 的 install
adb shell "am start com.captainli.subsonic"    # 启动 (am stop 停止)
```
> 注意是 NuttX 的 pm/am, 用法与 Android 略不同。

### 7. 构建输出路径
`aiot build` 实际输出到**项目下 `dist/`** (不是 `~/.temp_xxx`, 那是中间产物)。

---

## 五、Subsonic API 实测结论 (Navidrome 0.61.2)

### 认证
```
u=<user>&t=md5(pass+salt)&s=<salt>&v=1.16.1&c=<client>&f=json
```
- salt 每次请求随机生成, 至少 6 字符
- token = md5(密码 + salt), 32 位小写 hex

### getNowPlaying (正在播放)
- 返回**所有用户**的播放列表, 需按 `username` 过滤
- **数据由客户端主动上报** (Tempus 通过 scrobble), 服务器不自动检测
- entry 字段: `id/title/artist/album/userRating/username/minutesAgo/playerName`
- ⚠️ **userRating 是快照**: 客户端上报时带的旧值, setRating 后不会立即更新!
  → **解决**: 拿到 songId 后再调 `getSong?id=` 获取实时评分 (每次切歌时, 同曲不重复调)

### setRating (评分)
```
setRating?id=<songId>&rating=1..5   (0=移除)
```
- 直接落库, getSong 立即反映; getNowPlaying 快照滞后

### 切歌 (❌ 不可行)
- Open Subsonic **无任何端点强制第三方客户端切歌**
- `jukeboxControl` 只对服务器本机播放 (jukebox 模式) 生效
- `savePlayQueue` 只是存档, 不触发播放
- 唯一现实路径: interconnect + 自研手机 App (见 §八)

---

## 六、耗电优化 (实测)

| 优化 | 效果 |
|---|---|
| 轮询 5s → 15s | 请求次数降 66% |
| 曲目 id 缓存 (lastSongId), 同曲不调 getSong | **总请求减少 83%** (24→4 次/分钟) |
| UI 变化检测: 曲目不变不重建不重绘 | 省 CPU/GPU |
| rateRows 静态常量 | 免每次轮询重建 |
| release 加 `--drop-console=true` | 免 flash 写日志 |
| onShow 立即 refresh (不只重启定时器) | **修复熄屏错过切歌**: 亮屏立即拉最新 |

### 生命周期正确姿势
```js
onInit()  { this.refresh() }        // 首次加载
onReady() { this.startPolling() }   // 启动轮询
onShow()  { this.refresh(); this.startPolling() }  // 亮屏立即刷新 + 重启
onHide()  { this.stopPolling() }    // 熄屏/后台停轮询
onDestroy(){ this.destroyed = true; this.stopPolling() }
```

---

## 七、marquee 滚动 (跑马灯) 实测

```xml
<marquee class="song-name" scrollamount="{{90}}" text-offset="{{90}}">{{songTitle}}</marquee>
```
- `scrollamount`: 滚动速度 (px/帧), 90 是流畅且快速的观感
- `text-offset`: **首尾相接间距** — 0 是紧贴无缝循环; 90 留出约 3-4 字符空隙方便区分
- 默认 `loop=-1` 无限循环; 文本不溢出时不滚动 (省电)
- **资源评估**: 短标题零开销; 长标题持续滚动是主动取舍 (LVGL 局部重绘优化好)

---

## 八、小部件 (Widget) 调研结论

### 存在性
- ✅ **有卡片机制**: 构建日志 "compile lite card" + `@aiot-toolkit/card-expression` (npm, v1.0.17) + `aiotpack/lib/.../LiteCard.js`
- LiteCard.js 内部调用 `hap-toolkit` 的 `compile('native', 'dev', ...)` —— 是快应用标准的卡片编译通道

### 未证实项 (需进一步调研/实测)
- 卡片如何在表盘/桌面添加 (入口在哪)
- 卡片能否 fetch 网络 + 轮询 (后台限制: 官方仅允许 `system.audio/request/geolocation` 后台运行)
- 卡片能否响应点击跳转/评分
- 红米手表6 侧载 quickapp 能否带卡片
- 官方文档站 iot.mi.com 无 card/widget 章节 (搜不到), 疑似卡片功能**未对个人开发者开放文档**

### 现实评估
- 若卡片支持网络请求: 可行, 但需自己逆向 `hap-toolkit` 卡片语法 (无文档, 成本高)
- 若卡片仅静态/无网络: 只能显示, 无法评分, 价值有限
- **当前决策**: 维持"打开应用"方案; 卡片作为未来探索项 (需先确认 LiteCard 编译产物能否被手表识别)

---

## 九、其他调研结论

### 通信链路
- 手表无 Wi-Fi, fetch 走**手机蓝牙代理** (需手机在线 + 小米运动健康连接)
- 模拟器有独立 QEMU NAT 网络, 可直接连公网 — 与真机行为不同, **真机必须单独验证**

### 媒体控制 (Vela JS)
- 官方 25 个 features **无 mediaControl/AVRCP API**
- `system.audio` 只有 play/pause/stop, 只能播手表自己音频
- `system.bluetooth.ble` 红米手表6 **官方标注不支持**
- open-vela 底层有 AVRCP 但只有读元数据, 无发送命令
- **结论: 无法通过 Vela JS 控制手机播放器**

### 分发
- 官方商店: 个人开发者无公开上架渠道 (需商务对接, 邮件联系小米)
- 社区: 米坛表盘自定义工具支持 REDMI Watch 6 侧载 rpk

---

## 十、快速参考: 复现构建

```bash
cd /path/to/subsonic-rating-vela
npm i                                # 依赖 (aiot-toolkit)
npm run build                        # debug rpk
npm run release                      # release rpk (签名+去console)
# 模拟器: aiot start → y (运行 Vela_Subsonic)
# 部署: adb push + pm install + am start (见 §四.6)
```

### 修改凭据/服务器
1. 复制 `src/common/scripts/config.example.js` 为 `src/common/scripts/config.js`
2. 在 `config.js` 中填写 `serverUrl` / `username` / `password`
3. 执行 `npm run release`

> ⚠️ **发布提示**: 本地编译生成的 `.rpk` 文件会将 `config.js` 中的服务器地址与密码打包进包体（解压 zip 即可见）。切勿将包含真实个人凭据的 `.rpk` 文件上传至 GitHub Release 或公开群组分发。

---

## 十一、验证记录 (2026-08-10 实测)

- ✅ 纯 JS MD5 与 node crypto 一致 (含中文/特殊字符)
- ✅ 认证 + getNowPlaying 直连 frp HTTPS 服务器
- ✅ 模拟器应用: 启动→渲染→15s 轮询→实时显示歌曲+评分→切歌跟随
- ✅ getSong 实时评分合并 (解决快照滞后)
- ✅ setRating 落库 (getSong 验证)
- ✅ 耗电优化: 83% 请求减少
- ✅ onShow 立即刷新 (熄屏恢复立即更新)
- ✅ marquee text-offset=90 间距 (紧贴→留空隙)
