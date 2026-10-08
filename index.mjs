/**
 * dsh-video-tool — 给 DeepSeek Harness 加上真正的视频剪辑能力。
 *
 * 提供 9 个工具：引擎安装、探测、裁剪、拼接、音轨处理、字幕/文字、缩放旋转变速、
 * 导出转码、抽帧。
 *
 * 引擎是 ffmpeg / ffprobe，**不随包分发**：首次使用时自动从 CDN 下载到
 * `<DSH_HOME>/video-tool/bin/` 并缓存，之后直接复用。
 *
 * ffmpeg 解析顺序：
 *   1. 环境变量 DSH_FFMPEG_PATH / FFMPEG_PATH
 *   2. 本插件目录下的 bin/
 *   3. <DSH_HOME>/video-tool/bin/（自动下载的位置）
 *   4. 系统 PATH
 *   5. 常见安装目录（winget / chocolatey / scoop / C:\ffmpeg）
 *
 * 安装位置有硬性要求：本文件必须位于 DSH 的 profiles 目录树内，或是一个 `link:`
 * 依赖且把 @deepseek-ai/dsh-tools 声明为 peerDependency；否则 DSH 的模块拦截层
 * 不生效，下面这行 import 无法解析、插件会被打成 inactive。
 */
import { spawn } from 'node:child_process'
import {
  chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Loader identity. */
export const name = 'dsh-video-tool'
/** Services used by the video tools. */
export const inject = ['tools']

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''

/** 下载用的 ffmpeg-static 版本（npmmirror 二进制镜像上的 tag）。 */
const FFMPEG_TAG = 'b6.1.1'
const DEFAULT_BASE = `https://registry.npmmirror.com/-/binary/ffmpeg-static/${FFMPEG_TAG}`

/** 各平台在 ffmpeg-static 发布里的资产名。 */
const PLATFORM_ASSETS = {
  'win32-x64': 'win32-x64',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'linux-arm': 'linux-arm',
  'linux-ia32': 'linux-ia32',
}

// ─────────────────────────────────────────────────────────────
// 路径
// ─────────────────────────────────────────────────────────────

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

/** 自动下载的落点：DSH_HOME/video-tool（可用环境变量覆盖）。 */
function installDir() {
  return process.env.DSH_VIDEO_TOOL_HOME || path.join(dshHome(), 'video-tool')
}

function binDir() {
  return path.join(installDir(), 'bin')
}

function binPath(binName) {
  return path.join(binDir(), binName + EXE)
}

function statSafe(p) {
  try { return statSync(p) } catch { return undefined }
}

// ─────────────────────────────────────────────────────────────
// 二进制查找
// ─────────────────────────────────────────────────────────────

function pathCandidates(binName) {
  const list = []
  const envPath = process.env.DSH_FFMPEG_PATH || process.env.FFMPEG_PATH
  if (envPath) {
    const resolved = statSafe(envPath)
    if (resolved?.isDirectory()) list.push(path.join(envPath, binName + EXE))
    else list.push(envPath)
  }
  list.push(path.join(PLUGIN_DIR, 'bin', binName + EXE))
  list.push(binPath(binName))
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, binName + EXE))
  }
  const local = process.env.LOCALAPPDATA ?? ''
  const programData = process.env.ProgramData ?? ''
  const home = homedir()
  list.push(
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(local, 'Microsoft', 'WinGet', 'Links', binName + EXE),
    path.join(local, 'Programs', 'ffmpeg', 'bin', binName + EXE),
    path.join(programData, 'chocolatey', 'bin', binName + EXE),
    path.join(home, 'scoop', 'shims', binName + EXE),
    '/usr/bin/' + binName, '/usr/local/bin/' + binName, '/opt/homebrew/bin/' + binName,
  )
  return list
}

const binaryCache = new Map()

function findBinary(binName) {
  const cached = binaryCache.get(binName)
  if (cached !== undefined) {
    if (existsSync(cached)) return cached
    binaryCache.delete(binName)
  }
  for (const candidate of pathCandidates(binName)) {
    if (!candidate) continue
    if (statSafe(candidate)) { binaryCache.set(binName, candidate); return candidate }
  }
  return undefined
}

function missingBinaries() {
  return ['ffmpeg', 'ffprobe'].filter((b) => findBinary(b) === undefined)
}

function manualHint() {
  return [
    '也可以手动提供（任选一种），然后重试：',
    '  1) 调用 video_setup 工具自动下载（推荐）',
    `  2) 把 ffmpeg${EXE} / ffprobe${EXE} 放到：${binDir()}`,
    '  3) 设置环境变量 DSH_FFMPEG_PATH 指向 ffmpeg 所在目录或可执行文件',
    '  4) 用系统包管理器安装后重启 DSH（例如 winget install Gyan.FFmpeg）',
  ].join('\n')
}

function requireBinary(binName) {
  const bin = findBinary(binName)
  if (bin !== undefined) return bin
  const searched = pathCandidates(binName).filter(Boolean).slice(0, 8).map((p) => '  ' + p).join('\n')
  throw new Error(
    `找不到 ${binName}，视频工具暂时不可用。\n${manualHint()}\n已查找的位置：\n${searched}`,
  )
}

