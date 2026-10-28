/**
 * 播放列表内搜索的单元测试。
 *
 * 重点是那条不变式：搜索只过滤显示，操作必须映射回真实队列 ——
 * 因为 playerController.playFromPlaylist(list, index) 会把传入的 list
 * 整条写进队列（this.playlist = [...playlist]），拿筛选后的数组/下标
 * 去播放就会把播放列表截断成只剩匹配的那几首。
 */
import {
  filterQueueWithIndex,
  matchesQueueSearch,
  normalizeQueueQuery,
} from '../../../src/core/player/queueSearch'
import type { Track } from '../../../src/types/music'

function makeTrack(partial: Partial<Track> & { id: string; title: string }): Track {
  return {
    artist: '',
    duration: 240,
    url: '',
    ...partial,
  } as Track
}

const queue: Track[] = [
  makeTrack({ id: '1', title: '晴天', artist: '周杰伦', album: '叶惠美' }),
  makeTrack({ id: '2', title: '稻香', artist: '周杰伦', album: '魔杰座' }),
  makeTrack({ id: '3', title: 'Hello', artist: 'Adele', album: '25' }),
  makeTrack({ id: '4', title: '夜曲', artist: '周杰伦', album: '十一月的萧邦' }),
  makeTrack({ id: '5', title: 'Shape of You', artist: 'Ed Sheeran' }),
]

describe('normalizeQueueQuery', () => {
  it('去首尾空格并转小写', () => {
    expect(normalizeQueueQuery('  HeLLo  ')).toBe('hello')
  })

  it('空值归一化成空串', () => {
    expect(normalizeQueueQuery('')).toBe('')
    expect(normalizeQueueQuery('   ')).toBe('')
    expect(normalizeQueueQuery(null)).toBe('')
    expect(normalizeQueueQuery(undefined)).toBe('')
  })
})

describe('matchesQueueSearch', () => {
  it('空搜索词命中所有歌曲', () => {
    queue.forEach((track) => expect(matchesQueueSearch(track, '')).toBe(true))
    queue.forEach((track) => expect(matchesQueueSearch(track, '   ')).toBe(true))
  })

  it('按歌名匹配，忽略大小写', () => {
    expect(matchesQueueSearch(queue[2], 'hello')).toBe(true)
    expect(matchesQueueSearch(queue[2], 'HELLO')).toBe(true)
    expect(matchesQueueSearch(queue[4], 'shape')).toBe(true)
  })

  it('按歌手匹配', () => {
    expect(matchesQueueSearch(queue[0], '周杰伦')).toBe(true)
    expect(matchesQueueSearch(queue[2], '周杰伦')).toBe(false)
  })

  it('按专辑匹配', () => {
    expect(matchesQueueSearch(queue[0], '叶惠美')).toBe(true)
    expect(matchesQueueSearch(queue[1], '叶惠美')).toBe(false)
  })

  it('搜索词带空格也能匹配', () => {
    expect(matchesQueueSearch(queue[4], '  ed sheeran ')).toBe(true)
  })

  it('空字段不会误命中', () => {
    // queue[4] 没有专辑，搜空串以外的东西不该因为 album 为空而命中
    expect(matchesQueueSearch(queue[4], '叶惠美')).toBe(false)
    expect(matchesQueueSearch(null, 'a')).toBe(false)
  })
})

describe('filterQueueWithIndex', () => {
  it('保留命中项在原队列中的下标', () => {
    const matches = filterQueueWithIndex(queue, '周杰伦')
    expect(matches.map((item) => item.index)).toEqual([0, 1, 3])
    expect(matches.map((item) => item.track.id)).toEqual(['1', '2', '4'])
  })

  it('空搜索词返回全部且下标连续', () => {
    const matches = filterQueueWithIndex(queue, '')
    expect(matches).toHaveLength(queue.length)
    expect(matches.map((item) => item.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('无命中时返回空数组', () => {
    expect(filterQueueWithIndex(queue, '不存在的歌')).toEqual([])
  })

  it('点击命中项时，用原队列 + 原始下标不会截断播放列表', () => {
    const matches = filterQueueWithIndex(queue, '周杰伦')
    // 只匹配到 3 首，比原队列少
    expect(matches.length).toBeLessThan(queue.length)

    // 组件点击命中项时的实际行为：playFromPlaylist(完整队列, 原始下标)
    const tapped = matches[2] // 夜曲，真实下标 3
    const playlist = [...queue]
    const currentIndex = tapped.index

    expect(playlist).toHaveLength(queue.length) // 队列没有被替换成筛选结果
    expect(playlist[currentIndex]).toBe(tapped.track) // 播的就是点的那首
    expect(currentIndex).toBe(3)
  })

  it('非法输入不抛错', () => {
    expect(filterQueueWithIndex(undefined as any, 'a')).toEqual([])
    expect(filterQueueWithIndex(queue, undefined as any)).toHaveLength(queue.length)
  })
})
