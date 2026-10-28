import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  FlatList,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { PanGestureHandler } from 'react-native-gesture-handler'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { borderRadius, BOTTOM_INSET, fontSize, spacing, useTheme } from '../../theme'
import { discoverSourceList, getSongListPage, getSongListSortList, getSongListTags } from '../../core/discover'
import { emitScrollTopState, subscribeScrollToTop } from '../../core/ui/scrollToTopBus'
import { DiscoverSourceId, SongListItem, SongListTagInfo } from '../../types/discover'
import { useSwipeBack } from '../../hooks/useSwipeBack'
import { PlaylistCard } from './PlaylistSection'

interface SongListMorePageProps {
  source: DiscoverSourceId
  sortId: string
  tagId: string
  onBack: () => void
  onSourceChange: (source: DiscoverSourceId) => void
  onFiltersChange: (value: { sortId: string; tagId: string; tagName: string }) => void
  onPlaylistPress?: (playlist: SongListItem) => void
}

type LoadMode = 'initial' | 'refresh' | 'more'

function normalizeSortLabel(name: string): string {
  const key = String(name || '').toLowerCase()
  if (key.includes('new')) return '最新'
  if (key.includes('hot')) return '最热'
  if (key.includes('recommend')) return '推荐'
  if (key.includes('rise')) return '飙升'
  return name || '默认'
}

function dedupeTags(tags: SongListTagInfo[]): SongListTagInfo[] {
  const map = new Map<string, SongListTagInfo>()
  for (const item of tags) {
    if (!map.has(item.id)) map.set(item.id, item)
  }
  return Array.from(map.values())
}

/** 追加下一页时按 id 去重：部分平台的分页会有重叠条目 */
function appendPlaylists(prev: SongListItem[], next: SongListItem[]): SongListItem[] {
  if (!next.length) return prev
  const seen = new Set(prev.map((item) => item.id))
  const merged = [...prev]
  for (const item of next) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}