// ─────────────────────────────────────────────────────────────
// 下载
// ─────────────────────────────────────────────────────────────

/**
 * 下载一个 URL 到文件，自动跟随重定向。
 * @param {string} url 源地址。
 * @param {string} dest 落盘路径。
 * @param {{redirects?: number, timeoutMs?: number}} options 重定向上限与超时。
 * @returns {Promise<number>} 写入的字节数。
 */
function downloadFile(url, dest, options = {}) {
  const { redirects = 0, timeoutMs = 180000 } = options
  return new Promise((resolve, reject) => {
    if (redirects > 6) { reject(new Error(`重定向过多: ${url}`)); return }
    let parsed
    try { parsed = new URL(url) } catch { reject(new Error(`非法地址: ${url}`)); return }
    const mod = parsed.protocol === 'https:' ? https : http
    const request = mod.get(parsed, { headers: { 'user-agent': 'dsh-video-tool' } }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        const next = new URL(response.headers.location, parsed).toString()
        downloadFile(next, dest, { redirects: redirects + 1, timeoutMs }).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`HTTP ${status} — ${url}`))
        return
      }
      pipeline(response, createWriteStream(dest)).then(
        () => resolve(statSafe(dest)?.size ?? 0),
        reject,
      )
    })
    request.on('error', reject)
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`下载超时: ${url}`)))
  })
}

/** 解 gzip 到目标文件。 */
async function gunzipFile(src, dest) {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest))
}

/** 用 `-version` 验证一个可执行文件真的能跑。 */
async function verifyBinary(file) {
  const result = await runProcess(file, ['-version'], {})
  if (result.code !== 0) throw new Error(`${path.basename(file)} 无法运行 (exit ${result.code})`)
  const first = result.stdout.split(/\r?\n/)[0] ?? ''
  if (!/^ffmpeg version|^ffprobe version/i.test(first)) {
    throw new Error(`${path.basename(file)} 输出了非预期内容: ${first.slice(0, 120)}`)
  }
  return first.trim()
}

/**
 * 确保 ffmpeg / ffprobe 就位，缺失则从 CDN 下载并校验。
 * @param {(message: string) => void} log 进度回调。
 * @returns {Promise<{ok: boolean, installed: string[], found: object, detail: string[]}>} 结果。
 */
async function ensureBinaries(log = () => {}) {
  const missing = missingBinaries()
  if (missing.length === 0) {
    return { ok: true, installed: [], found: { ffmpeg: findBinary('ffmpeg'), ffprobe: findBinary('ffprobe') }, detail: [] }
  }

  const platformKey = `${process.platform}-${process.arch}`
  const asset = PLATFORM_ASSETS[platformKey]
  if (asset === undefined) {
    throw new Error(`当前平台 ${platformKey} 没有对应的预编译 ffmpeg 资产。\n${manualHint()}`)
  }

  const base = (process.env.DSH_VIDEO_TOOL_FFMPEG_BASE || DEFAULT_BASE).replace(/\/+$/, '')
  mkdirSync(binDir(), { recursive: true })
  const detail = []
  const installed = []

  for (const binName of missing) {
    // 镜像上的文件名是 <bin>-<platform>.gz；上游 GitHub 资产名不含 bin 前缀，两种都试。
    const urls = [`${base}/${binName}-${asset}.gz`, `${base}/${asset}.gz`]
    const gz = path.join(tmpdir(), `dsh-video-tool-${binName}-${Date.now()}.gz`)
    const target = binPath(binName)
    let lastError
    let done = false
    for (const url of urls) {
      try {
        log(`正在下载 ${binName} … ${url}`)
        const started = Date.now()
        const wrote = await downloadFile(url, gz)
        if (wrote < 100000) throw new Error(`下载内容过小 (${wrote} 字节)`)
        log(`  已下载 ${(wrote / 1048576).toFixed(1)} MB，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
        await gunzipFile(gz, target)
        if (!IS_WIN) chmodSync(target, 0o755)
        log(`  解压完成 ${((statSafe(target)?.size ?? 0) / 1048576).toFixed(1)} MB → ${target}`)
        const version = await verifyBinary(target)
        log(`  校验通过: ${version}`)
        detail.push(`${binName}: ${version}`)
        installed.push(binName)
        binaryCache.delete(binName)
        done = true
        break
      } catch (error) {
        lastError = error
        log(`  失败（尝试下一个源）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try { if (existsSync(gz)) unlinkSync(gz) } catch { /* 尽力而为 */ }
    if (!done) {
      throw new Error(
        `下载 ${binName} 失败：${lastError instanceof Error ? lastError.message : String(lastError)}\n${manualHint()}`,
      )
    }
  }

  return {
    ok: missingBinaries().length === 0,
    installed,
    found: { ffmpeg: findBinary('ffmpeg'), ffprobe: findBinary('ffprobe') },
    detail,
  }
}

const engineAttempted = { value: false }

/** 剪辑工具的统一入口：引擎缺失时自动尝试下载一次。 */
async function needEngine() {
  if (missingBinaries().length === 0) return
  if (!engineAttempted.value) {
    engineAttempted.value = true
    try {
      await ensureBinaries()
    } catch { /* 下面 requireBinary 会给出可操作的错误 */ }
  }
  if (missingBinaries().length > 0) requireBinary('ffmpeg')
}

// ─────────────────────────────────────────────────────────────
// 进程执行
// ─────────────────────────────────────────────────────────────

const MAX_CAPTURE = 400_000

/**
 * 运行一个子进程并收集输出。
 * @param {string} bin 可执行文件绝对路径。
 * @param {string[]} args 参数数组。
 * @param {{signal?: AbortSignal, cwd?: string}} options 取消信号与工作目录。
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} 进程结果。
 */
function runProcess(bin, args, options = {}) {
  const { signal, cwd } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('操作已取消')); return }
    let child
    try {
      child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { reject(error); return }
    let stdout = ''
    let stderr = ''
    let settled = false
    const onAbort = () => { try { child.kill('SIGKILL') } catch { /* 可能已退出 */ } }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) { reject(new Error('操作已取消')); return }
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}

/** 运行 ffprobe 并返回解析后的 JSON。 */
async function probeFile(input, options) {
  const ffprobe = requireBinary('ffprobe')
  const result = await runProcess(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input,
  ], options)
  if (result.code !== 0) throw new Error(`ffprobe 读取失败 (${path.basename(input)}):\n${tail(result.stderr)}`)
  try { return JSON.parse(result.stdout) } catch { throw new Error(`ffprobe 输出无法解析: ${tail(result.stdout)}`) }
}

