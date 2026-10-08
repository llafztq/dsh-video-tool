# dsh-video-tool

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加上**真正的视频剪辑能力**。装上之后，AI 可以直接裁剪、拼接、配音、烧字幕、变速、转码、抽帧，并把抽出的画面用 `read_image` "看"回来。

引擎是 **ffmpeg / ffprobe**，**不随包分发**：首次使用时自动下载到 `<DSH_HOME>/video-tool/bin/` 并缓存（约 60 MB）。这样仓库保持几百 KB，也避免把 GPL 二进制塞进你的 clone。

---

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-video-tool
```

装完**完整重启 DSH**。第一次调用任意 `video_*` 工具时会自动下载引擎；也可以先跑一次 `video_setup` 显式安装。

> ⚠️ 用 `link:` 安装时，插件目录必须位于 profile 目录树内，或者被 link 的包要把
> `@deepseek-ai/dsh-tools` 声明为 `peerDependency`——DSH 只在满足这两个条件之一时，
> 才会把包内的裸导入转发到 DSH 安装目录。

## 工具一览

| 工具 | 作用 |
|---|---|
| `video_setup` | 检查/下载 ffmpeg 引擎，报告安装位置与版本 |
| `video_probe` | 读时长、分辨率、**旋转标记**、帧率、编码、码率、音轨 |
| `video_trim` | 裁剪片段（`start` + `end` 或 `duration`） |
| `video_concat` | 多段拼接，`safe` 模式自动统一分辨率/帧率/音轨 |
| `video_audio` | 静音 / 换 BGM / 混音 / 调音量 / 淡入淡出（视频流直接复制） |
| `video_text` | 烧录文字、水印、`.srt`/`.ass` 字幕 |
| `video_transform` | 缩放 / 裁剪 / 旋转 / 变速 / 改帧率 |
| `video_export` | 导出 mp4 / webm / gif / mp3 / m4a / wav |
| `video_frame` | 抽帧截图（png/jpg），可直接被 `read_image` 查看 |

## 引擎解析顺序

1. 环境变量 `DSH_FFMPEG_PATH` / `FFMPEG_PATH`
2. 插件目录下的 `bin/`
3. `<DSH_HOME>/video-tool/bin/`（自动下载的落点）
4. 系统 `PATH`
5. 常见安装目录（winget / chocolatey / scoop / `C:\ffmpeg`）

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 主目录，默认 `~/.dsh` |
| `DSH_VIDEO_TOOL_HOME` | 覆盖引擎安装目录，默认 `<DSH_HOME>/video-tool` |
| `DSH_FFMPEG_PATH` / `FFMPEG_PATH` | 直接指定 ffmpeg 可执行文件或其所在目录 |
| `DSH_VIDEO_TOOL_FFMPEG_BASE` | 覆盖下载源，默认用 npmmirror 的 ffmpeg-static 二进制镜像 |
| `DSH_VIDEO_TOOL_VERBOSE=1` | 把下载进度打到 stderr，便于排障 |

## 手动安装引擎

不想让它联网的话，把 `ffmpeg` / `ffprobe`（Windows 上是 `.exe`）放进
`<DSH_HOME>/video-tool/bin/`，或设好 `DSH_FFMPEG_PATH` 即可，插件不会再下载。

## 已知限制

- **特殊符号缺字形**：默认自动选中的中文字体（Windows 上为微软雅黑 `msyh.ttc`）
  没有 `✓`、`★`、emoji 等符号的字形，会渲染成空心方框 `□`；中文和常规标点不受影响。
  需要这类符号时用 `video_text` 的 `fontFile` 显式指定含该字形的字体。
  ffmpeg 的 `drawtext` 不做字体回退，一次只能用一款字体。
- 转码走 CPU（libx264）。内置/下载的是 essentials 构建，面向软件编解码，
  未启用 NVENC/QSV；长视频导出速度取决于 CPU。
- `video_transform` 的 `speed` 在 0.5x–2.0x 之外时，音频变速会被钳制在该范围
  （ffmpeg `atempo` 限制），视频变速不受影响。
- 竖屏手机素材常以「横屏存储 + rotation 标记」的形式存在。`video_probe` 会同时给出
  存储尺寸和真实显示尺寸，剪辑时按显示尺寸理解即可。
- 引擎下载默认走 npmmirror 的 ffmpeg-static 镜像（国内快）。网络不通时用
  `DSH_VIDEO_TOOL_FFMPEG_BASE` 换源，或手动放置二进制。

## 为什么不用剪映的 ffmpeg

剪映专业版自带的 `ffmpeg.exe` 是内部精简构建（`--disable-ffprobe`、无 libx264、
无 `drawtext`/`subtitles`），不能当通用剪辑引擎用。本插件用 ffmpeg-static 的
essentials 构建，`libx264` / `libvpx` / `aac` / `drawtext` / `subtitles`(libass) /
`palettegen` / `amix` / `afade` 都在。

## License

MIT。运行期下载的 FFmpeg 二进制是独立项目，遵循其自身许可（默认来源为
GPL 构建），详见 [LICENSE](./LICENSE)。

---

## English summary

`dsh-video-tool` adds a video editing toolset to DeepSeek Harness: probe, trim,
concat, audio handling, subtitle/text burn-in, transform, transcode and frame
grabbing — all backed by ffmpeg.

FFmpeg is **not bundled**. On first use the plugin downloads a static
ffmpeg/ffprobe pair into `<DSH_HOME>/video-tool/bin/` and caches it (~60 MB),
so the repository stays tiny. Point `DSH_FFMPEG_PATH` at your own binaries, or
drop them into that `bin/` directory, to skip the download entirely.

Install with `dsh plugin --profile <profile> add dsh-video-tool`, then fully
restart DSH. Run `video_setup` once to fetch the engine, or just call any
`video_*` tool and it will bootstrap itself.
