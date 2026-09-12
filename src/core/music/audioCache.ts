/**
 * Audio file cache manager.
 * - 自动将已解析的可播放 HTTP 链接下载到本地
 * - 下次播放优先命中本地文件，避免再次走远端 API
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system/legacy'
import { File as NativeFile } from 'expo-file-system'
import { fetch as expoFetch } from 'expo/fetch'
import { Quality } from './source'
import { getPlayableAudioUrlCandidates, normalizePlayableAudioUrl } from '../../utils/url'
import {
  AudioCacheIndexRecord,
  getAudioCacheEnabledSetting,
  loadAudioCacheIndexRecords,
  replaceAudioCacheIndexRecords,
  saveAudioCacheEnabledSetting,
} from './cacheSqlite'

const AUDIO_CACHE_DIR_NAME = 'joy_audio_cache'

const DEFAULT_AUDIO_CACHE_SETTINGS: AudioCacheSettings = {
  enabled: true,
}

const SUPPORTED_EXTS = new Set([
  'mp3',
  'm4a',
  'aac',
  'flac',
  'wav',
  'ogg',
  'opus',
  'webm',
  'mp4',
])

const AUDIO_CACHE_DOWNLOAD_HEADERS = {
  Accept: '*/*',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
}

const AUDIO_CACHE_DOWNLOAD_TIMEOUT_MS = 45000

export interface AudioCacheSettings {
  enabled: boolean
}

export interface CachedAudioFileEntry {
  musicId: string
  fileUri: string
  quality: Quality
  source: string
  size: number
  updatedAt: number
  title?: string
  artist?: string
}

export interface AudioCacheStats {
  enabled: boolean
  fileCount: number
  sizeBytes: number
}

export interface AudioCacheOverview extends AudioCacheStats {
  /** 全部有效缓存条目，按最近缓存时间倒序排列 */
  entries: CachedAudioFileEntry[]
}

export interface AudioCacheStoreRequest {
  musicId: string
  url: string
  quality: Quality
  source: string
  title?: string
  artist?: string
}

function safeFileName(input: string): string {
  const normalized = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || 'track'
}

function inferFileExtension(url: string): string {
  const clean = String(url || '').split('?')[0].split('#')[0]
  const match = clean.match(/\.([a-zA-Z0-9]{2,5})$/)
  const rawExt = (match?.[1] || '').toLowerCase()
  if (!rawExt) return 'mp3'
  if (rawExt === 'm4s') return 'm4a'
  if (SUPPORTED_EXTS.has(rawExt)) return rawExt
  return 'mp3'
}

function getDownloadCandidates(url: string): string[] {
  return getPlayableAudioUrlCandidates(url)
}

function formatCacheError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

async function downloadAudioByStreaming(url: string, targetUri: string): Promise<number> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timeout = setTimeout(() => {
    controller?.abort()
  }, AUDIO_CACHE_DOWNLOAD_TIMEOUT_MS)

  let handle: { close: () => void; writeBytes: (bytes: Uint8Array) => void } | null = null
  try {
    const response = await expoFetch(url, {
      headers: AUDIO_CACHE_DOWNLOAD_HEADERS,
      signal: controller?.signal,
    })

    if (!response.ok) {
      throw new Error(`http status ${response.status}`)
    }

    const targetFile = new NativeFile(targetUri)
    targetFile.create({
      intermediates: true,
      overwrite: true,
    })
    handle = targetFile.open()

    const bodyStream = response.body
    if (bodyStream && typeof bodyStream.getReader === 'function') {
      // 分片写入：逐块落盘，避免一次性占用过多内存。
      const reader = bodyStream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          handle.writeBytes(value)
        }
      }
    } else {
      const bytes = await response.bytes()
      if (bytes && bytes.length > 0) {
        handle.writeBytes(bytes)
      }
    }

    return response.status
  } finally {
    clearTimeout(timeout)
    if (handle) {
      try {
        handle.close()
      } catch {
        // ignore
      }
    }
  }
}

