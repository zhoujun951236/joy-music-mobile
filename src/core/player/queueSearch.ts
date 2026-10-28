import type { Track } from '../../types/music'

/**
 * 播放列表内搜索。
 *
 * 抽成纯函数模块有两个原因：
 * 1. QueueSheet 里带了 RN / gesture-handler，直接测组件跑不起来；
 * 2. 搜索必须"只过滤显示、不改真实队列"，下标映射是这件事的核心，值得单独测。
 */

/** 归一化搜索词：去掉首尾空格并转小写 */
export function normalizeQueueQuery(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toLowerCase()
}

/**
 * 命中判定：歌名 / 歌手 / 专辑任一字段包含搜索词即算命中。
 * 忽略大小写；空搜索词视为全部命中。
 */
export function matchesQueueSearch(track: Track | null | undefined, rawQuery: string): boolean {
  const query = normalizeQueueQuery(rawQuery)
  if (!query) return true
  if (!track) return false
  const fields = [track.title, track.artist, track.album]
  return fields.some((field) => String(field ?? '').toLowerCase().includes(query))
}

/**
 * 过滤队列并保留每一项在【原队列】中的下标。
 *
 * 调用方必须用这里的 index 去做播放 / 排序等操作：
 * playerController.playFromPlaylist(list, index) 会把传入的 list 整条写进队列，
 * 如果拿筛选后的下标去操作，就会把播放列表替换成只剩匹配的那几首。
 */
export function filterQueueWithIndex(
  queue: Track[],
  rawQuery: string
): Array<{ track: Track; index: number }> {
  const list = Array.isArray(queue) ? queue : []
  const result: Array<{ track: Track; index: number }> = []
  list.forEach((track, index) => {
    if (matchesQueueSearch(track, rawQuery)) result.push({ track, index })
  })
  return result
}
