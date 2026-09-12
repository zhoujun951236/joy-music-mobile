/**
 * Local music library (songs imported from the Files app).
 *
 * 与在线缓存的区别：
 * - 文件放在 documentDirectory/joy_local_music/，不会被系统当缓存清掉，
 *   也不会被"清空本地缓存"删掉
 * - 单独一张 SQLite 索引表，和 audio_cache_index 互不影响
 * - 搜索到的歌如果命中本地文件（歌名 + 歌手一致），直接走本地播放，不再联网下载
 */

import * as FileSystem from 'expo-file-system/legacy'
import { Quality } from './source'
import {
  LocalMusicRecord,
  deleteLocalMusicRecord,
  insertLocalMusicRecords,
  loadLocalMusicRecords,
  replaceLocalMusicRecords,
} from './cacheSqlite'

const LOCAL_MUSIC_DIR_NAME = 'joy_local_music'

const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'aac',
  'flac',
  'wav',
  'ogg',
  'opus',
  'aiff',
  'aif',
  'alac',
  'm4b',
])

/** 文件名末尾常见的装饰词，解析歌名/歌手前先剥掉 */
const TRAILING_DECORATOR_REGEX =
  /(?:[\s\-–—_,，.]+(?:live版?|remix|cover|翻唱|伴奏|inst(?:rumental)?|官方版?|mv|hd|hq|无损|320k|128k|flac))+$/i

export interface LocalMusicEntry {
  id: string
  fileUri: string
  fileName: string
  title: string
  artist: string
  size: number
  format: string
  importedAt: number
  /** 文件在磁盘上已经不存在（被系统/用户删掉），仅供 UI 展示 */
  missing?: boolean
}

export interface LocalMusicStats {
  count: number
  sizeBytes: number
  missingCount: number
}

export interface LocalImportAsset {
  uri: string
  name?: string
  size?: number
}

export interface LocalImportResult {
  imported: LocalMusicEntry[]
  replaced: LocalMusicEntry[]
  skipped: Array<{ name: string; reason: string }>
}

export interface ParsedTrackName {
  title: string
  artist: string
}