async function getCacheDir(): Promise<string> {
  // 历史版本曾使用 FileSystem.cacheDirectory（iOS Library/Caches/），
  // 该目录在覆盖安装、系统空间紧张时会被 iOS 清空，导致下载好的歌曲全部丢失。
  // 现改用 documentDirectory（iOS Documents/），覆盖安装会保留，符合"长期缓存"的诉求。
  const baseDir = FileSystem.documentDirectory || FileSystem.cacheDirectory
  if (!baseDir) {
    throw new Error('FileSystem directory unavailable')
  }
  return `${baseDir}${AUDIO_CACHE_DIR_NAME}/`
}

function getLegacyCacheDir(): string | null {
  const baseDir = FileSystem.cacheDirectory
  if (!baseDir) return null
  return `${baseDir}${AUDIO_CACHE_DIR_NAME}/`
}

const MIGRATION_FLAG_KEY = '@joy_audio_cache_migrated_v1'

/**
 * 一次性迁移：把 Library/Caches/joy_audio_cache/ 里残存的歌曲挪到 Documents/joy_audio_cache/，
 * 同时把 SQLite 索引中 fileUri 的旧前缀替换为新前缀，让"覆盖升级"过来的用户保留已下载的歌。
 *
 * 触发时机：每次启动时调用一次（内部用 AsyncStorage flag 保证只跑一次）。
 * 兼容情况：
 *   - 旧目录不存在（全新装 / iOS 已清掉）→ 直接打 flag 跳过
 *   - 索引中 fileUri 还指向旧路径 → 把前缀替换；如果新位置已经存在同名文件就跳过这条索引
 *   - 旧目录里的孤儿文件（不在索引里）→ 直接搬过去，不影响主流程
 */
/**
 * 从索引 entry 的旧 fileUri 中提取文件名部分（如 "kw_61997_1781595560865_0.mp3"）。
 * 兼容 iOS 沙盒 UUID 变化的情况：路径的前缀（含 UUID）每次重启可能变，但文件名稳定。
 */
function extractLegacyFileName(legacyUri: string): string | null {
  if (!legacyUri) return null
  const match = legacyUri.match(/\/joy_audio_cache\/([^/]+)$/)
  return match?.[1] ?? null
}

async function migrateLegacyCacheIfNeeded(
  loadIndex: () => Promise<Record<string, CachedAudioFileEntry>>,
  saveIndex: (next: Record<string, CachedAudioFileEntry>) => Promise<void>,
): Promise<void> {
  try {
    const done = await AsyncStorage.getItem(MIGRATION_FLAG_KEY)
    if (done === '1') {
      // 即便 flag 已打，每次启动也要做两件事：
      // 1. UUID 漂移修复：iOS 沙盒每次启动 UUID 都变，索引里的 fileUri 前缀失效，
      //    必须按"文件名 + 当前 newDir"重建路径。这是覆盖装/重启后第一次播放卡死的根因。
      // 2. 自愈：扫新目录里索引没记录的孤儿文件按文件名反向补条目。
      await rewriteIndexUriForCurrentSandbox(loadIndex, saveIndex)
      await selfHealOrphanFiles(loadIndex, saveIndex)
      return
    }

    const legacyDir = getLegacyCacheDir()
    const newDir = await getCacheDir()
    if (!legacyDir || legacyDir === newDir) {
      await AsyncStorage.setItem(MIGRATION_FLAG_KEY, '1')
      return
    }

    const legacyInfo = await FileSystem.getInfoAsync(legacyDir)
    const legacyExists = legacyInfo.exists

    // 准备目标目录。
    const newInfo = await FileSystem.getInfoAsync(newDir)
    if (!newInfo.exists) {
      await FileSystem.makeDirectoryAsync(newDir, { intermediates: true })
    }

    // —— Step 1：搬物理文件 ——
    let movedFileCount = 0
    if (legacyExists) {
      try {
        const fileNames = await FileSystem.readDirectoryAsync(legacyDir)
        for (const name of fileNames) {
          const fromUri = `${legacyDir}${name}`
          const toUri = `${newDir}${name}`
          try {
            const toInfo = await FileSystem.getInfoAsync(toUri)
            if (toInfo.exists) {
              await FileSystem.deleteAsync(fromUri, { idempotent: true })
              continue
            }
            await FileSystem.moveAsync({ from: fromUri, to: toUri })
            movedFileCount += 1
          } catch (moveError) {
            console.warn('[AudioCache] migrate move failed:', name, moveError)
          }
        }
      } catch (listError) {
        console.warn('[AudioCache] migrate listing legacy dir failed:', listError)
      }
    }

    // —— Step 2：修补索引 fileUri（含 UUID 漂移修复） ——
    const { patched: indexPatchedCount, dropped: indexDroppedCount } =
      await rewriteIndexUriForCurrentSandbox(loadIndex, saveIndex)

    // —— Step 3：扫 newDir 里"实际存在但索引里没记录"的孤儿文件，按文件名反向重建 ——
    await selfHealOrphanFiles(loadIndex, saveIndex)

    // —— Step 4：清空旧目录残留 ——
    if (legacyExists) {
      try {
        await FileSystem.deleteAsync(legacyDir, { idempotent: true })
      } catch {
        // ignore
      }
    }

    console.log(
      `[AudioCache] Migrated legacy cache: movedFiles=${movedFileCount}, indexPatched=${indexPatchedCount}, indexDropped=${indexDroppedCount}`
    )
    await AsyncStorage.setItem(MIGRATION_FLAG_KEY, '1')
  } catch (error) {
    console.warn('[AudioCache] migrateLegacyCacheIfNeeded failed:', error)
    // 不打 flag，下次启动还能重试。
  }
}