/** 运行 ffmpeg，失败时抛出带日志尾巴的错误。 */
async function runFfmpeg(args, options) {
  const ffmpeg = requireBinary('ffmpeg')
  const result = await runProcess(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], options)
  if (result.code !== 0) throw new Error(`ffmpeg 执行失败 (exit ${result.code}):\n${tail(result.stderr)}`)
  return result
}

function tail(text, lines = 18) {
  const parts = String(text ?? '').trim().split(/\r?\n/)
  return parts.slice(-lines).join('\n')
}

// ─────────────────────────────────────────────────────────────
// 路径与时间工具
// ─────────────────────────────────────────────────────────────

function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd || process.env.DSH_WORKSPACE || process.cwd()
}

function resolvePath(p, cwd) {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

function ensureParent(file) {
  mkdirSync(path.dirname(file), { recursive: true })
}

function requireInput(p, cwd) {
  const abs = resolvePath(p, cwd)
  if (!existsSync(abs)) throw new Error(`输入文件不存在: ${abs}`)
  return abs
}

function prepareOutput(p, cwd) {
  const abs = resolvePath(p, cwd)
  ensureParent(abs)
  return abs
}

/** 把 "90" / "1:30" / "0:01:30.5" / 90.5 统一成秒。 */
function toSeconds(value, label) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') throw new Error(`${label} 需要秒数或 "hh:mm:ss" 形式，收到：${String(value)}`)
  const text = value.trim()
  if (text === '') throw new Error(`${label} 不能为空`)
  const parts = text.split(':')
  if (parts.length > 3) throw new Error(`${label} 格式错误：${text}`)
  let seconds = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isFinite(n)) throw new Error(`${label} 格式错误：${text}`)
    seconds = seconds * 60 + n
  }
  return seconds
}

/** ffmpeg 的数字格式（避免科学计数法）。 */
function num(seconds) {
  return (Math.round(seconds * 1000) / 1000).toString()
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return '未知'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const tailText = s.toFixed(2).padStart(5, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${tailText}` : `${m}:${tailText}`
}

/** drawtext 的 textfile= 需要一个安全的文本文件。 */
function writeTextFile(text) {
  const dir = path.join(tmpdir(), 'dsh-video-tool')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  writeFileSync(file, String(text), 'utf8')
  return file
}

/** filter 参数里的路径转义：反斜杠转正斜杠、转义冒号和单引号。 */
function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function pickFont() {
  const candidates = IS_WIN
    ? ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\msyhbd.ttc', 'C:\\Windows\\Fonts\\simhei.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
    : ['/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

function tempFile(suffix) {
  const dir = path.join(tmpdir(), 'dsh-video-tool')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`)
}

function cleanupTemp(files) {
  for (const file of files) {
    try { if (existsSync(file)) unlinkSync(file) } catch { /* 尽力而为 */ }
  }
}

// ─────────────────────────────────────────────────────────────
// 工具实现
// ─────────────────────────────────────────────────────────────

const textOutput = (render) => ({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(render ? render(value) : value) }],
})

async function toolSetup(args) {
  const lines = []
  lines.push('安装目录: ' + installDir())
  const before = { ffmpeg: findBinary('ffmpeg'), ffprobe: findBinary('ffprobe') }
  if (before.ffmpeg) lines.push('已有 ffmpeg : ' + before.ffmpeg)
  if (before.ffprobe) lines.push('已有 ffprobe: ' + before.ffprobe)

  let result
  if (before.ffmpeg && before.ffprobe && !args.force) {
    result = { ok: true, installed: [], found: before, detail: [] }
    lines.push('引擎已就绪，无需下载。')
  } else {
    if (args.force) {
      binaryCache.clear()
      engineAttempted.value = false
      lines.push('force=true：重新下载并覆盖。')
    }
    lines.push('开始准备 ffmpeg / ffprobe …')
    result = await ensureBinaries((message) => lines.push(message))
  }

  for (const d of result.detail ?? []) lines.push('  ' + d)
  lines.push(result.ok ? '引擎就绪 ✅' : '引擎仍不可用 ❌')
  if (result.found?.ffmpeg) lines.push('ffmpeg  : ' + result.found.ffmpeg)
  if (result.found?.ffprobe) lines.push('ffprobe : ' + result.found.ffprobe)
  if (!result.ok) lines.push(manualHint())
  return lines.join('\n')
}

