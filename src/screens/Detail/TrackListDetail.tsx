/**
 * Track list detail screen for leaderboard/playlist detail views
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Image,
  Dimensions,
  Animated,
  NativeScrollEvent,
  NativeSyntheticEvent,
  TextInput,
} from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { BlurView } from 'expo-blur'
import { PanGestureHandler } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useSelector } from 'react-redux'
import { useTheme, spacing, fontSize, borderRadius, BOTTOM_INSET } from '../../theme'
import TrackListItem from '../../components/common/TrackListItem'
import { useSwipeBack } from '../../hooks/useSwipeBack'
import { Track, type TrackMoreActionHandler } from '../../types/music'
import { emitScrollTopState, subscribeScrollToTop } from '../../core/ui/scrollToTopBus'
import { normalizeImageUrl } from '../../utils/url'
import { filterQueueWithIndex, normalizeQueueQuery } from '../../core/player/queueSearch'
import { RootState } from '../../store'

const SCREEN_WIDTH = Dimensions.get('window').width
const HEADER_HEIGHT = 290

interface TrackListDetailProps {
  title: string
  description?: string
  coverUrl?: string
  gradientColors?: [string, string]
  tracks: Track[]
  onBack: () => void
  onTrackPress?: (track: Track) => void
  onTrackMorePress?: TrackMoreActionHandler
  onPlayAll?: () => void
  onFavorite?: () => void
  favoriteDisabled?: boolean
}

export default function TrackListDetail({
  title,
  description,
  coverUrl,
  gradientColors = ['#1C1C1E', '#000000'],
  tracks,
  onBack,
  onTrackPress,
  onTrackMorePress,
  onPlayAll,
  onFavorite,
  favoriteDisabled = false,
}: TrackListDetailProps) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const currentTrackId = useSelector((state: RootState) => state.player.currentTrack?.id || '')
  const isPlaying = useSelector((state: RootState) => state.player.isPlaying)
  const { panX, panGesture } = useSwipeBack(onBack)
  const listRef = useRef<FlatList<Track> | null>(null)

  /* ── 列表内搜索 ──
   *
   *   只过滤"显示"，不动数据源：
   *   - 播放全部 走的是 App 里的 detailView.tracks，与这里的过滤结果无关；
   *   - 点歌走 onTrackPress(track)，传的是对象不是下标。
   *   所以过滤不会改变播放队列，也不会让"播放全部"只播匹配到的那几首。
   */
  const [searchKeyword, setSearchKeyword] = useState('')
  const isSearchActive = normalizeQueueQuery(searchKeyword).length > 0

  /** 命中项 + 它们在【原歌单】里的下标，行号继续显示原始位置 */
  const matchedTracks = useMemo(
    () => filterQueueWithIndex(tracks, searchKeyword),
    [searchKeyword, tracks]
  )
  const visibleTracks = useMemo(() => matchedTracks.map((entry) => entry.track), [matchedTracks])
  const originalIndexByTrackId = useMemo(() => {
    const map = new Map<string, number>()
    matchedTracks.forEach((entry) => {
      if (!map.has(entry.track.id)) map.set(entry.track.id, entry.index)
    })
    return map
  }, [matchedTracks])

  const normalizedCoverUrl = useMemo(() => normalizeImageUrl(coverUrl, 500), [coverUrl])
  const headerCoverSource = useMemo(
    () => (normalizedCoverUrl ? { uri: normalizedCoverUrl } : undefined),
    [normalizedCoverUrl]
  )

  useEffect(() => {
    return subscribeScrollToTop(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: true })
    })
  }, [])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    emitScrollTopState(event.nativeEvent.contentOffset.y <= 4)
  }, [])

  useEffect(() => {
    emitScrollTopState(true)
  }, [])

  const listHeader = useMemo(() => (
    <View>
      {/* 沉浸式大底图：如果存在，把它拉伸并极致模糊当作背景 */}
      <View style={[styles.headerGradient, { paddingTop: insets.top, overflow: 'hidden' }]}>
        {headerCoverSource && (
          <Image
            source={headerCoverSource}
            style={StyleSheet.absoluteFillObject}
            blurRadius={90}
            fadeDuration={0}
          />
        )}
        {/* 背景暗化遮罩，确保文字可读 */}
        <LinearGradient
          colors={['rgba(0,0,0,0.2)', 'rgba(0,0,0,0.8)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />
        {/* 第二重 BlurView 进一步将背景光融化为液态感 */}
        <BlurView
          intensity={50}
          tint="dark"
          style={StyleSheet.absoluteFillObject}
        />

        {/* Back button */}
        <TouchableOpacity
          style={styles.backButton}
          onPress={onBack}
          activeOpacity={0.6}
        >
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>

        {/* Cover and info —— 现在封面变为居中内容的信息展示区 */}
        <View style={styles.headerContent}>
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle} numberOfLines={2}>{title}</Text>
            {description && (
              <Text style={styles.headerDescription} numberOfLines={3}>
                {description}
              </Text>
            )}
            <Text style={styles.headerCount}>{tracks.length} 首歌曲</Text>
          </View>
        </View>
      </View>

      {/* Play all button */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.playAllButton, { backgroundColor: colors.accent }]}
          onPress={onPlayAll}
          activeOpacity={0.8}
        >
          <Ionicons name="play" size={20} color="#FFFFFF" />
          <Text style={styles.playAllText}>播放全部</Text>
        </TouchableOpacity>
        {!!onFavorite && (
          <TouchableOpacity
            style={[
              styles.favoriteButton,
              {
                backgroundColor: favoriteDisabled ? colors.surfaceSecondary : colors.surface,
                borderColor: favoriteDisabled ? colors.separator : colors.accent,
              },
            ]}
            onPress={onFavorite}
            activeOpacity={favoriteDisabled ? 1 : 0.8}
            disabled={favoriteDisabled}
          >
            <Ionicons
              name="bookmark-outline"
              size={18}
              color={favoriteDisabled ? colors.textTertiary : colors.accent}
            />
            <Text
              style={[
                styles.favoriteText,
                { color: favoriteDisabled ? colors.textTertiary : colors.accent },
              ]}
            >
              收藏
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 搜索框：位于「播放全部 / 收藏」之下、第一首歌之上 */}
      <View
        style={[
          styles.searchRow,
          { backgroundColor: colors.surface, borderColor: colors.separator },
        ]}
      >
        <Ionicons name="search-outline" size={16} color={colors.textTertiary} />
        <TextInput
          value={searchKeyword}
          onChangeText={setSearchKeyword}
          placeholder="在本歌单中搜索歌名 / 歌手 / 专辑"
          placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.text }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          selectionColor={colors.accent}
        />
        {!!searchKeyword && (
          <TouchableOpacity
            style={styles.searchClearBtn}
            hitSlop={8}
            activeOpacity={0.7}
            onPress={() => setSearchKeyword('')}
          >
            <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>

      {isSearchActive && (
        <Text style={[styles.searchMeta, { color: colors.textSecondary }]}>
          匹配 {matchedTracks.length} / 共 {tracks.length} 首
        </Text>
      )}
    </View>
  ), [
    colors.accent,
    colors.separator,
    colors.surface,
    colors.surfaceSecondary,
    colors.text,
    colors.textSecondary,
    colors.textTertiary,
    description,
    favoriteDisabled,
    gradientColors,
    headerCoverSource,
    insets.top,
    isSearchActive,
    matchedTracks.length,
    onBack,
    onFavorite,
    onPlayAll,
    searchKeyword,
    title,
    tracks.length,
  ])

  const renderTrackItem = useCallback(({ item, index }: { item: Track; index: number }) => {
      // 搜索时 index 是"过滤后"的位置，行号要显示它在原歌单里的位置
      const originalIndex = originalIndexByTrackId.get(item.id) ?? index
      return (
        <TrackListItem
          track={item}
          index={originalIndex}
          showIndex
          isCurrentTrack={currentTrackId === item.id}
          isPlaying={isPlaying && currentTrackId === item.id}
          onPress={onTrackPress}
          onMorePress={onTrackMorePress}
        />
      )
    }, [currentTrackId, isPlaying, onTrackMorePress, onTrackPress, originalIndexByTrackId])

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
        <FlatList
          ref={listRef}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          data={visibleTracks}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                {isSearchActive
                  ? `没有找到与「${searchKeyword.trim()}」匹配的歌曲`
                  : '这个歌单还没有歌曲'}
              </Text>
              {isSearchActive && (
                <TouchableOpacity
                  style={styles.emptyAction}
                  activeOpacity={0.8}
                  onPress={() => setSearchKeyword('')}
                >
                  <Text style={[styles.emptyActionText, { color: colors.accent }]}>清空搜索</Text>
                </TouchableOpacity>
              )}
            </View>
          }
          // 搜索时键盘是弹起的，默认 "never" 会让第一次点击只用来收键盘、
          // 点不中歌曲行；"handled" 让点击直接命中。
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: BOTTOM_INSET + spacing.md }}
          renderItem={renderTrackItem}
        />
      </Animated.View>
    </PanGestureHandler>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  headerGradient: {
    height: HEADER_HEIGHT,
    padding: spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  headerContent: {
    flex: 1,
    paddingHorizontal: spacing.sm,
    justifyContent: 'flex-end',
    paddingBottom: spacing.md,
  },
  headerInfo: {
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  headerTitle: {
    fontSize: fontSize.largeTitle,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  headerDescription: {
    fontSize: fontSize.footnote,
    color: 'rgba(255,255,255,0.7)',
    lineHeight: 18,
  },
  headerCount: {
    fontSize: fontSize.caption1,
    color: 'rgba(255,255,255,0.5)',
    marginTop: spacing.xs,
  },
  actionRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    gap: spacing.sm,
  },
  playAllButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 44,
    borderRadius: borderRadius.md,
  },
  playAllText: {
    fontSize: fontSize.callout,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  favoriteButton: {
    minWidth: 104,
    height: 44,
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
  },
  favoriteText: {
    fontSize: fontSize.callout,
    fontWeight: '700',
  },
  searchRow: {
    marginHorizontal: spacing.md,
    // actionRow 已经有 paddingVertical，这里只补一点下间距
    marginBottom: spacing.sm,
    minHeight: 40,
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  searchInput: {
    flex: 1,
    fontSize: fontSize.footnote,
    fontWeight: '500',
    paddingVertical: 0,
  },
  searchClearBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchMeta: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    fontSize: fontSize.caption1,
  },
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  emptyText: {
    fontSize: fontSize.callout,
    textAlign: 'center',
  },
  emptyAction: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  emptyActionText: {
    fontSize: fontSize.footnote,
    fontWeight: '700',
  },
})