/**
 * 把索引里所有 fileUri 都改写成"当前 newDir + 文件名"。
 *
 * 触发原因：iOS 沙盒 UUID 每次启动可能变（覆盖安装、设备重启、Replace Container 都会触发），
 * 索引里写入时的 fileUri 包含的 UUID 在新启动后已经失效。如果不修，下次播放走 cache 命中
 * 时返回旧 UUID 的路径，expo-audio 加载这个不存在的文件会卡很久才报错（用户感觉是"加载中"），
 * 然后 getCachedEntry 才把这条索引清掉。
 *
 * 策略：
 * - fileUri 已经在 newDir 下 → 跳过（同一次启动内已修过 / 本次新写入的）
 * - fileUri 能提取出 joy_audio_cache/<fileName> → 拼成 newDir + fileName
 *   - 新位置文件存在 → 改写 entry.fileUri
 *   - 新位置文件不存在 → 删掉这条索引（下次播放走在线兜底）
 */
async function rewriteIndexUriForCurrentSandbox(
  loadIndex: () => Promise<Record<string, CachedAudioFileEntry>>,
  saveIndex: (next: Record<string, CachedAudioFileEntry>) => Promise<void>,
): Promise<{ patched: number; dropped: number }> {
  try {
    const newDir = await getCacheDir()
    const index = await loadIndex()
    let patched = 0
    let dropped = 0
    let dirty = false

    for (const key of Object.keys(index)) {
      const entry = index[key]
      if (!entry?.fileUri) continue
      if (entry.fileUri.startsWith(newDir)) continue

      const fileName = extractLegacyFileName(entry.fileUri)
      if (!fileName) continue

      const nextUri = `${newDir}${fileName}`
      const nextInfo = await FileSystem.getInfoAsync(nextUri)
      if (!nextInfo.exists) {
        delete index[key]
        dropped += 1
        dirty = true
        continue
      }
      index[key] = { ...entry, fileUri: nextUri }
      patched += 1
      dirty = true
    }

    if (dirty) {
      await saveIndex(index)
      console.log(`[AudioCache] Rewrite index uri for current sandbox: patched=${patched}, dropped=${dropped}`)
    }
    return { patched, dropped }
  } catch (error) {
    console.warn('[AudioCache] rewriteIndexUriForCurrentSandbox failed:', error)
    return { patched: 0, dropped: 0 }
  }
}