async function toolProbe(args, exec) {
  await needEngine()
  const cwd = sessionCwd(exec)
  const input = requireInput(args.input, cwd)
  const info = await probeFile(input, { signal: exec.signal, cwd })
  const format = info.format ?? {}
  const streams = info.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const fps = (() => {
    if (!video?.avg_frame_rate || video.avg_frame_rate === '0/0') return undefined
    const [a, b] = video.avg_frame_rate.split('/').map(Number)
    return b ? Math.round((a / b) * 1000) / 1000 : undefined
  })()
  // 手机竖屏素材常以横屏存储 + rotation 标记；这里还原真实显示尺寸。
  const rotation = video?.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation
  const swapped = typeof rotation === 'number' && Math.abs(rotation) % 180 === 90
  const summary = {
    文件: input,
    容器: format.format_name,
    时长: Number(format.duration ?? 0),
    时长文本: humanDuration(Number(format.duration ?? 0)),
    大小字节: Number(format.size ?? 0),
    总码率: format.bit_rate ? Number(format.bit_rate) : undefined,
    视频: video ? {
      编码: video.codec_name, 宽: video.width, 高: video.height,
      旋转: rotation,
      显示宽: swapped ? video.height : video.width,
      显示高: swapped ? video.width : video.height,
      帧率: fps, 像素格式: video.pix_fmt, 码率: video.bit_rate ? Number(video.bit_rate) : undefined,
    } : null,
    音频: audio ? {
      编码: audio.codec_name, 声道: audio.channels, 采样率: audio.sample_rate ? Number(audio.sample_rate) : undefined,
    } : null,
    流数量: streams.length,
  }
  return JSON.stringify(summary, null, 2)
}

async function toolTrim(args, exec) {
  await needEngine()
  const cwd = sessionCwd(exec)
  const input = requireInput(args.input, cwd)
  const output = prepareOutput(args.output, cwd)
  const start = toSeconds(args.start ?? 0, 'start')
  const hasEnd = args.end !== undefined && args.end !== null && args.end !== ''
  const hasDuration = args.duration !== undefined && args.duration !== null && args.duration !== ''
  if (!hasEnd && !hasDuration) throw new Error('需要提供 end 或 duration 之一')
  const ffArgs = []
  if (start > 0) ffArgs.push('-ss', num(start))
  ffArgs.push('-i', input)
  if (hasDuration) ffArgs.push('-t', num(toSeconds(args.duration, 'duration')))
  else {
    const end = toSeconds(args.end, 'end')
    if (end <= start) throw new Error(`end (${end}s) 必须大于 start (${start}s)`)
    ffArgs.push('-t', num(end - start))
  }
  if (args.copy) ffArgs.push('-c', 'copy')
  else ffArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k')
  ffArgs.push('-movflags', '+faststart', output)
  await runFfmpeg(ffArgs, { signal: exec.signal, cwd })
  return `已裁剪：${output}\n区间 ${humanDuration(start)} → ${hasDuration ? `+${num(toSeconds(args.duration, 'duration'))}s` : humanDuration(toSeconds(args.end, 'end'))}${args.copy ? '（流复制）' : ''}`
}