function getLocalMusicDir(): string {
  const root = FileSystem.documentDirectory || FileSystem.cacheDirectory
  if (!root) {
    throw new Error('当前环境不支持访问本地文件目录')
  }
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`
  return `${normalizedRoot}${LOCAL_MUSIC_DIR_NAME}/`
}

function stripExtension(fileName: string): string {
  return String(fileName || '').replace(/\.[a-zA-Z0-9]{1,5}$/, '')
}

function getFileExtension(fileName: string): string {
  const match = String(fileName || '').match(/\.([a-zA-Z0-9]{1,5})$/)
  return (match?.[1] || '').toLowerCase()
}

function hashId(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/** 生成稳定 id：同一个文件名重复导入会覆盖而不是产生两条记录 */
export function buildLocalMusicId(fileName: string): string {
  const normalized = String(fileName || '').trim().toLowerCase()
  return `local_${hashId(normalized)}`
}

/**
 * 按"歌名-歌手"解析文件名。
 * '-' 两侧有没有空格都能识别：晴天-周杰伦 / 晴天 - 周杰伦 结果一致。
 */
export function parseTrackFileName(rawFileName: string): ParsedTrackName {
  const base = stripExtension(String(rawFileName || '').split('/').pop() || '').trim()
  if (!base) return { title: '未知歌曲', artist: '' }

  // 先去掉括号里的内容与末尾装饰词，避免 "歌名-歌手(Live)" 把 Live 算进歌手
  const cleaned = base
    .replace(/[\(\[【「《][^\)\]】」》]*[\)\]】」》]/g, ' ')
    .replace(TRAILING_DECORATOR_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim()

  const dashIndexes: number[] = []
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === '-') dashIndexes.push(i)
  }

  if (!dashIndexes.length) {
    return { title: cleaned, artist: '' }
  }

  const splitAt = (index: number): ParsedTrackName => ({
    title: cleaned.slice(0, index).trim(),
    artist: cleaned.slice(index + 1).trim(),
  })

  // 常规情况取第一个 '-'；歌名侧短到像被截断（例如 "A-Lin-歌名"）时改用最后一个
  const first = splitAt(dashIndexes[0])
  if (first.title.length <= 2 && dashIndexes.length > 1) {
    const last = splitAt(dashIndexes[dashIndexes.length - 1])
    if (last.title && last.artist) return last
  }
  return first
}

/** 匹配用归一化：忽略大小写、空格、标点与常见装饰词 */
export function normalizeForMatch(input?: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[\(\[【「《][^\)\]】」》]*[\)\]】」》]/g, '')
    .replace(TRAILING_DECORATOR_REGEX, '')
    .replace(/[\s·・•\-–—_,，.。!！?？'’‘"“”()（）\[\]【】「」<>《》/\\|+&]/g, '')
}

/** 本地文件音质未知，按容器格式给一个展示用的近似值 */
export function inferLocalQuality(format?: string): Quality {
  const ext = String(format || '').toLowerCase()
  if (ext === 'flac' || ext === 'alac') return 'flac'
  if (ext === 'wav' || ext === 'aiff' || ext === 'aif') return 'hires'
  return '320k'
}

class LocalMusicLibrary {
  private entries: LocalMusicEntry[] | null = null
  private loadPromise: Promise<LocalMusicEntry[]> | null = null

  private async ensureDir(): Promise<string> {
    const dir = getLocalMusicDir()
    const info = await FileSystem.getInfoAsync(dir)
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true })
    }
    return dir
  }

  /**
   * 载入索引，并处理 iOS 沙盒 UUID 漂移：
   * 覆盖安装/重启后 documentDirectory 的 UUID 会变，索引里的绝对路径失效，
   * 这里按"当前目录 + 文件名"重建；文件真的没了就标记 missing。
   */
  private async hydrate(): Promise<LocalMusicEntry[]> {
    if (this.entries) return this.entries

    const records = await loadLocalMusicRecords()
    const dir = await this.ensureDir()
    const next: LocalMusicEntry[] = []
    let dirty = false

    for (const record of records) {
      const fileName = record.fileUri.split('/').pop() || record.fileName
      let fileUri = record.fileUri
      if (!fileUri.startsWith(dir)) {
        fileUri = `${dir}${fileName}`
        dirty = true
      }

      let size = Number(record.size || 0)
      let missing = false
      try {
        const info = await FileSystem.getInfoAsync(fileUri)
        if (!info.exists) {
          missing = true
        } else if (typeof info.size === 'number' && info.size !== size) {
          size = info.size
          dirty = true
        }
      } catch {
        missing = true
      }

      next.push({
        id: record.id,
        fileUri,
        fileName: record.fileName || fileName,
        title: record.title,
        artist: record.artist,
        size,
        format: record.format || getFileExtension(fileName),
        importedAt: record.importedAt,
        missing,
      })
    }

    if (dirty) {
      await this.persist(next)
    }

    this.entries = next
    return next
  }

  private async persist(entries: LocalMusicEntry[]): Promise<void> {
    const records: LocalMusicRecord[] = entries.map((entry) => ({
      id: entry.id,
      fileUri: entry.fileUri,
      fileName: entry.fileName,
      title: entry.title,
      artist: entry.artist,
      size: Number(entry.size || 0),
      format: entry.format,
      importedAt: Number(entry.importedAt || Date.now()),
    }))
    await replaceLocalMusicRecords(records)
  }

  private async list(): Promise<LocalMusicEntry[]> {
    if (!this.loadPromise) {
      this.loadPromise = this.hydrate().catch((error) => {
        console.warn('[LocalMusic] hydrate failed:', error)
        this.loadPromise = null
        return []
      })
    }
    return this.loadPromise
  }

  /** 全部本地歌曲（按导入时间倒序），文件已丢失的条目会带 missing 标记 */
  async getEntries(): Promise<LocalMusicEntry[]> {
    const entries = await this.list()
    return [...entries].sort((a, b) => b.importedAt - a.importedAt)
  }

  async getStats(): Promise<LocalMusicStats> {
    const entries = await this.list()
    let sizeBytes = 0
    let missingCount = 0
    for (const entry of entries) {
      if (entry.missing) {
        missingCount += 1
        continue
      }
      sizeBytes += Math.max(0, entry.size)
    }
    return { count: entries.length, sizeBytes, missingCount }
  }

  async getEntryById(id: string): Promise<LocalMusicEntry | null> {
    if (!id) return null
    const entries = await this.list()
    return entries.find((entry) => entry.id === id) || null
  }

  /**
   * 搜索/在线歌曲命中本地文件：
   * 1) 歌名 + 歌手都一致才算命中
   * 2) 文件名里没写歌手时，退化成"同歌名且唯一"
   */
  async findMatch(title?: string, artist?: string): Promise<LocalMusicEntry | null> {
    const targetTitle = normalizeForMatch(title)
    if (!targetTitle) return null
    const targetArtist = normalizeForMatch(artist)

    const entries = await this.list()
    const usable = entries.filter((entry) => !entry.missing)
    const sameTitle = usable.filter((entry) => normalizeForMatch(entry.title) === targetTitle)

    if (targetArtist) {
      const strictHit = sameTitle.find(
        (entry) => normalizeForMatch(entry.artist) === targetArtist
      )
      if (strictHit) return strictHit
      // 搜索侧带了歌手却没对上：只有本地文件本身没写歌手时才退化匹配，
      // 否则宁可放过也不要放错歌（同名不同歌手）。
      const unnamed = sameTitle.filter((entry) => !normalizeForMatch(entry.artist))
      return unnamed.length === 1 ? unnamed[0] : null
    }

    // 搜索侧没有歌手信息：同歌名且唯一才命中
    return sameTitle.length === 1 ? sameTitle[0] : null
  }

  /** 从 Files 选取的文件复制进 App 并登记；同名文件覆盖 */
  async importFiles(assets: LocalImportAsset[]): Promise<LocalImportResult> {
    const result: LocalImportResult = { imported: [], replaced: [], skipped: [] }
    if (!assets.length) return result

    const dir = await this.ensureDir()
    const entries = await this.list()
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const now = Date.now()

    for (const asset of assets) {
      const rawName = String(asset.name || asset.uri.split('/').pop() || '').trim()
      const fileName = rawName || `local_${Date.now()}.mp3`
      const format = getFileExtension(fileName)

      if (!AUDIO_EXTENSIONS.has(format)) {
        result.skipped.push({ name: fileName, reason: '不是支持的音频格式' })
        continue
      }

      try {
        const id = buildLocalMusicId(fileName)
        const existing = byId.get(id)
        // 磁盘上只用安全文件名（中文/空格放进 file:// URI 容易在播放器侧出问题），
        // 原始文件名保留在记录里用于展示。
        const storedName = `${id}_${Date.now()}_${result.imported.length + result.replaced.length}.${format}`
        const targetUri = `${dir}${storedName}`

        await FileSystem.copyAsync({ from: asset.uri, to: targetUri })

        const info = await FileSystem.getInfoAsync(targetUri)
        if (!info.exists) {
          throw new Error('复制后文件不存在')
        }

        // 新文件落盘成功后再删旧副本，避免复制失败时两头都没了
        if (existing) {
          await this.removeFileIfExists(existing.fileUri)
        }

        const parsed = parseTrackFileName(fileName)
        const entry: LocalMusicEntry = {
          id,
          fileUri: targetUri,
          fileName,
          title: parsed.title || '未知歌曲',
          artist: parsed.artist,
          size: typeof info.size === 'number' ? info.size : Number(asset.size || 0),
          format,
          importedAt: now,
        }

        byId.set(id, entry)
        if (existing) {
          result.replaced.push(entry)
        } else {
          result.imported.push(entry)
        }
      } catch (error) {
        console.warn('[LocalMusic] import failed:', fileName, error)
        result.skipped.push({
          name: fileName,
          reason: error instanceof Error ? error.message : '复制失败',
        })
      }
    }

    const nextEntries = Array.from(byId.values())
    await this.persist(nextEntries)
    this.entries = nextEntries
    return result
  }

  /** 删除一首本地歌曲（同时删掉 App 内的文件副本） */
  async removeEntry(id: string): Promise<boolean> {
    if (!id) return false
    const entries = await this.list()
    const target = entries.find((entry) => entry.id === id)
    if (!target) return false

    await this.removeFileIfExists(target.fileUri)
    const nextEntries = entries.filter((entry) => entry.id !== id)
    this.entries = nextEntries
    await deleteLocalMusicRecord(id)
    console.log(`[LocalMusic] Removed local track ${id} (${target.fileName})`)
    return true
  }

  /** 清掉文件已丢失的空记录 */
  async pruneMissing(): Promise<number> {
    const entries = await this.list()
    const missing = entries.filter((entry) => entry.missing)
    if (!missing.length) return 0
    this.entries = entries.filter((entry) => !entry.missing)
    await this.persist(this.entries)
    return missing.length
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
}

export const localMusicLibrary = new LocalMusicLibrary()