/**
 * 索引自愈：扫 documents/joy_audio_cache/ 下所有文件，对索引里没记录的，
 * 按文件名反向解析出 musicId/source 重建一条 minimal entry。
 *
 * 文件名格式：`<safeFileName(musicId)>_<timestamp>_<candidateIndex>.<ext>`
 * - 例如 `kw_61997_1781595560865_0.mp3` → musicId="kw_61997", source="kw"
 * - source 用 musicId 第一段（kw/wy/tx/kg）猜；猜不到默认 unknown
 * - quality 不知道，先填 '320k'（绝大多数缓存都是这）；title/artist 留空
 * - 一旦该歌再次走 cacheFromUrl 流程，会被真值覆盖
 *
 * 此函数无副作用前提：只为索引里没的文件加条目，不动已有条目。
 */
async function selfHealOrphanFiles(
  loadIndex: () => Promise<Record<string, CachedAudioFileEntry>>,
  saveIndex: (next: Record<string, CachedAudioFileEntry>) => Promise<void>,
): Promise<void> {
  try {
    const newDir = await getCacheDir()
    const newInfo = await FileSystem.getInfoAsync(newDir)
    if (!newInfo.exists) return

    const fileNames = await FileSystem.readDirectoryAsync(newDir)
    if (!fileNames.length) return

    const index = await loadIndex()
    const knownFileUris = new Set(
      Object.values(index)
        .map((e) => e?.fileUri || '')
        .filter(Boolean),
    )

    let healedCount = 0
    let dirty = false
    for (const name of fileNames) {
      const fileUri = `${newDir}${name}`
      if (knownFileUris.has(fileUri)) continue

      // 反向解析：去掉扩展名，按 _ 切，最后两段是 timestamp / candidateIndex，前面拼回去就是 musicId。
      const lastDot = name.lastIndexOf('.')
      const stem = lastDot > 0 ? name.slice(0, lastDot) : name
      const parts = stem.split('_')
      if (parts.length < 3) continue
      // candidateIndex (parts[last]) 必须是数字，timestamp (parts[last-1]) 必须是 13 位左右纯数字。
      const candidateIdxStr = parts[parts.length - 1]
      const tsStr = parts[parts.length - 2]
      if (!/^\d+$/.test(candidateIdxStr)) continue
      if (!/^\d{10,16}$/.test(tsStr)) continue
      const musicIdParts = parts.slice(0, parts.length - 2)
      if (!musicIdParts.length) continue
      const musicId = musicIdParts.join('_')
      // 已有索引 entry，且仍指向现存文件 → 跳过（防覆盖正常索引）。
      // 已有但 entry 指向已不存在的文件（比如 UUID 漂移没修干净的残留）→ 让自愈用当前
      // 真实存在的 fileUri 覆盖。
      const existing = index[musicId]
      if (existing?.fileUri) {
        const existingInfo = await FileSystem.getInfoAsync(existing.fileUri)
        if (existingInfo.exists) continue
      }

      const sourceGuess = musicIdParts[0] || 'unknown'

      const info = await FileSystem.getInfoAsync(fileUri)
      const size = info.exists && typeof info.size === 'number' ? info.size : 0

      index[musicId] = {
        musicId,
        fileUri,
        quality: '320k' as Quality,
        source: sourceGuess,
        size,
        updatedAt: Date.now(),
        title: undefined,
        artist: undefined,
      }
      healedCount += 1
      dirty = true
    }

    if (dirty) {
      await saveIndex(index)
      console.log(`[AudioCache] Self-healed orphan files: ${healedCount}`)
    }
  } catch (error) {
    console.warn('[AudioCache] selfHealOrphanFiles failed:', error)
  }
}

class AudioFileCacheManager {
  private settingsCache: AudioCacheSettings | null = null
  private indexCache: Record<string, CachedAudioFileEntry> | null = null
  private inFlightTasks = new Map<string, Promise<void>>()
  /** 下载进行中收到删除请求的歌曲，下载结束后需要再删一次，避免“删完又被写回” */
  private pendingClears = new Set<string>()
  private migrationPromise: Promise<void> | null = null

