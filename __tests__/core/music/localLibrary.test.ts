/**
 * 本地音乐库：文件名解析与"搜索命中本地文件"匹配规则
 */

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///var/mobile/Containers/Data/Application/UUID/Documents/',
  cacheDirectory: 'file:///var/mobile/Containers/Data/Application/UUID/Caches/',
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  makeDirectoryAsync: jest.fn(async () => undefined),
  copyAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
}))

jest.mock('../../../src/core/music/cacheSqlite', () => ({
  loadLocalMusicRecords: jest.fn(async () => []),
  insertLocalMusicRecords: jest.fn(async () => undefined),
  deleteLocalMusicRecord: jest.fn(async () => undefined),
  replaceLocalMusicRecords: jest.fn(async () => undefined),
}))

import {
  localMusicLibrary,
  normalizeForMatch,
  parseTrackFileName,
} from '../../../src/core/music/localLibrary'
import * as cacheSqlite from '../../../src/core/music/cacheSqlite'

const seededRecords = [
  {
    id: 'local_a',
    fileUri: 'file:///docs/joy_local_music/local_a.mp3',
    fileName: '晴天-周杰伦.mp3',
    title: '晴天',
    artist: '周杰伦',
    size: 4000,
    format: 'mp3',
    importedAt: 100,
  },
  {
    id: 'local_b',
    fileUri: 'file:///docs/joy_local_music/local_b.flac',
    fileName: '演员-薛之谦.flac',
    title: '演员',
    artist: '薛之谦',
    size: 8000,
    format: 'flac',
    importedAt: 200,
  },
  {
    id: 'local_c',
    fileUri: 'file:///docs/joy_local_music/local_c.mp3',
    fileName: ' later.mp3',
    title: 'Later',
    artist: '',
    size: 2000,
    format: 'mp3',
    importedAt: 300,
  },
  {
    id: 'local_d',
    fileUri: 'file:///docs/joy_local_music/local_d.mp3',
    fileName: '好人好梦-孙悦&邰正宵.mp3',
    title: '好人好梦',
    artist: '孙悦&邰正宵',
    size: 5000,
    format: 'mp3',
    importedAt: 400,
  },
]

beforeAll(() => {
  ;(cacheSqlite.loadLocalMusicRecords as jest.Mock).mockResolvedValue(seededRecords)
})

describe('parseTrackFileName', () => {
  const cases: Array<[string, string, string]> = [
    ['晴天-周杰伦.mp3', '晴天', '周杰伦'],
    ['晴天 - 周杰伦.mp3', '晴天', '周杰伦'],
    ['晴天 -周杰伦.flac', '晴天', '周杰伦'],
    ['晴天- 周杰伦.wav', '晴天', '周杰伦'],
    ['告白气球 - 周杰伦 - Live版.mp3', '告白气球', '周杰伦'],
    ['A-Lin-给我一个理由忘记.mp3', 'A-Lin', '给我一个理由忘记'],
    ['晴天 (Live) - 周杰伦.mp3', '晴天', '周杰伦'],
    ['晴天.mp3', '晴天', ''],
    ['  演员 - 薛之谦  .m4a', '演员', '薛之谦'],
    ['好人好梦-孙悦&邰正宵.mp3', '好人好梦', '孙悦&邰正宵'],
  ]

  it.each(cases)('%s -> %s / %s', (fileName, title, artist) => {
    expect(parseTrackFileName(fileName)).toEqual({ title, artist })
  })
})

describe('normalizeForMatch', () => {
  it('忽略大小写与空格', () => {
    expect(normalizeForMatch('Taylor Swift')).toBe(normalizeForMatch('taylor  swift'))
  })

  it('忽略标点与括号装饰', () => {
    expect(normalizeForMatch('后来 (Live)')).toBe(normalizeForMatch('后来'))
    expect(normalizeForMatch('A-Lin')).toBe(normalizeForMatch('a lin'))
  })
})

describe('localMusicLibrary.findMatch', () => {
  it('歌名 + 歌手都一致才命中', async () => {
    await expect(localMusicLibrary.findMatch('晴天', '周杰伦')).resolves.toMatchObject({
      id: 'local_a',
    })
    await expect(localMusicLibrary.findMatch('演员', '薛之谦')).resolves.toMatchObject({
      id: 'local_b',
    })
  })

  it('歌手不一致时不命中（避免同名不同人放错）', async () => {
    await expect(localMusicLibrary.findMatch('晴天', '林俊杰')).resolves.toBeNull()
  })

  it('本地文件没写歌手时，同歌名且唯一才命中', async () => {
    await expect(localMusicLibrary.findMatch('Later', '任何人')).resolves.toMatchObject({
      id: 'local_c',
    })
  })

  it('歌名不存在时不命中', async () => {
    await expect(localMusicLibrary.findMatch('不存在的歌', '周杰伦')).resolves.toBeNull()
  })

  it('对唱歌曲：分隔符不同也算同一批歌手', async () => {
    // 本地文件名是「孙悦&邰正宵」，搜索结果常写成「孙悦;邰正宵」「孙悦、邰正宵」
    await expect(localMusicLibrary.findMatch('好人好梦', '孙悦;邰正宵')).resolves.toMatchObject({
      id: 'local_d',
    })
    await expect(localMusicLibrary.findMatch('好人好梦', '孙悦、邰正宵')).resolves.toMatchObject({
      id: 'local_d',
    })
    await expect(localMusicLibrary.findMatch('好人好梦', '孙悦/邰正宵')).resolves.toMatchObject({
      id: 'local_d',
    })
  })

  it('对唱歌曲：搜索结果只写其中一位歌手也能命中', async () => {
    await expect(localMusicLibrary.findMatch('好人好梦', '孙悦')).resolves.toMatchObject({
      id: 'local_d',
    })
  })

  it('对唱歌曲：换成完全不同的歌手仍然不命中', async () => {
    await expect(localMusicLibrary.findMatch('好人好梦', '张学友')).resolves.toBeNull()
  })
})