export default function SongListMorePage({
  source,
  sortId,
  tagId,
  onBack,
  onSourceChange,
  onFiltersChange,
  onPlaylistPress,
}: SongListMorePageProps) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { panX, panGesture } = useSwipeBack(onBack)

  const [localSortId, setLocalSortId] = useState(sortId)
  const [localTagId, setLocalTagId] = useState(tagId)
  const [tags, setTags] = useState<SongListTagInfo[]>([])
  const [hotTags, setHotTags] = useState<SongListTagInfo[]>([])
  const [tagsLoading, setTagsLoading] = useState(false)
  const [tagsError, setTagsError] = useState<string | null>(null)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [playlistError, setPlaylistError] = useState<string | null>(null)
  const [playlists, setPlaylists] = useState<SongListItem[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [showTagDropdown, setShowTagDropdown] = useState(false)
  const [showSourceDropdown, setShowSourceDropdown] = useState(false)
  const [reloadSeed, setReloadSeed] = useState(0)

  // 分页状态
  const [page, setPage] = useState(1)
  const [maxPage, setMaxPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const pageRef = useRef(1)
  const loadingMoreRef = useRef(false)
  const requestIdRef = useRef(0)
  const listRef = useRef<FlatList<SongListItem> | null>(null)

  const sortList = useMemo(() => getSongListSortList(source), [source])
  const safeSortId = localSortId || sortList[0]?.id || 'new'
  const hasMore = page < maxPage

  useEffect(() => {
    const fallbackSortId = sortList[0]?.id || ''
    setLocalSortId(sortId || fallbackSortId)
    setLocalTagId(tagId || '')
    setShowTagDropdown(false)
    setShowSourceDropdown(false)
  }, [sortId, tagId, sortList])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        setTagsLoading(true)
        setTagsError(null)
        const data = await getSongListTags(source)
        if (!active) return
        setTags(data.tags || [])
        setHotTags(data.hotTags || [])
      } catch {
        if (!active) return
        setTagsError(`${source.toUpperCase()} 标签加载失败`)
      } finally {
        if (!active) return
        setTagsLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [source, reloadSeed])

  const allTags = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of dedupeTags([...hotTags, ...tags])) {
      const id = String(item.id || '').trim()
      const name = String(item.name || '').trim()
      if (!id || !name) continue
      if (id.toLowerCase() === 'undefined' || name.toLowerCase() === 'undefined') continue
      if (id.toLowerCase() === 'null' || name.toLowerCase() === 'null') continue
      map.set(id, name)
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [hotTags, tags])

  const tagNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of allTags) map.set(item.id, item.name)
    return map
  }, [allTags])

  const selectedTagName = localTagId ? (tagNameMap.get(localTagId) || '未知标签') : '全部标签'

  /**
   * 加载歌单列表。
   * 各平台的分页参数差异（wy 用 offset、tx 用 cur_page、mg 用 pageNo/pageNumber…）
   * 都已经收敛在 core/discover 的各平台 adapter 里，这里只负责传第几页 + 拼接结果。
   */
  const loadPlaylists = useCallback(
    async (mode: LoadMode = 'initial') => {
      const isMore = mode === 'more'
      // 只拦重复的"加载更多"；切平台/排序/标签必须能立刻发起新请求，
      // 旧请求的结果由 requestId 作废。
      if (isMore && loadingMoreRef.current) return
      if (isMore) loadingMoreRef.current = true

      const requestId = ++requestIdRef.current
      const targetPage = isMore ? pageRef.current + 1 : 1

      try {
        if (mode === 'refresh') setRefreshing(true)
        else if (isMore) setLoadingMore(true)
        else setPlaylistLoading(true)

        if (isMore) setLoadMoreError(null)
        else setPlaylistError(null)

        const result = await getSongListPage({
          source,
          sortId: safeSortId,
          tagId: localTagId || '',
          page: targetPage,
          refresh: mode === 'refresh',
        })

        // 期间切了平台/排序/标签，丢弃这次结果
        if (requestId !== requestIdRef.current) return

        const list = result.list || []
        // 出错时 core 层会退回"该平台最近一次成功的分页"，此时 result.page 会小于
        // 请求的页码。以返回值为准，避免页码跳过没取到的那一页。
        const resolvedPage = Number(result.page) > 0 ? Number(result.page) : targetPage
        // 平台没给 maxPage 时，按"这一页是否装满"判断还有没有下一页
        const reportedMaxPage = Number(result.maxPage || 0)
        const limit = Number(result.limit || 0)
        const inferredMaxPage = limit > 0 && list.length < limit ? resolvedPage : resolvedPage + 1
        const nextMaxPage = Math.max(
          resolvedPage,
          reportedMaxPage > 0 ? reportedMaxPage : inferredMaxPage
        )

        setPlaylists((prev) => (isMore ? appendPlaylists(prev, list) : list))
        pageRef.current = resolvedPage
        setPage(resolvedPage)
        setMaxPage(list.length ? nextMaxPage : resolvedPage)
        setTotal(Number(result.total || 0))
      } catch {
        if (requestId !== requestIdRef.current) return
        if (isMore) {
          setLoadMoreError('加载更多失败')
        } else {
          setPlaylistError(`${source.toUpperCase()} 歌单加载失败`)
          setPlaylists([])
          pageRef.current = 1
          setPage(1)
          setMaxPage(1)
        }
      } finally {
        if (isMore) loadingMoreRef.current = false
        if (requestId === requestIdRef.current) {
          setPlaylistLoading(false)
          setRefreshing(false)
          setLoadingMore(false)
        }
      }
    },
    [source, safeSortId, localTagId]
  )

  // 平台 / 排序 / 标签变化时回到第一页
  useEffect(() => {
    void loadPlaylists('initial')
  }, [loadPlaylists])

  useEffect(() => {
    return subscribeScrollToTop(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: true })
    })
  }, [])

  const handleContentScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    emitScrollTopState(event.nativeEvent.contentOffset.y <= 4)
  }, [])

  const handleEndReached = useCallback(() => {
    if (!hasMore || loadingMoreRef.current) return
    void loadPlaylists('more')
  }, [hasMore, loadPlaylists])

  const handleSortSelect = useCallback((nextSortId: string) => {
    const resolvedSortId = nextSortId || sortList[0]?.id || 'new'
    const tagName = localTagId ? (tagNameMap.get(localTagId) || '') : ''
    setLocalSortId(resolvedSortId)
    onFiltersChange({
      sortId: resolvedSortId,
      tagId: localTagId,
      tagName,
    })
  }, [sortList, localTagId, tagNameMap, onFiltersChange])

  const handleTagSelect = useCallback((nextTagId: string) => {
    const tagName = nextTagId ? (tagNameMap.get(nextTagId) || '') : ''
    setLocalTagId(nextTagId)
    setShowTagDropdown(false)
    onFiltersChange({
      sortId: safeSortId,
      tagId: nextTagId,
      tagName,
    })
  }, [safeSortId, tagNameMap, onFiltersChange])

  const handleSourceSelect = useCallback((nextSource: DiscoverSourceId) => {
    setShowSourceDropdown(false)
    setShowTagDropdown(false)
    if (nextSource !== source) {
      onSourceChange(nextSource)
    }
  }, [source, onSourceChange])

  const handleRefresh = useCallback(() => {
    void loadPlaylists('refresh')
  }, [loadPlaylists])

  const renderChip = useCallback(
    (
      key: string,
      label: string,
      active: boolean,
      onPress: () => void
    ) => (
      <TouchableOpacity
        key={key}
        style={[
          styles.chip,
          {
            backgroundColor: active ? colors.accent : colors.surface,
            borderColor: active ? colors.accent : colors.separator,
          },
        ]}
        onPress={onPress}
        activeOpacity={0.85}
      >
        <Text
          style={[
            styles.chipText,
            { color: active ? '#fff' : colors.textSecondary },
          ]}
        >
          {label}
        </Text>
      </TouchableOpacity>
    ),
    [colors]
  )

  const renderTagChip = useCallback((id: string, name: string) => {
    const active = localTagId === id
    return (
      <TouchableOpacity
        key={`dropdown-tag-${id || 'all'}`}
        style={[
          styles.dropdownTagChip,
          {
            backgroundColor: active ? colors.accentLight : colors.surface,
            borderColor: active ? colors.accent : colors.separator,
          },
        ]}
        onPress={() => handleTagSelect(id)}
        activeOpacity={0.85}
      >
        <Text
          style={[styles.dropdownTagChipText, { color: active ? colors.accent : colors.textSecondary }]}
          numberOfLines={1}
        >
          {name}
        </Text>
      </TouchableOpacity>
    )
  }, [localTagId, colors, handleTagSelect])

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SongListItem>) => (
      <View style={styles.cardColumn}>
        <PlaylistCard item={item} onPress={() => onPlaylistPress?.(item)} />
      </View>
    ),
    [onPlaylistPress]
  )

  const listHeader = (
    <>
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>排序</Text>
        <View style={styles.chipWrap}>
          {sortList.map(item =>
            renderChip(
              `sort-${item.id}`,
              normalizeSortLabel(item.name),
              localSortId === item.id,
              () => handleSortSelect(item.id)
            )
          )}
        </View>
      </View>

      <View style={[styles.section, showTagDropdown && styles.tagSectionOnTop]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>标签</Text>
        <View style={styles.tagSelectArea}>
          <TouchableOpacity
            style={[
              styles.tagSelectButton,
              {
                backgroundColor: colors.surface,
                borderColor: colors.separator,
              },
            ]}
            onPress={() => {
              setShowTagDropdown(v => !v)
              setShowSourceDropdown(false)
            }}
            activeOpacity={0.85}
          >
            <Text style={[styles.tagSelectText, { color: colors.text }]}>
              {selectedTagName}
            </Text>
            <Ionicons
              name={showTagDropdown ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.textSecondary}
            />
          </TouchableOpacity>

          {showTagDropdown && (
            <View
              style={[
                styles.dropdown,
                {
                  backgroundColor: colors.surfaceElevated,
                  borderColor: colors.separator,
                },
              ]}
            >
              <ScrollView
                nestedScrollEnabled
                style={styles.dropdownScroll}
                contentContainerStyle={styles.dropdownTagWrap}
                showsVerticalScrollIndicator={false}
              >
                {renderTagChip('', '全部标签')}
                {allTags.map(item => renderTagChip(item.id, item.name))}
              </ScrollView>
            </View>
          )}
        </View>

        {tagsLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : null}

        {!!tagsError && (
          <View style={styles.errorRow}>
            <Text style={[styles.errorText, { color: colors.textSecondary }]}>{tagsError}</Text>
            <TouchableOpacity onPress={() => setReloadSeed(v => v + 1)} activeOpacity={0.8}>
              <Text style={[styles.retryText, { color: colors.accent }]}>重试</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.resultHeaderRow}>
          <Text style={[styles.sectionTitle, styles.resultTitle, { color: colors.text }]}>歌单结果</Text>
          <Text style={[styles.resultCount, { color: colors.textSecondary }]}>
            {playlistLoading
              ? '加载中...'
              : total > 0
                ? `共 ${total} 个 · 第 ${page}/${maxPage} 页`
                : `已加载 ${playlists.length} 个`}
          </Text>
        </View>
      </View>
    </>
  )

  const listEmpty = playlistLoading ? (
    <View style={styles.loadingRow}>
      <ActivityIndicator size="small" color={colors.accent} />
    </View>
  ) : playlistError ? (
    <View style={styles.errorRow}>
      <Text style={[styles.errorText, { color: colors.textSecondary }]}>{playlistError}</Text>
      <TouchableOpacity onPress={() => void loadPlaylists('initial')} activeOpacity={0.8}>
        <Text style={[styles.retryText, { color: colors.accent }]}>重试</Text>
      </TouchableOpacity>
    </View>
  ) : (
    <View style={styles.loadingRow}>
      <Text style={[styles.errorText, { color: colors.textSecondary }]}>没有找到歌单</Text>
    </View>
  )

  const listFooter = playlists.length ? (
    <View style={styles.footer}>
      {loadingMore ? (
        <View style={styles.footerRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.footerText, { color: colors.textSecondary }]}>
            正在加载第 {page + 1} 页...
          </Text>
        </View>
      ) : loadMoreError ? (
        <TouchableOpacity
          style={[styles.footerButton, { borderColor: colors.separator }]}
          onPress={() => void loadPlaylists('more')}
          activeOpacity={0.85}
        >
          <Ionicons name="refresh" size={14} color={colors.accent} />
          <Text style={[styles.footerButtonText, { color: colors.accent }]}>{loadMoreError}，点击重试</Text>
        </TouchableOpacity>
      ) : hasMore ? (
        <TouchableOpacity
          style={[styles.footerButton, { borderColor: colors.separator }]}
          onPress={() => void loadPlaylists('more')}
          activeOpacity={0.85}
        >
          <Ionicons name="chevron-down" size={14} color={colors.accent} />
          <Text style={[styles.footerButtonText, { color: colors.accent }]}>
            加载更多（第 {page + 1} 页）
          </Text>
        </TouchableOpacity>
      ) : (
        <Text style={[styles.footerText, { color: colors.textTertiary }]}>
          已经到底了 · 共 {playlists.length} 个歌单
        </Text>
      )}
    </View>
  ) : null

  return (
    <PanGestureHandler
      hitSlop={panGesture.hitSlop}
      activeOffsetX={panGesture.activeOffsetX}
      failOffsetY={panGesture.failOffsetY}
      onGestureEvent={panGesture.onGestureEvent}
      onHandlerStateChange={panGesture.onHandlerStateChange}
    >
      <Animated.View
        style={[
          styles.container,
          {
            backgroundColor: colors.background,
            transform: [{ translateX: panX }],
          },
        ]}
      >
        <View
          style={[
            styles.header,
            showSourceDropdown && styles.headerOnTop,
            {
              borderBottomColor: colors.separator,
              paddingTop: insets.top + spacing.sm,
            },
          ]}
        >
          <TouchableOpacity onPress={onBack} style={styles.iconBtn} activeOpacity={0.75}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={[styles.title, { color: colors.text }]}>歌单筛选</Text>
            <View style={styles.sourceSelectArea}>
              <TouchableOpacity
                style={[
                  styles.sourceSelectTrigger,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.separator,
                  },
                ]}
                onPress={() => {
                  setShowSourceDropdown(v => !v)
                  setShowTagDropdown(false)
                }}
                activeOpacity={0.85}
              >
                <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
                  当前平台：{source.toUpperCase()}
                </Text>
                <Ionicons
                  name={showSourceDropdown ? 'chevron-up' : 'chevron-down'}
                  size={14}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>

              {showSourceDropdown && (
                <View
                  style={[
                    styles.sourceDropdown,
                    {
                      backgroundColor: colors.surfaceElevated,
                      borderColor: colors.separator,
                    },
                  ]}
                >
                  {discoverSourceList.map(item => {
                    const active = item.id === source
                    return (
                      <TouchableOpacity
                        key={`source-${item.id}`}
                        style={styles.sourceDropdownItem}
                        onPress={() => handleSourceSelect(item.id)}
                        activeOpacity={0.82}
                      >
                        <Text
                          style={[
                            styles.sourceDropdownText,
                            { color: active ? colors.accent : colors.text },
                          ]}
                        >
                          {item.name}
                        </Text>
                      </TouchableOpacity>
                    )
                  })}
                </View>
              )}
            </View>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <FlatList
          ref={listRef}
          data={playlists}
          numColumns={2}
          keyExtractor={(item, index) => `${item.id}_${index}`}
          renderItem={renderItem}
          columnWrapperStyle={styles.gridRow}
          style={styles.content}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listFooter}
          onScroll={handleContentScroll}
          scrollEventThrottle={16}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.4}
          removeClippedSubviews={false}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
        />
      </Animated.View>
    </PanGestureHandler>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  headerOnTop: {
    zIndex: 60,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  title: {
    fontSize: fontSize.headline,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: fontSize.caption1,
    fontWeight: '600',
  },
  sourceSelectArea: {
    marginTop: spacing.xs,
    width: 140,
    position: 'relative',
    zIndex: 70,
  },
  sourceSelectTrigger: {
    height: 30,
    borderWidth: 1,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sourceDropdown: {
    position: 'absolute',
    top: 34,
    left: 0,
    right: 0,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 80,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
    elevation: 12,
  },
  sourceDropdownItem: {
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceDropdownText: {
    fontSize: fontSize.caption1,
    fontWeight: '700',
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.md,
  },
  listContent: {
    paddingBottom: BOTTOM_INSET + spacing.xxl,
  },
  gridRow: {
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  cardColumn: {
    width: '48%',
  },
  section: {
    marginTop: spacing.lg,
  },
  tagSectionOnTop: {
    zIndex: 30,
  },
  sectionTitle: {
    fontSize: fontSize.title3,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  resultHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  resultTitle: {
    marginBottom: 0,
  },
  resultCount: {
    fontSize: fontSize.caption1,
    fontWeight: '600',
  },
  groupTitle: {
    fontSize: fontSize.footnote,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  tagSelectArea: {
    position: 'relative',
  },
  tagSelectButton: {
    height: 44,
    borderWidth: 1,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tagSelectText: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  dropdown: {
    position: 'absolute',
    top: 44 + spacing.sm,
    left: 0,
    right: 0,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 40,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
    elevation: 12,
  },
  dropdownScroll: {
    maxHeight: 260,
  },
  dropdownTagWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    padding: spacing.md,
  },
  dropdownTagChip: {
    borderRadius: borderRadius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    maxWidth: '100%',
  },
  dropdownTagChipText: {
    fontSize: fontSize.footnote,
    fontWeight: '600',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    borderRadius: borderRadius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipText: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  loadingRow: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  errorRow: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  errorText: {
    fontSize: fontSize.footnote,
  },
  retryText: {
    fontSize: fontSize.footnote,
    fontWeight: '700',
  },
  footer: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    alignItems: 'center',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  footerText: {
    fontSize: fontSize.footnote,
  },
  footerButton: {
    minWidth: 160,
    height: 38,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  footerButtonText: {
    fontSize: fontSize.footnote,
    fontWeight: '700',
  },
})