  private async ensureMigrated(): Promise<void> {
    if (!this.migrationPromise) {
      // 直接走 SQL 层而不是 this.readIndex，避免在迁移过程中读到/写入到 indexCache。
      const loadIndex = async(): Promise<Record<string, CachedAudioFileEntry>> => {
        const records = await loadAudioCacheIndexRecords()
        const map: Record<string, CachedAudioFileEntry> = {}
        records.forEach((record) => {
          if (!record.fileUri) return
          map[record.musicId] = {
            musicId: record.musicId,
            fileUri: record.fileUri,
            quality: record.quality as Quality,
            source: record.source,
            updatedAt: Number(record.updatedAt || Date.now()),
            size: Number(record.size || 0),
            title: record.title,
            artist: record.artist,
          }
        })
        return map
      }
      const saveIndex = async(next: Record<string, CachedAudioFileEntry>): Promise<void> => {
        const records: AudioCacheIndexRecord[] = Object.values(next).map((entry) => ({
          musicId: entry.musicId,
          fileUri: entry.fileUri,
          quality: entry.quality,
          source: entry.source,
          size: Number(entry.size || 0),
          updatedAt: Number(entry.updatedAt || Date.now()),
          title: entry.title,
          artist: entry.artist,
        }))
        await replaceAudioCacheIndexRecords(records)
        // 让上层重读最新索引。
        this.indexCache = null
      }
      this.migrationPromise = migrateLegacyCacheIfNeeded(loadIndex, saveIndex)
    }
    await this.migrationPromise
  }