async function toolConcat(args, exec) {
  await needEngine()
  const cwd = sessionCwd(exec)
  const inputs = (args.inputs ?? []).map((p) => requireInput(p, cwd))
  if (inputs.length < 2) throw new Error('拼接至少需要 2 个输入文件')
  const output = prepareOutput(args.output, cwd)
  const mode = args.mode ?? 'safe'
  const temps = []
  try {
    if (mode === 'fast') {
      const listFile = tempFile('.txt')
      temps.push(listFile)
      writeFileSync(listFile, inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
      await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', output], { signal: exec.signal, cwd })
      return `已拼接（流复制快速模式）：${output}（${inputs.length} 段）`
    }
    const width = args.width ?? 1920
    const height = args.height ?? 1080
    const fps = args.fps ?? 30
    const parts = []
    for (const input of inputs) {
      const info = await probeFile(input, { signal: exec.signal, cwd })
      const hasAudio = (info.streams ?? []).some((s) => s.codec_type === 'audio')
      const out = tempFile('.ts')
      temps.push(out)
      const ffArgs = ['-i', input]
      if (!hasAudio) ffArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
      ffArgs.push(
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-video_track_timescale', '90000', '-shortest', '-f', 'mpegts', out,
      )
      await runFfmpeg(ffArgs, { signal: exec.signal, cwd })
      parts.push(out)
    }
    const listFile = tempFile('.txt')
    temps.push(listFile)
    // 重要：concat 列表不能带 BOM，这里用 Node 写 UTF-8 无 BOM。
    writeFileSync(listFile, parts.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', output], { signal: exec.signal, cwd })
    return `已拼接：${output}（${inputs.length} 段，统一为 ${width}x${height}@${fps}fps）`
  } finally {
    cleanupTemp(temps)
  }
}

async function toolAudio(args, exec) {
  await needEngine()
  const cwd = sessionCwd(exec)
  const input = requireInput(args.input, cwd)
  const output = prepareOutput(args.output, cwd)
  const ffArgs = ['-i', input]
  const volume = typeof args.volume === 'number' ? args.volume : 1
  if (args.audio) ffArgs.push('-i', requireInput(args.audio, cwd))

  if (args.mute) {
    ffArgs.push('-an')
  } else if (args.audio) {
    const chain = []
    if (args.mix) {
      chain.push('[0:a]volume=1[a0]', `[1:a]volume=${volume}[a1]`)
      chain.push('[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]')
    } else {
      chain.push(`[1:a]volume=${volume}[aout]`)
    }
    ffArgs.push('-filter_complex', chain.join(';'), '-map', '0:v?', '-map', '[aout]')
  } else if (volume !== 1 || args.fadeIn || args.fadeOut) {
    const steps = []
    if (volume !== 1) steps.push(`volume=${volume}`)
    if (args.fadeIn) {
      steps.push(`afade=t=in:st=${num(toSeconds(args.fadeIn.start ?? 0, 'fadeIn.start'))}:d=${num(toSeconds(args.fadeIn.duration, 'fadeIn.duration'))}`)
    }
    if (args.fadeOut) {
      steps.push(`afade=t=out:st=${num(toSeconds(args.fadeOut.start, 'fadeOut.start'))}:d=${num(toSeconds(args.fadeOut.duration, 'fadeOut.duration'))}`)
    }
    ffArgs.push('-filter_complex', `[0:a]${steps.join(',')}[aout]`, '-map', '0:v?', '-map', '[aout]')
  }
  ffArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', args.bitrate ?? '192k', '-movflags', '+faststart', output)
  await runFfmpeg(ffArgs, { signal: exec.signal, cwd })
  const notes = []
  if (args.mute) notes.push('静音')
  if (args.audio) notes.push(args.mix ? `混入 ${path.basename(args.audio)}` : `替换为 ${path.basename(args.audio)}`)
  if (typeof args.volume === 'number' && args.volume !== 1 && !args.audio) notes.push(`音量 ${args.volume}x`)
  if (args.fadeIn) notes.push('淡入')
  if (args.fadeOut) notes.push('淡出')
  return `已处理音轨：${output}\n操作：${notes.join('、') || '无变化'}`
}

async function toolText(args, exec) {
  await needEngine()
  const cwd = sessionCwd(exec)
  const input = requireInput(args.input, cwd)
  const output = prepareOutput(args.output, cwd)
  const filters = []
  const temps = []
  if (args.subtitleFile) {
    const sub = requireInput(args.subtitleFile, cwd)
    filters.push(`subtitles='${escapeFilterPath(sub)}'${args.subtitleStyle ? `:force_style='${args.subtitleStyle}'` : ''}`)
  }
  if (args.text) {
    const fontFile = args.fontFile ? resolvePath(args.fontFile, cwd) : pickFont()
    if (!fontFile) throw new Error('未找到可用字体，请通过 fontFile 指定一个 .ttf/.ttc 字体文件')
    const textFile = writeTextFile(args.text)
    temps.push(textFile)
    const parts = [
      `textfile='${escapeFilterPath(textFile)}'`,
      `fontfile='${escapeFilterPath(fontFile)}'`,
      `fontsize=${args.fontSize ?? 48}`,
      `fontcolor=${args.color ?? 'white'}`,
      `x=${args.x ?? '(w-text_w)/2'}`,
      `y=${args.y ?? 'h-text_h-60'}`,
      `borderw=${args.borderWidth ?? 3}`,
      `bordercolor=${args.borderColor ?? 'black'}`,
    ]
    if (args.box) parts.push('box=1', `boxcolor=${args.boxColor ?? 'black@0.5'}`, 'boxborderw=12')
    if (args.start !== undefined || args.end !== undefined) {
      const start = toSeconds(args.start ?? 0, 'start')
      const end = toSeconds(args.end ?? 0, 'end')
      parts.push(`enable='between(t,${num(start)},${num(end)})'`)
    }
    filters.push(`drawtext=${parts.join(':')}`)
  }
  if (filters.length === 0) throw new Error('至少需要 text 或 subtitleFile 之一')
  try {
    await runFfmpeg(['-i', input, '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', output], { signal: exec.signal, cwd })
  } finally {
    cleanupTemp(temps)
  }
  return `已烧录文字/字幕：${output}\n滤镜：${filters.join(' , ')}`
}

async function toolTransform(args, exec) {
  await needEngine()
  const cwd = sessionCwd(exec)
  const input = requireInput(args.input, cwd)
  const output = prepareOutput(args.output, cwd)
  const vf = []
  const af = []
  if (args.width || args.height) {
    const w = args.width ?? -2
    const h = args.height ?? -2
    vf.push(`scale=${w}:${h}${args.stretch ? '' : ':force_original_aspect_ratio=decrease'}`)
    if (args.pad) vf.push(`pad=${args.width ?? 'iw'}:${args.height ?? 'ih'}:(ow-iw)/2:(oh-ih)/2:${args.padColor ?? 'black'}`)
  }
  if (args.crop) {
    const { width: cw, height: ch, x = 0, y = 0 } = args.crop
    vf.push(`crop=${cw}:${ch}:${x}:${y}`)
  }
  if (args.rotate) {
    const degrees = Number(args.rotate)
    const map = { 90: 'transpose=1', 180: 'transpose=1,transpose=1', 270: 'transpose=2', '-90': 'transpose=2' }
    vf.push(map[degrees] ?? `rotate=${degrees}*PI/180`)
  }
  if (args.speed && Number(args.speed) !== 1) {
    const speed = Number(args.speed)
    if (!(speed > 0.01 && speed < 100)) throw new Error('speed 必须在 0.01 到 100 之间')
    vf.push(`setpts=${num(1 / speed)}*PTS`)
    af.push(`atempo=${Math.min(Math.max(speed, 0.5), 2)}`)
  }
  if (args.fps) vf.push(`fps=${args.fps}`)
  if (vf.length === 0 && af.length === 0) throw new Error('没有需要执行的变化（width/height/crop/rotate/speed/fps）')
  const ffArgs = ['-i', input]
  if (vf.length > 0) ffArgs.push('-vf', vf.join(','))
  if (af.length > 0) ffArgs.push('-filter:a', af.join(','))
  ffArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output)
  await runFfmpeg(ffArgs, { signal: exec.signal, cwd })
  return `已变换：${output}\n视频滤镜：${vf.join(' , ') || '无'}\n音频滤镜：${af.join(' , ') || '无'}`
}

async function toolExport(args, exec) {
  await needEngine()
  const cwd = sessionCwd(exec)
  const input = requireInput(args.input, cwd)
  const output = prepareOutput(args.output, cwd)
  const format = (args.format ?? path.extname(output).replace('.', '') ?? 'mp4').toLowerCase()
  const ffArgs = []
  if (args.start !== undefined) ffArgs.push('-ss', num(toSeconds(args.start, 'start')))
  ffArgs.push('-i', input)
  if (args.end !== undefined) {
    const start = toSeconds(args.start ?? 0, 'start')
    ffArgs.push('-t', num(toSeconds(args.end, 'end') - start))
  } else if (args.duration !== undefined) {
    ffArgs.push('-t', num(toSeconds(args.duration, 'duration')))
  }
  if (format === 'gif') {
    const fps = args.fps ?? 12
    const width = args.width ?? 640
    ffArgs.push(
      '-filter_complex',
      `[0:v]fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse[out]`,
      '-map', '[out]', '-loop', '0', output,
    )
  } else if (format === 'mp3' || format === 'm4a' || format === 'wav') {
    ffArgs.push('-vn', '-c:a', format === 'wav' ? 'pcm_s16le' : 'aac', '-b:a', args.bitrate ?? '192k', output)
  } else if (format === 'webm') {
    ffArgs.push('-c:v', 'libvpx-vp9', '-crf', String(args.crf ?? 30), '-b:v', '0', '-c:a', 'libopus', '-b:a', args.bitrate ?? '128k', output)
  } else {
    if (args.width || args.height) {
      ffArgs.push('-vf', `scale=${args.width ?? -2}:${args.height ?? -2}:force_original_aspect_ratio=decrease`)
    }
    ffArgs.push(
      '-c:v', args.codec ?? 'libx264',
      '-preset', args.preset ?? 'medium',
      '-crf', String(args.crf ?? 20),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', args.bitrate ?? '192k',
      '-movflags', '+faststart',
      output,
    )
  }
  await runFfmpeg(ffArgs, { signal: exec.signal, cwd })
  const size = existsSync(output) ? statSync(output).size : 0
  return `已导出：${output}\n格式：${format}｜大小：${(size / 1024 / 1024).toFixed(2)} MB`
}

async function toolFrame(args, exec) {
  await needEngine()
  const cwd = sessionCwd(exec)
  const input = requireInput(args.input, cwd)
  const info = await probeFile(input, { signal: exec.signal, cwd })
  const duration = Number(info.format?.duration ?? 0)
  const times = Array.isArray(args.times) && args.times.length > 0
    ? args.times.map((t) => toSeconds(t, 'times[]'))
    : args.count && args.count > 1
      ? Array.from({ length: args.count }, (_, i) => (duration * (i + 0.5)) / args.count)
      : [toSeconds(args.time ?? Math.min(duration / 2, 1), 'time')]
  const width = args.width
  const written = []
  for (let i = 0; i < times.length; i++) {
    const base = times.length === 1
      ? prepareOutput(args.output, cwd)
      : prepareOutput(args.output.replace(/(\.[a-z0-9]+)$/i, `-${i + 1}$1`), cwd)
    const ffArgs = ['-ss', num(times[i]), '-i', input, '-frames:v', '1', '-q:v', '2']
    if (width) ffArgs.push('-vf', `scale=${width}:-2`)
    ffArgs.push(base)
    await runFfmpeg(ffArgs, { signal: exec.signal, cwd })
    written.push(`${base}  @ ${humanDuration(times[i])}`)
  }
  return `已抽取 ${written.length} 帧：\n${written.join('\n')}`
}

// ─────────────────────────────────────────────────────────────
// 注册
// ─────────────────────────────────────────────────────────────

/**
 * 注册全部视频工具。
 * @param {object} ctx agent 作用域服务。
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'video_setup',
    description: '检查并准备视频剪辑引擎（ffmpeg/ffprobe）。首次使用前运行一次即可；引擎缺失时其它 video_* 工具也会自动尝试下载一次。',
    parameters: {
      force: { type: 'boolean', description: 'true = 忽略已存在的引擎，强制重新下载并覆盖' },
    },
    output: textOutput(),
    async execute(args) { return await toolSetup(args) },
  }))

  ctx.tools.register(defineTool({
    name: 'video_probe',
    description: '读取视频/音频文件的元信息：时长、分辨率、旋转、帧率、编码、码率、音轨。在剪辑前先调用它确认素材参数。',
    parameters: {
      input: { type: 'string', required: true, description: '媒体文件路径（相对路径基于会话工作目录）' },
    },
    output: textOutput(),
    async execute(args, exec) { return await toolProbe(args, exec) },
  }))

  ctx.tools.register(defineTool({
    name: 'video_trim',
    description: '裁剪一段视频/音频。用 start + end 或 start + duration 指定区间。默认重新编码以保证首尾精确。',
    parameters: {
      input: { type: 'string', required: true, description: '输入文件路径' },
      output: { type: 'string', required: true, description: '输出文件路径（父目录会自动创建）' },
      start: { type: 'string', description: '起点，秒数或 "hh:mm:ss"，默认 0' },
      end: { type: 'string', description: '终点，秒数或 "hh:mm:ss"；与 duration 二选一' },
      duration: { type: 'string', description: '持续时长，秒数或 "hh:mm:ss"；与 end 二选一' },
      copy: { type: 'boolean', description: 'true = 直接复制流（快但不精确、可能黑帧），默认 false 重编码' },
    },
    output: textOutput(),
    async execute(args, exec) { return await toolTrim(args, exec) },
  }))

  ctx.tools.register(defineTool({
    name: 'video_concat',
    description: '按顺序拼接多个片段成一个文件。默认 safe 模式：先统一分辨率/帧率/音轨再拼接，兼容性最好；fast 模式直接复制流，要求各片段参数一致。',
    parameters: {
      inputs: {
        type: 'array', required: true, description: '按播放顺序排列的输入文件路径（至少 2 个）',
        items: { type: 'string' },
      },
      output: { type: 'string', required: true, description: '输出文件路径' },
      mode: { type: 'string', enum: ['safe', 'fast'], description: 'safe（默认，重编码统一参数）或 fast（流复制）' },
      width: { type: 'integer', description: 'safe 模式下的统一宽度，默认 1920' },
      height: { type: 'integer', description: 'safe 模式下的统一高度，默认 1080' },
      fps: { type: 'integer', description: 'safe 模式下的统一帧率，默认 30' },
    },
    output: textOutput(),
    async execute(args, exec) { return await toolConcat(args, exec) },
  }))

  ctx.tools.register(defineTool({
    name: 'video_audio',
    description: '处理音轨：静音原声、替换/混入背景音乐、调整音量、加淡入淡出。视频流直接复制不重编码。',
    parameters: {
      input: { type: 'string', required: true, description: '输入视频路径' },
      output: { type: 'string', required: true, description: '输出视频路径' },
      mute: { type: 'boolean', description: 'true = 移除全部音频' },
      audio: { type: 'string', description: '用于替换或混入的音频/视频文件路径' },
      mix: { type: 'boolean', description: 'true = 与原声混音；false（默认）= 替换原声（仅在提供 audio 时有意义）' },
      volume: { type: 'number', description: '音量倍数。替换模式下作用于新音轨；无 audio 时作用于原音轨。默认 1' },
      fadeIn: {
        type: 'object', additionalProperties: false, description: '原声淡入',
        properties: {
          start: { type: 'number', description: '开始时间（秒），默认 0' },
          duration: { type: 'number', required: true, description: '淡入时长（秒）' },
        },
      },
      fadeOut: {
        type: 'object', additionalProperties: false, description: '原声淡出',
        properties: {
          start: { type: 'number', required: true, description: '开始时间（秒）' },
          duration: { type: 'number', required: true, description: '淡出时长（秒）' },
        },
      },
      bitrate: { type: 'string', description: '音频码率，默认 192k' },
    },
    output: textOutput(),
    async execute(args, exec) { return await toolAudio(args, exec) },
  }))

  ctx.tools.register(defineTool({
    name: 'video_text',
    description: '在画面上烧录文字（标题/水印/字幕）或烧录 .srt/.ass 字幕文件。文字走 textfile 通道，中文和特殊符号都安全。',
    parameters: {
      input: { type: 'string', required: true, description: '输入视频路径' },
      output: { type: 'string', required: true, description: '输出视频路径' },
      text: { type: 'string', description: '要烧录的文字内容' },
      subtitleFile: { type: 'string', description: '.srt/.ass 字幕文件路径（可与 text 同时使用）' },
      subtitleStyle: { type: 'string', description: '字幕强制样式，如 "FontName=Microsoft YaHei,FontSize=24"（仅 subtitleFile 可用）' },
      fontSize: { type: 'integer', description: '字号，默认 48' },
      color: { type: 'string', description: '文字颜色，默认 white，如 yellow / #FFCC00' },
      x: { type: 'string', description: '横坐标表达式，默认居中 "(w-text_w)/2"' },
      y: { type: 'string', description: '纵坐标表达式，默认底部 "h-text_h-60"' },
      start: { type: 'string', description: '文字出现时间（秒），不填则全程显示' },
      end: { type: 'string', description: '文字消失时间（秒）' },
      fontFile: { type: 'string', description: '字体文件路径，默认自动选择中文字体；需要 ✓ ★ 等符号时必须显式指定（drawtext 不做字体回退）' },
      borderWidth: { type: 'integer', description: '描边宽度，默认 3' },
      borderColor: { type: 'string', description: '描边颜色，默认 black' },
      box: { type: 'boolean', description: 'true = 文字加半透明背景框' },
      boxColor: { type: 'string', description: '背景框颜色，默认 black@0.5' },
    },
    output: textOutput(),
    async execute(args, exec) { return await toolText(args, exec) },
  }))

  ctx.tools.register(defineTool({
    name: 'video_transform',
    description: '几何与速度变换：缩放、裁剪、旋转、变速、改帧率。',
    parameters: {
      input: { type: 'string', required: true, description: '输入视频路径' },
      output: { type: 'string', required: true, description: '输出视频路径' },
      width: { type: 'integer', description: '目标宽度像素（-2 表示按比例自动）' },
      height: { type: 'integer', description: '目标高度像素（-2 表示按比例自动）' },
      stretch: { type: 'boolean', description: 'true = 拉伸填满，不加黑边；默认按比例缩放' },
      pad: { type: 'boolean', description: 'true = 缩放后补边到指定宽高' },
      padColor: { type: 'string', description: '补边颜色，默认 black' },
      crop: {
        type: 'object', additionalProperties: false, description: '裁剪区域',
        properties: {
          width: { type: 'integer', required: true, description: '裁剪宽度' },
          height: { type: 'integer', required: true, description: '裁剪高度' },
          x: { type: 'integer', description: '左上角横坐标，默认 0' },
          y: { type: 'integer', description: '左上角纵坐标，默认 0' },
        },
      },
      rotate: { type: 'string', description: '旋转角度，支持 90 / 180 / 270 / -90 或任意角度' },
      speed: { type: 'number', description: '速度倍数，2 = 两倍速，0.5 = 慢放' },
      fps: { type: 'integer', description: '目标帧率' },
    },
    output: textOutput(),
    async execute(args, exec) { return await toolTransform(args, exec) },
  }))

  ctx.tools.register(defineTool({
    name: 'video_export',
    description: '导出成成品：选择格式（mp4/webm/gif/mp3/m4a/wav）、画质(CRF)、分辨率、码率，也可利用 start/end 顺带截取。',
    parameters: {
      input: { type: 'string', required: true, description: '输入媒体路径' },
      output: { type: 'string', required: true, description: '输出文件路径（扩展名决定默认格式）' },
      format: { type: 'string', enum: ['mp4', 'webm', 'gif', 'mp3', 'm4a', 'wav'], description: '输出格式，默认按输出扩展名推断' },
      crf: { type: 'integer', description: '画质，越小越清晰。mp4 默认 20，webm/gif 默认 30' },
      preset: { type: 'string', description: 'x264 预设：ultrafast/fast/medium/slow，默认 medium' },
      width: { type: 'integer', description: '输出宽度，高度自动等比' },
      height: { type: 'integer', description: '输出高度' },
      fps: { type: 'integer', description: '输出帧率（gif 建议 12）' },
      bitrate: { type: 'string', description: '音频码率，默认 192k（webm 为 128k）' },
      start: { type: 'string', description: '截取起点（秒）' },
      end: { type: 'string', description: '截取终点（秒）' },
      duration: { type: 'string', description: '截取时长（秒）' },
      codec: { type: 'string', description: 'mp4 视频编码，默认 libx264' },
    },
    output: textOutput(),
    async execute(args, exec) { return await toolExport(args, exec) },
  }))

  ctx.tools.register(defineTool({
    name: 'video_frame',
    description: '抽取画面截图（png/jpg）。抽出的图片可以用 read_image 直接查看，用来“看”视频内容、做封面或检查关键帧。',
    parameters: {
      input: { type: 'string', required: true, description: '输入视频路径' },
      output: { type: 'string', required: true, description: '输出图片路径；count>1 时自动加序号后缀' },
      time: { type: 'string', description: '抽帧时间点（秒），默认取 1 秒处或中点' },
      times: { type: 'array', description: '多个时间点（秒），与 count 二选一', items: { type: 'string' } },
      count: { type: 'integer', description: '均匀抽取 N 帧（>1 时按序号命名）' },
      width: { type: 'integer', description: '输出图片宽度，高度等比' },
    },
    output: textOutput(),
    async execute(args, exec) { return await toolFrame(args, exec) },
  }))
}
