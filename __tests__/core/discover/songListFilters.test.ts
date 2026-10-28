/**
 * 歌单筛选参数回归测试。
 *
 * 对应线上问题：歌单筛选页里排序 / 标签 / 页码点了没反应。
 * 根因是 UI 声明的能力和 adapter 真正发出去的参数对不上 —— 例如 KG 的
 * sortList 列了 推荐/最热/最新/飙升 四项，但 getList 从不把 sortId 发出去。
 *
 * 这里不发真实网络请求：把 http / wyCrypto 层 mock 掉，只检查
 * "最终请求指纹是否随用户选择变化"。
 */
import {
  getSongListPage,
  getSongListSortAppliesWithTag,
  getSongListSortList,
  getSongListTags,
} from '../../../src/core/discover'
import { clearDiscoverCache } from '../../../src/core/discover/cache'
import { discoverSourceList } from '../../../src/core/discover/sources'
import { httpRequest } from '../../../src/core/discover/http'
import { wyRequest } from '../../../src/core/discover/wyCrypto'

jest.mock('../../../src/core/discover/http', () => ({
  httpRequest: jest.fn(),
  withRetry: (fn: () => Promise<any>) => fn(),
}))

jest.mock('../../../src/core/discover/wyCrypto', () => ({
  wyRequest: jest.fn(),
}))

// core/discover/index 会拉进 settings → AsyncStorage（原生模块），测试里用官方 mock
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

const mockedHttpRequest = httpRequest as jest.MockedFunction<typeof httpRequest>
const mockedWyRequest = wyRequest as jest.MockedFunction<typeof wyRequest>

/** 本轮捕获到的请求指纹 */
const requestLog: string[] = []

/** 按域名返回各自能解析通过的最小响应体 */
function stubResponse(url: string): any {
  if (url.includes('nf.migu.cn')) return { code: '000000', data: {} }
  if (url.includes('u.y.qq.com')) return { code: 0, playlist: { data: { v_playlist: [] } } }
  if (url.includes('m.kugou.com')) return { plist: { list: { info: [], total: 0 }, pagesize: 30 } }
  if (url.includes('kuwo.cn')) return { data: { data: [], total: 0, rn: 36 } }
  if (url.includes('music.163.com')) return { playlists: [], total: 0 }
  return {}
}

/**
 * query 是在 httpRequest 内部才拼进 URL 的，wyCrypto 的参数则整体加密，
 * 所以这里要把第二个参数一起序列化，否则所有请求看起来都一样。
 */
function fingerprint(url: string, payload: unknown): string {
  return `${url}?${JSON.stringify(payload ?? null)}`
}

beforeEach(() => {
  clearDiscoverCache()
  requestLog.length = 0

  mockedHttpRequest.mockReset()
  mockedHttpRequest.mockImplementation(async (url: string, options?: any) => {
    requestLog.push(fingerprint(url, options?.query ?? options?.form ?? options?.body))
    return { status: 200, url, data: stubResponse(url) }
  })

  mockedWyRequest.mockReset()
  mockedWyRequest.mockImplementation(async (url: string, params?: any) => {
    requestLog.push(fingerprint(url, params))
    return { status: 200, url, data: stubResponse(url) }
  })
})

/** 执行一次调用，返回期间发出的所有请求指纹 */
async function captureRequests(fn: () => Promise<unknown>): Promise<string> {
  const before = requestLog.length
  await fn()
  return requestLog.slice(before).join(' | ')
}

const sourceIds = discoverSourceList.map((item) => item.id)

describe('歌单筛选：UI 展示的筛选项必须真的发给平台', () => {
  it.each(sourceIds)('%s 的每个排序项都产生不同的请求', async (source) => {
    const sortList = getSongListSortList(source)
    expect(sortList.length).toBeGreaterThan(0)

    const requests: string[] = []
    for (const sort of sortList) {
      requests.push(
        await captureRequests(() =>
          getSongListPage({ source, sortId: sort.id, tagId: '', page: 1 })
        )
      )
    }

    requests.forEach((entry) => expect(entry.length).toBeGreaterThan(0))
    if (sortList.length > 1) {
      // 能在界面上点的排序项，必须真的改变请求，否则就是"点了没反应"
      expect(new Set(requests).size).toBe(requests.length)
    }
  })

  it.each(sourceIds)('%s 的第 2 页请求和第 1 页不同', async (source) => {
    const sortId = getSongListSortList(source)[0].id
    const page1 = await captureRequests(() =>
      getSongListPage({ source, sortId, tagId: '', page: 1 })
    )
    const page2 = await captureRequests(() =>
      getSongListPage({ source, sortId, tagId: '', page: 2 })
    )
    expect(page1.length).toBeGreaterThan(0)
    expect(page2).not.toBe(page1)
  })

  it('kg 只声明一个排序项（m.kugou 歌单广场接口不认排序参数）', () => {
    expect(getSongListSortList('kg')).toHaveLength(1)
  })

  it('kg 不再返回无法生效的兜底标签', async () => {
    const { tags, hotTags } = await getSongListTags('kg')
    expect(tags).toHaveLength(0)
    expect(hotTags).toHaveLength(0)
  })

  it('tx 选中标签后排序不生效，其余平台仍生效', () => {
    expect(getSongListSortAppliesWithTag('tx')).toBe(false)
    expect(getSongListSortAppliesWithTag('kw')).toBe(true)
    expect(getSongListSortAppliesWithTag('wy')).toBe(true)
    expect(getSongListSortAppliesWithTag('kg')).toBe(true)
  })

  it('kw 只暴露 getTagPlayList 能用的标签（digest=10000）', async () => {
    mockedHttpRequest.mockImplementation(async (url: string) => {
      if (url.includes('getTagList')) {
        return {
          status: 200,
          url,
          data: {
            data: [
              {
                id: 'g1',
                name: '分类',
                data: [
                  { id: 'a1', digest: 10000, name: '可用' },
                  { id: 'a2', digest: 43, name: '不可用' },
                ],
              },
            ],
          },
        }
      }
      if (url.includes('getRcmTagList')) {
        return {
          status: 200,
          url,
          data: {
            data: [
              {
                data: [
                  { id: 'h1', digest: 10000, name: '热门可用' },
                  { id: 'h2', digest: 8, name: '热门不可用' },
                ],
              },
            ],
          },
        }
      }
      return { status: 200, url, data: stubResponse(url) }
    })

    const { tags, hotTags } = await getSongListTags('kw')
    expect(tags.map((item) => item.id)).toEqual(['a1-10000'])
    expect(hotTags.map((item) => item.id)).toEqual(['h1-10000'])
  })
})