  private async ensureDir(): Promise<string> {
    await this.ensureMigrated()
    const dir = await getCacheDir()
    const info = await FileSystem.getInfoAsync(dir)
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true })
    }
    return dir
  }

  private async readSettings(): Promise<AudioCacheSettings> {
    if (this.settingsCache) return this.settingsCache
    try {
      const enabled = await getAudioCacheEnabledSetting()
      if (enabled === null) {
        this.settingsCache = DEFAULT_AUDIO_CACHE_SETTINGS
        return this.settingsCache
      }
      this.settingsCache = {
        enabled,
      }
      return this.settingsCache
    } catch {
      this.settingsCache = DEFAULT_AUDIO_CACHE_SETTINGS
      return this.settingsCache
    }
  }

  private async saveSettings(settings: AudioCacheSettings): Promise<void> {
    this.settingsCache = settings
    await saveAudioCacheEnabledSetting(settings.enabled)
  }

  private async readIndex(): Promise<Record<string, CachedAudioFileEntry>> {
    if (this.indexCache) return this.indexCache
    await this.ensureMigrated()
    try {
      const normalized: Record<string, CachedAudioFileEntry> = {}
      const records = await loadAudioCacheIndexRecords()
      records.forEach((record) => {
        if (!record.fileUri) return
        normalized[record.musicId] = {
          musicId: record.musicId,
          fileUri: record.fileUri,
          quality: record.quality as Quality,
          source: record.source,
          updatedAt: Number(record.updatedAt || Date.now()),
          size: Number(record.size || 0),
          title: record.title,
          artist: record.artist,
        }
      })
      this.indexCache = normalized
      return normalized
    } catch {
      this.indexCache = {}
      return this.indexCache
    }
  }

  private async saveIndex(index: Record<string, CachedAudioFileEntry>): Promise<void> {
    this.indexCache = index
    const records: AudioCacheIndexRecord[] = Object.values(index).map((entry) => ({
      musicId: entry.musicId,
      fileUri: entry.fileUri,
      quality: entry.quality,
      source: entry.source,
      size: Number(entry.size || 0),
      updatedAt: Number(entry.updatedAt || Date.now()),
      title: entry.title,
      artist: entry.artist,
    }))
    await replaceAudioCacheIndexRecords(records)
  }

  private async removeFileIfExists(uri?: string): Promise<void> {
    if (!uri) return
    try {
      const info = await FileSystem.getInfoAsync(uri)
      if (info.exists) {
        await FileSystem.deleteAsync(uri, { idempotent: true })
      }
    } catch {
      // ignore
    }
  }

  async getSettings(): Promise<AudioCacheSettings> {
    return this.readSettings()
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const next = {
      ...(await this.readSettings()),
      enabled: Boolean(enabled),
    }
    await this.saveSettings(next)
  }

  async getCachedEntry(musicId: string): Promise<CachedAudioFileEntry | null> {
    if (!musicId) return null

    const index = await this.readIndex()
    const entry = index[musicId]
    if (!entry?.fileUri) return null

    try {
      const info = await FileSystem.getInfoAsync(entry.fileUri)
      if (!info.exists) {
        delete index[musicId]
        await this.saveIndex(index)
        return null
      }
      const nextSize = typeof info.size === 'number' ? info.size : entry.size
      if (nextSize !== entry.size) {
        const nextEntry: CachedAudioFileEntry = {
          ...entry,
          size: nextSize,
        }
        index[musicId] = nextEntry
        await this.saveIndex(index)
        return nextEntry
      }
      return entry
    } catch {
      return null
    }
  }

  async clearCachedAudioByMusicId(musicId: string): Promise<void> {
    if (!musicId) return

    // 该歌曲可能正在下载：先登记删除意图，等下载任务结束后再清理一次，
    // 否则下载完成时会把文件和索引重新写回。
    this.schedulePendingClear(musicId)

    await this.deleteEntryByMusicId(musicId)
  }

  private schedulePendingClear(musicId: string): void {
    const inFlight = this.inFlightTasks.get(musicId)
    if (!inFlight || this.pendingClears.has(musicId)) return
    this.pendingClears.add(musicId)
    void inFlight.then(() => {
      if (!this.pendingClears.delete(musicId)) return
      void this.deleteEntryByMusicId(musicId)
    })
  }

  private async deleteEntryByMusicId(musicId: string): Promise<boolean> {
    const index = await this.readIndex()
    const entry = index[musicId]
    if (!entry) return false

    await this.removeFileIfExists(entry.fileUri)
    delete index[musicId]
    await this.saveIndex(index)
    console.log(`[AudioCache] Cleared cached audio for ${musicId}`)
    return true
  }

  async resolveCachedPlayableUrl(
    musicId: string,
    expectedQuality?: Quality
  ): Promise<{ uri: string; quality: Quality } | null> {
    const settings = await this.readSettings()
    if (!settings.enabled) return null

    const entry = await this.getCachedEntry(musicId)
    if (!entry) return null
    if (expectedQuality && entry.quality !== expectedQuality) return null

    return {
      uri: entry.fileUri,
      quality: entry.quality,
    }
  }

  async cacheFromUrl(request: AudioCacheStoreRequest): Promise<void> {
    const { musicId, url, quality, source, title, artist } = request
    if (!musicId || !/^https?:\/\//i.test(url || '')) return

    const settings = await this.readSettings()
    if (!settings.enabled) return

    const existingTask = this.inFlightTasks.get(musicId)
    if (existingTask) return existingTask

    const task = (async() => {
      console.log(`[AudioCache] Start cache task for ${musicId}`)
      const dir = await this.ensureDir()
      const index = await this.readIndex()
      const previous = index[musicId]

      if (previous?.fileUri) {
        const previousInfo = await FileSystem.getInfoAsync(previous.fileUri)
        if (previousInfo.exists && previous.source === source && previous.quality === quality) {
          console.log(`[AudioCache] Skip existing cache for ${musicId}`)
          return
        }
      }

      const normalizedUrl = normalizePlayableAudioUrl(url) || url
      if (normalizedUrl !== url) {
        console.log(`[AudioCache] Normalized URL for ${musicId}: ${url} -> ${normalizedUrl}`)
      }

      const ext = inferFileExtension(normalizedUrl)
      const fileNamePrefix = `${safeFileName(musicId)}_${Date.now()}`

      let downloadResult: FileSystem.FileSystemDownloadResult | null = null
      let usedUrl = normalizedUrl
      let usedTargetUri = ''
      const candidates = getDownloadCandidates(normalizedUrl)
      if (!candidates.length) {
        throw new Error(`no downloadable url candidates for ${musicId}`)
      }

      for (let i = 0; i < candidates.length; i++) {
        const candidateUrl = candidates[i]
        const targetUri = `${dir}${fileNamePrefix}_${i}.${ext}`
        try {
          await this.ensureDir()
          console.log(
            `[AudioCache] Downloading ${musicId} (${i + 1}/${candidates.length}) ${candidateUrl} -> ${targetUri}`
          )
          const status = await downloadAudioByStreaming(candidateUrl, targetUri)
          const result: FileSystem.FileSystemDownloadResult = {
            uri: targetUri,
            status,
            headers: {},
            mimeType: null,
          }
          if (result.status >= 200 && result.status < 300) {
            downloadResult = result
            usedUrl = candidateUrl
            usedTargetUri = targetUri
            break
          }
          await this.removeFileIfExists(targetUri)
          console.warn(
            `[AudioCache] Download status ${result.status} for ${musicId} (${candidateUrl})`
          )
        } catch (error) {
          await this.removeFileIfExists(targetUri)
          console.warn(
            `[AudioCache] Download failed for ${musicId} (${candidateUrl}): ${formatCacheError(error)}`
          )
        }
      }

      if (!downloadResult) {
        throw new Error(
          `download failed for ${musicId}, candidates=${JSON.stringify(candidates)}`
        )
      }

      const finalUri = usedTargetUri || downloadResult.uri
      const fileInfo = await FileSystem.getInfoAsync(finalUri)
      if (!fileInfo.exists) {
        throw new Error('download file missing after complete')
      }

      const size = typeof fileInfo.size === 'number' ? fileInfo.size : 0
      index[musicId] = {
        musicId,
        fileUri: finalUri,
        quality,
        source,
        size,
        updatedAt: Date.now(),
        title,
        artist,
      }
      await this.saveIndex(index)
      console.log(
        `[AudioCache] Cached file saved for ${musicId} (${size} bytes, ${usedUrl})`
      )

      if (previous?.fileUri && previous.fileUri !== finalUri) {
        await this.removeFileIfExists(previous.fileUri)
      }
    })()
      .catch((error) => {
        console.warn('[AudioCache] Cache store failed:', formatCacheError(error), {
          musicId,
          source,
          quality,
          url: normalizePlayableAudioUrl(url) || url,
        })
      })
      .finally(() => {
        this.inFlightTasks.delete(musicId)
      })

    this.inFlightTasks.set(musicId, task)
    return task
  }

  /**
   * 缓存总览：统计信息 + 全部有效条目（按最近缓存时间倒序）。
   * 同时顺带清理索引里已经不存在于磁盘的失效记录。
   */
  async getCacheOverview(): Promise<AudioCacheOverview> {
    const settings = await this.readSettings()
    const index = await this.readIndex()
    const nextIndex: Record<string, CachedAudioFileEntry> = {}
    let fileCount = 0
    let sizeBytes = 0
    let changed = false

    for (const [musicId, entry] of Object.entries(index)) {
      try {
        const info = await FileSystem.getInfoAsync(entry.fileUri)
        if (!info.exists) {
          changed = true
          continue
        }
        const size = typeof info.size === 'number' ? info.size : entry.size
        nextIndex[musicId] = {
          ...entry,
          size,
        }
        if (size !== entry.size) changed = true
        fileCount += 1
        sizeBytes += Math.max(0, size)
      } catch {
        changed = true
      }
    }

    if (changed || Object.keys(nextIndex).length !== Object.keys(index).length) {
      await this.saveIndex(nextIndex)
    }

    const entries = Object.values(nextIndex).sort((a, b) => b.updatedAt - a.updatedAt)

    return {
      enabled: settings.enabled,
      fileCount,
      sizeBytes,
      entries,
    }
  }

  async getStats(): Promise<AudioCacheStats> {
    const { enabled, fileCount, sizeBytes } = await this.getCacheOverview()
    return { enabled, fileCount, sizeBytes }
  }

  async clearAllCachedAudio(): Promise<void> {
    const dir = await getCacheDir()
    try {
      await FileSystem.deleteAsync(dir, { idempotent: true })
    } catch {
      // ignore
    }
    await this.ensureDir()
    await this.saveIndex({})

    // 清空时仍在下载的任务结束后会把文件写回缓存目录，登记一次延迟清理。
    Array.from(this.inFlightTasks.keys()).forEach((musicId) => {
      this.schedulePendingClear(musicId)
    })
  }
}

export function formatCacheSize(sizeBytes: number): string {
  const size = Math.max(0, Number(sizeBytes || 0))
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(2)} GB`
}

export const audioFileCache = new AudioFileCacheManager()
