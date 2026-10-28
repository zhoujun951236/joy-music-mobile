import {
  DiscoverSourceId,
  LeaderboardBoardList,
  LeaderboardDetail,
  SongListDetail,
  SongListPage,
  SongListSortInfo,
  SongListTagInfo,
} from '../../../types/discover'

export interface DiscoverSourceAdapter {
  id: DiscoverSourceId
  name: string
  songList: {
    sortList: SongListSortInfo[]
    /**
     * 选中标签后排序是否仍然生效。
     * 部分平台的标签接口（如 QQ 的 get_category_content）不接受排序参数，
     * 此时 UI 应当把排序选项置灰，避免出现"点了没反应"。缺省为 true。
     */
    sortAppliesWithTag?: boolean
    getTags: () => Promise<{ tags: SongListTagInfo[]; hotTags: SongListTagInfo[] }>
    getList: (sortId: string, tagId: string, page: number) => Promise<SongListPage>
    getListDetail: (id: string, page: number) => Promise<SongListDetail>
  }
  leaderboard: {
    getBoards: () => Promise<LeaderboardBoardList>
    getList: (boardId: string, page: number) => Promise<LeaderboardDetail>
  }
}
