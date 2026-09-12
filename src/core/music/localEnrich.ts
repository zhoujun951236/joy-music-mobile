/**
 * 本地歌曲联网补全。
 *
 * 用歌名 + 歌手去在线曲库搜一次，拿到封面和在线曲目 id 存进本地索引。
 * 播放依旧走本地文件（getMusicUrl 的 Step 0 会命中），这里只补元数据，
 * 让封面、歌词这些"只有在线曲目才有"的信息也能正常显示。
 */

import musicSearch from '../search'
import { DiscoverSourceId } from '../../types/discover'
import { Track } from '../../types/music'
import {
  isArtistMatch,
  localMusicLibrary,
  normalizeForMatch,
  type LocalMusicEntry,
} from './localLibrary'

/** 依次尝试的平台：酷我曲库最全，其次网易云、酷狗 */
const ENRICH_SOURCES: DiscoverSourceId[] = ['kw', 'wy', 'kg']

function pickBestMatch(list: Track[], entry: LocalMusicEntry): Track | null {
  const targetTitle = normalizeForMatch(entry.title)
  if (!targetTitle) return null

  const sameTitle = list.filter((track) => normalizeForMatch(track.title) === targetTitle)
  if (!sameTitle.length) return null

  if (normalizeForMatch(entry.artist)) {
    // 严格：歌手对不上就不要，避免把别人的封面/歌词挂到这首歌上
    return sameTitle.find((track) => isArtistMatch(entry.artist, track.artist)) || null
  }
  return sameTitle.length === 1 ? sameTitle[0] : null
}

/** 补全单首；已经有在线信息时直接返回 true */
export async function enrichLocalEntry(entry: LocalMusicEntry): Promise<boolean> {
  if (entry.onlineId || entry.coverUrl) return true
  const query = [entry.title, entry.artist].filter(Boolean).join(' ').trim()
  if (!query) return false

  for (const source of ENRICH_SOURCES) {
    try {
      const result = await musicSearch.searchTracksBySource({
        query,
        source,
        page: 1,
        limit: 10,
      })
      const hit = pickBestMatch(result.list, entry)
      if (!hit) continue

      await localMusicLibrary.updateEntryMeta(entry.id, {
        coverUrl: hit.coverUrl || hit.picUrl || '',
        onlineId: hit.id,
        onlineSource: hit.source || source,
        songmid: hit.songmid || hit.id,
      })
      console.log(`[LocalMusic] Enriched "${entry.title}" via ${source} -> ${hit.id}`)
      return true
    } catch (error) {
      console.warn(`[LocalMusic] Enrich via ${source} failed for "${entry.title}":`, error)
    }
  }

  console.log(`[LocalMusic] No online match for "${entry.title} - ${entry.artist}"`)
  return false
}

/** 批量补全（串行，避免一次打太多请求），每首结束回调一次进度 */
export async function enrichLocalEntries(
  entries: LocalMusicEntry[],
  onProgress?: (done: number, total: number) => void
): Promise<{ ok: number; failed: number }> {
  const pending = entries.filter(
    (entry) => !entry.missing && !entry.onlineId && !entry.coverUrl
  )
  let ok = 0
  for (let index = 0; index < pending.length; index += 1) {
    const success = await enrichLocalEntry(pending[index])
    if (success) ok += 1
    onProgress?.(index + 1, pending.length)
  }
  return { ok, failed: pending.length - ok }
}
