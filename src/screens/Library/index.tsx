/**
 * Library screen - user's music collection.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Linking,
  Platform,
  Pressable,
  Share,
  ScrollView,
  StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native'
import { PanGestureHandler, State } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import { useTheme, spacing, fontSize, borderRadius, BOTTOM_INSET, type ThemeColors } from '../../theme'
import { useDispatch, useSelector } from 'react-redux'
import { RootState } from '../../store'
import { ThemeMode, Track, type TrackMoreActionHandler } from '../../types/music'
import { Quality } from '../../core/music'
import {
  ALL_QUALITIES,
  createManualSource,
  createSourceFromScriptText,
  ImportedMusicSource,
} from '../../core/config/musicSource'
import { audioFileCache, formatCacheSize, type CachedAudioFileEntry } from '../../core/music/audioCache'
import { clearTrackCacheById } from '../../core/music/cache'
import {
  localMusicLibrary,
  type LocalMusicEntry,
  type LocalMusicStats,
} from '../../core/music/localLibrary'
import { enrichLocalEntries } from '../../core/music/localEnrich'
import { playerController } from '../../core/player'
import QueueSheet from '../NowPlaying/QueueSheet'
import { emitScrollTopState, subscribeScrollToTop } from '../../core/ui/scrollToTopBus'
import appConfig from '../../config'
import { checkGithubReleaseUpdate } from '../../core/update/githubRelease'
import {
  clearRuntimeLogs,
  formatRuntimeLogsForExport,
  getRuntimeLogEntries,
  getRuntimeLogStats,
  subscribeRuntimeLogs,
  type RuntimeLogEntry,
} from '../../core/logging/runtimeLogger'

interface LibraryScreenProps {
  onTrackPress?: (track: Track) => void
  onTrackMorePress?: TrackMoreActionHandler
  onDetailVisibilityChange?: (visible: boolean) => void
}

type LibrarySubPage = 'main' | 'appearance' | 'sources' | 'cache' | 'local' | 'logs' | 'about'
type SourceModalMode = 'manual' | 'url'

interface MotionPressableProps {
  children: React.ReactNode
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  reducedMotion?: boolean
  disabled?: boolean
  activeScale?: number
  activeOpacity?: number
}

interface EntryCardProps {
  icon: keyof typeof Ionicons.glyphMap
  title: string
  subtitle: string
  onPress: () => void
  reducedMotion: boolean
}

interface OverviewItem {
  key: string
  icon: keyof typeof Ionicons.glyphMap
  label: string
  value: string
}

interface AcknowledgementItem {
  key: string
  icon: keyof typeof Ionicons.glyphMap
  title: string
  subtitle: string
}

const THEME_OPTIONS: Array<{
  value: ThemeMode
  label: string
  description: string
  icon: keyof typeof Ionicons.glyphMap
}> = [
  { value: 'system', label: '跟随系统', description: '自动切换浅色与深色', icon: 'phone-portrait-outline' },
  { value: 'light', label: '浅色', description: '始终使用浅色界面', icon: 'sunny-outline' },
  { value: 'dark', label: '深色', description: '始终使用深色界面', icon: 'moon-outline' },
]

const THEME_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

const ACKNOWLEDGEMENTS: AcknowledgementItem[] = [
  {
    key: 'lxmusic',
    icon: 'musical-notes-outline',
    title: 'LxMusic（落雪）',
    subtitle: '感谢落雪音乐项目的开源思路与生态贡献',
  },
  {
    key: 'cerumusic',
    icon: 'sparkles-outline',
    title: 'CeruMusic（澜音）',
    subtitle: '感谢澜音项目在功能设计与实现上的参考价值',
  },
]

// 参照 CeruMusic 音质显示文案，并补充英文缩写对照。
const QUALITY_LABELS: Record<Quality, string> = {
  '128k': '标准 (128k)',
  '320k': '超高 (320k)',
  flac: '无损 (FLAC)',
  flac24bit: '超高解析 (24bit)',
  hires: '高清臻音 (Hi-Res)',
  atmos: '全景环绕 (Atmos)',
  atmos_plus: '全景增强 (Atmos+)',
  master: '超清母带 (Master)',
}

function getLogLevelColor(level: RuntimeLogEntry['level'], colors: ThemeColors): string {
  if (level === 'error') return colors.danger
  if (level === 'warn') return '#E68A00'
  if (level === 'info') return colors.accent
  return colors.textSecondary
}

function formatDateTime(timestamp: number | null): string {
  if (!timestamp) return '--'
  const date = new Date(timestamp)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}:${ss}`
}

type CacheSortMode = 'recent' | 'size'

/** 缓存列表最多渲染的条数，超出部分可用搜索定位，避免超长列表拖慢设置页 */
const CACHE_LIST_RENDER_LIMIT = 200

/** 主页"本地音乐"只预览前几首，其余进"管理全部" */
const MAIN_LOCAL_PREVIEW_COUNT = 5

/** 本地音乐子页最多渲染的条数 */
const LOCAL_LIST_RENDER_LIMIT = 300

const CACHE_SOURCE_LABELS: Record<string, string> = {
  joy: 'Joy',
  wy: '网易云',
  kg: '酷狗',
  kw: '酷我',
  mg: '咪咕',
  tx: 'QQ 音乐',
}

function formatCacheSourceLabel(source?: string): string {
  const key = String(source || '').trim().toLowerCase()
  if (!key) return '未知来源'
  return CACHE_SOURCE_LABELS[key] || key.toUpperCase()
}

function formatCachedAt(timestamp: number): string {
  if (!timestamp) return '时间未知'
  const diff = Date.now() - timestamp
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚缓存'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function buildCacheEntriesSignature(entries: CachedAudioFileEntry[]): string {
  return entries.map((entry) => `${entry.musicId}:${entry.size}:${entry.updatedAt}`).join('|')
}

/** 播放用 Track 的 id：补全过在线信息后用在线 id，方便歌词/封面按平台取 */
function localEntryTrackId(entry: LocalMusicEntry): string {
  return entry.onlineId || entry.id
}

/**
 * 本地导入文件转成播放用 Track。
 * isLocalFile 是全 App「本地文件」标识的依据；source 在补全过在线信息后
 * 用在线平台（歌词接口按 source 选平台），播放仍由 getMusicUrl 的本地命中拦下。
 */
function localEntryToTrack(entry: LocalMusicEntry): Track {
  return {
    id: localEntryTrackId(entry),
    title: entry.title || '未知歌曲',
    artist: entry.artist || '本地文件',
    duration: 0,
    url: entry.fileUri,
    coverUrl: entry.coverUrl,
    picUrl: entry.coverUrl,
    source: entry.onlineSource || 'local',
    songmid: entry.songmid,
    isLocalFile: true,
  }
}

function formatLocalMeta(entry: LocalMusicEntry): string {
  return [
    (entry.format || '').toUpperCase(),
    formatCacheSize(entry.size),
    formatCachedAt(entry.importedAt).replace('缓存', '导入'),
  ].filter(Boolean).join(' · ')
}

function MotionPressable({
  children,
  onPress,
  style,
  reducedMotion = false,
  disabled = false,
  activeScale = 0.98,
  activeOpacity = 0.92,
}: MotionPressableProps) {
  const scaleAnim = useRef(new Animated.Value(1)).current

  const animateScale = useCallback((toValue: number, duration: number) => {
    if (reducedMotion) return
    Animated.timing(scaleAnim, {
      toValue,
      duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start()
  }, [reducedMotion, scaleAnim])

  return (
    <Animated.View style={[style, reducedMotion ? null : { transform: [{ scale: scaleAnim }] }]}>
      <TouchableOpacity
        activeOpacity={activeOpacity}
        disabled={disabled}
        onPress={onPress}
        onPressIn={disabled ? undefined : () => animateScale(activeScale, 90)}
        onPressOut={disabled ? undefined : () => animateScale(1, 120)}
      >
        {children}
      </TouchableOpacity>
    </Animated.View>
  )
}

interface CachedSongRowProps {
  entry: CachedAudioFileEntry
  colors: ThemeColors
  deleting: boolean
  isCurrentTrack: boolean
  reducedMotion: boolean
  isLast: boolean
  onDelete: (entry: CachedAudioFileEntry) => void
}

const CachedSongRow = React.memo(function CachedSongRow({
  entry,
  colors,
  deleting,
  isCurrentTrack,
  reducedMotion,
  isLast,
  onDelete,
}: CachedSongRowProps) {
  const title = entry.title?.trim() || '未知歌曲'
  const artist = entry.artist?.trim() || '未知歌手'
  const metaText = [
    String(entry.quality || '').toUpperCase(),
    formatCacheSourceLabel(entry.source),
    formatCachedAt(entry.updatedAt),
  ].filter(Boolean).join(' · ')

  return (
    <View
      style={[
        styles.cacheRow,
        !isLast && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.separator,
        },
      ]}
    >
      <View style={[styles.cacheRowIcon, { backgroundColor: colors.accentLight }]}>
        <Ionicons
          name={isCurrentTrack ? 'volume-high' : 'musical-note'}
          size={16}
          color={colors.accent}
        />
      </View>

      <View style={styles.cacheRowMeta}>
        <Text style={[styles.cacheRowTitle, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.cacheRowSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
          {artist}{isCurrentTrack ? ' · 正在播放' : ''}
        </Text>
        <Text style={[styles.cacheRowInfo, { color: colors.textTertiary }]} numberOfLines={1}>
          {metaText}
        </Text>
      </View>

      <View style={styles.cacheRowRight}>
        <Text style={[styles.cacheRowSize, { color: colors.text }]}>{formatCacheSize(entry.size)}</Text>
        <MotionPressable
          onPress={() => onDelete(entry)}
          reducedMotion={reducedMotion}
          disabled={deleting}
          style={[styles.cacheRowDeleteBtn, { backgroundColor: 'rgba(255,59,48,0.14)' }]}
        >
          <View style={styles.cacheRowDeleteInner}>
            {deleting
              ? <ActivityIndicator size="small" color={colors.danger} />
              : <Ionicons name="trash-outline" size={15} color={colors.danger} />}
          </View>
        </MotionPressable>
      </View>
    </View>
  )
})

interface LocalTrackRowProps {
  entry: LocalMusicEntry
  colors: ThemeColors
  deleting: boolean
  isCurrentTrack: boolean
  reducedMotion: boolean
  isLast: boolean
  onPlay: (entry: LocalMusicEntry) => void
  onDelete: (entry: LocalMusicEntry) => void
}

const LocalTrackRow = React.memo(function LocalTrackRow({
  entry,
  colors,
  deleting,
  isCurrentTrack,
  reducedMotion,
  isLast,
  onPlay,
  onDelete,
}: LocalTrackRowProps) {
  const title = entry.title?.trim() || '未知歌曲'
  const subtitle = entry.missing
    ? '文件已丢失，可删除后重新导入'
    : (entry.artist?.trim() || '未知歌手')

  return (
    <View
      style={[
        styles.cacheRow,
        !isLast && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.separator,
        },
      ]}
    >
      <TouchableOpacity
        style={styles.localRowMain}
        activeOpacity={0.6}
        disabled={entry.missing}
        onPress={() => onPlay(entry)}
        accessibilityLabel={`播放本地歌曲 ${title}`}
      >
        <View style={[styles.cacheRowIcon, { backgroundColor: colors.accentLight }]}>
          <Ionicons
            name={entry.missing ? 'alert-circle-outline' : isCurrentTrack ? 'volume-high' : 'folder-outline'}
            size={16}
            color={entry.missing ? colors.warning : colors.accent}
          />
        </View>

        <View style={styles.cacheRowMeta}>
          <View style={styles.localRowTitleRow}>
            <Text style={[styles.cacheRowTitle, { color: colors.text }]} numberOfLines={1}>
              {title}
            </Text>
            <View style={[styles.localBadge, { backgroundColor: colors.accentLight }]}>
              <Text style={[styles.localBadgeText, { color: colors.accent }]}>本地文件</Text>
            </View>
          </View>
          <Text
            style={[styles.cacheRowSubtitle, { color: entry.missing ? colors.warning : colors.textSecondary }]}
            numberOfLines={1}
          >
            {subtitle}{isCurrentTrack && !entry.missing ? ' · 正在播放' : ''}
          </Text>
          {!entry.missing && (
            <Text style={[styles.cacheRowInfo, { color: colors.textTertiary }]} numberOfLines={1}>
              {formatLocalMeta(entry)}
            </Text>
          )}
        </View>
      </TouchableOpacity>

      <MotionPressable
        onPress={() => onDelete(entry)}
        reducedMotion={reducedMotion}
        disabled={deleting}
        style={[styles.cacheRowDeleteBtn, { backgroundColor: 'rgba(255,59,48,0.14)' }]}
      >
        <View style={styles.cacheRowDeleteInner}>
          {deleting
            ? <ActivityIndicator size="small" color={colors.danger} />
            : <Ionicons name="trash-outline" size={15} color={colors.danger} />}
        </View>
      </MotionPressable>
    </View>
  )
})

function EntryCard({ icon, title, subtitle, onPress, reducedMotion }: EntryCardProps) {
  const { colors } = useTheme()
  return (
    <MotionPressable
      onPress={onPress}
      reducedMotion={reducedMotion}
      style={[styles.entryCard, { backgroundColor: colors.surface, borderColor: colors.separator }]}
    >
      <View style={styles.entryCardContent}>
        <View style={[styles.entryIconWrap, { backgroundColor: colors.accentLight }]}>
          <Ionicons name={icon} size={17} color={colors.accent} />
        </View>
        <View style={styles.entryMeta}>
          <Text style={[styles.entryTitle, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.entrySubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      </View>
    </MotionPressable>
  )
}

export default function LibraryScreen({ onTrackPress, onTrackMorePress, onDetailVisibilityChange }: LibraryScreenProps) {
  const { colors } = useTheme()
  const dispatch = useDispatch()
  const insets = useSafeAreaInsets()
  const normalizedTopInset = Math.min(insets.top, 44)
  const playerState = useSelector((state: RootState) => state.player)
  const themeMode = useSelector((state: RootState) => state.config.theme)
  const musicSourceState = useSelector((state: RootState) => state.musicSource)

  const importedSources = musicSourceState.importedSources
  const selectedImportedSourceId = musicSourceState.selectedImportedSourceId
  const selectedSource = useMemo(() => importedSources.find((item) => item.id === selectedImportedSourceId), [
    importedSources,
    selectedImportedSourceId,
  ])

  const [subPage, setSubPage] = useState<LibrarySubPage>('main')
  // 播放队列半屏：从"我的"页 overview 的"播放队列"格子打开。
  const [queueSheetVisible, setQueueSheetVisible] = useState(false)
  const queueSheetAnim = useRef(new Animated.Value(0)).current
  const syncQueueSheetStore = useCallback(() => {
    const snapshot = playerController.getPlayerState()
    dispatch({
      type: 'PLAYER_SYNC_STATE',
      payload: {
        ...snapshot,
        playlist: playerController.getPlaylist(),
        currentIndex: playerController.getCurrentIndex(),
        currentTrack: playerController.getCurrentTrack(),
      },
    })
  }, [dispatch])
  const openQueueSheet = useCallback(() => {
    setQueueSheetVisible(true)
    queueSheetAnim.setValue(0)
    Animated.spring(queueSheetAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 230,
      friction: 24,
    }).start()
  }, [queueSheetAnim])
  const reportDetailVisibility = useCallback((visible: boolean) => {
    onDetailVisibilityChange?.(visible)
  }, [onDetailVisibilityChange])
  const navigateToSubPage = useCallback((nextPage: LibrarySubPage) => {
    reportDetailVisibility(nextPage !== 'main')
    setSubPage(nextPage)
  }, [reportDetailVisibility])
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false)
  const pageAnim = useRef(new Animated.Value(1)).current
  const mainListRef = useRef<FlatList<Track> | null>(null)
  const subPageScrollRef = useRef<ScrollView | null>(null)
  // 供缓存删除回调读取当前播放歌曲，避免把 playerState 放进依赖导致每帧重建回调
  const currentTrackIdRef = useRef<string | null>(null)

  const [sourceModalVisible, setSourceModalVisible] = useState(false)
  const [sourceModalMode, setSourceModalMode] = useState<SourceModalMode>('manual')
  const [sourceModalLoading, setSourceModalLoading] = useState(false)
  const [editingSourceId, setEditingSourceId] = useState('')

  const [manualName, setManualName] = useState('')
  const [manualApiUrl, setManualApiUrl] = useState('')
  const [manualApiKey, setManualApiKey] = useState('')
  const [importUrl, setImportUrl] = useState('')

  const [cacheLoading, setCacheLoading] = useState(false)
  const [cacheEnabled, setCacheEnabled] = useState(true)
  const [cacheFileCount, setCacheFileCount] = useState(0)
  const [cacheSizeBytes, setCacheSizeBytes] = useState(0)
  const [cacheEntries, setCacheEntries] = useState<CachedAudioFileEntry[]>([])
  const [cacheKeyword, setCacheKeyword] = useState('')
  const [cacheSortMode, setCacheSortMode] = useState<CacheSortMode>('recent')
  const [deletingCacheIds, setDeletingCacheIds] = useState<Record<string, boolean>>({})
  const cacheEntriesSignatureRef = useRef('')
  const [localEntries, setLocalEntries] = useState<LocalMusicEntry[]>([])
  const [localStats, setLocalStats] = useState<LocalMusicStats>({ count: 0, sizeBytes: 0, missingCount: 0 })
  const [localImporting, setLocalImporting] = useState(false)
  const [localKeyword, setLocalKeyword] = useState('')
  const [localSortMode, setLocalSortMode] = useState<CacheSortMode>('recent')
  const [deletingLocalIds, setDeletingLocalIds] = useState<Record<string, boolean>>({})
  const [localEnriching, setLocalEnriching] = useState(false)
  const [localEnrichProgress, setLocalEnrichProgress] = useState<{ done: number; total: number } | null>(null)
  const localEnrichRunningRef = useRef(false)
  const localAutoEnrichTriedRef = useRef(false)
  const [logExporting, setLogExporting] = useState(false)
  const [logDetail, setLogDetail] = useState<RuntimeLogEntry | null>(null)
  const [runtimeLogCount, setRuntimeLogCount] = useState(0)
  const [runtimeLastTimestamp, setRuntimeLastTimestamp] = useState<number | null>(null)
  const [runtimeLogPreview, setRuntimeLogPreview] = useState<RuntimeLogEntry[]>([])
  const [sponsorModalVisible, setSponsorModalVisible] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  const currentVersion = appConfig.version

  const pageTitle = subPage === 'main'
    ? '我的'
    : subPage === 'appearance'
      ? '外观设置'
      : subPage === 'sources'
        ? '自定义源管理'
        : subPage === 'cache'
          ? '缓存管理'
          : subPage === 'local'
            ? '本地音乐'
            : subPage === 'logs'
              ? '运行日志'
              : '关于'

  const queueCount = playerState.playlist.length
  const currentTrackId = playerState.currentTrack?.id ?? null
  const cacheSummaryText = `${cacheEnabled ? '已开启' : '已关闭'} · ${formatCacheSize(cacheSizeBytes)}`
  const visibleCacheEntries = useMemo(() => {
    const keyword = cacheKeyword.trim().toLowerCase()
    const matched = keyword
      ? cacheEntries.filter((entry) => {
        const haystack = `${entry.title || ''} ${entry.artist || ''} ${entry.musicId}`.toLowerCase()
        return haystack.includes(keyword)
      })
      : [...cacheEntries]
    return cacheSortMode === 'size'
      ? matched.sort((a, b) => b.size - a.size)
      : matched
  }, [cacheEntries, cacheKeyword, cacheSortMode])
  const localSummaryText = localStats.count
    ? `${localStats.count} 首 · ${formatCacheSize(localStats.sizeBytes)}`
    : '未导入歌曲'
  const visibleLocalEntries = useMemo(() => {
    const keyword = localKeyword.trim().toLowerCase()
    const matched = keyword
      ? localEntries.filter((entry) => {
        const haystack = `${entry.title || ''} ${entry.artist || ''} ${entry.fileName}`.toLowerCase()
        return haystack.includes(keyword)
      })
      : [...localEntries]
    return localSortMode === 'size'
      ? matched.sort((a, b) => b.size - a.size)
      : matched
  }, [localEntries, localKeyword, localSortMode])
  const runtimeLogSummaryText = runtimeLogCount
    ? `${runtimeLogCount} 条 · 最近 ${formatDateTime(runtimeLastTimestamp)}`
    : '暂无运行日志'
  const sourceSummaryText = selectedSource
    ? selectedSource.name
    : (musicSourceState.currentSourceId ? `内置 ${musicSourceState.currentSourceId.toUpperCase()}` : '未配置')

  const overviewItems = useMemo<OverviewItem[]>(() => [
    { key: 'theme', icon: 'contrast-outline', label: '主题模式', value: THEME_LABELS[themeMode] },
    { key: 'source', icon: 'server-outline', label: '当前音源', value: sourceSummaryText },
    { key: 'cache', icon: 'cloud-download-outline', label: '缓存占用', value: formatCacheSize(cacheSizeBytes) },
    { key: 'queue', icon: 'list-outline', label: '播放队列', value: `${queueCount} 首` },
  ], [themeMode, sourceSummaryText, cacheSizeBytes, queueCount])

  const ensureSelected = useCallback((id: string) => {
    if (selectedImportedSourceId) return
    dispatch({ type: 'MUSIC_SOURCE_SET_SELECTED_IMPORTED', payload: id })
  }, [dispatch, selectedImportedSourceId])

  const handleThemeChange = useCallback((mode: ThemeMode) => {
    dispatch({ type: 'CONFIG_SET_THEME', payload: mode })
  }, [dispatch])

  const handleAutoSwitchChange = useCallback((value: boolean) => {
    dispatch({ type: 'MUSIC_SOURCE_SET_AUTO_SWITCH', payload: value })
  }, [dispatch])

  const handleQualityChange = useCallback((quality: Quality) => {
    dispatch({ type: 'MUSIC_SOURCE_SET_QUALITY', payload: quality })
  }, [dispatch])

  const loadAudioCacheStats = useCallback(async(silent = false) => {
    if (!silent) setCacheLoading(true)
    try {
      const overview = await audioFileCache.getCacheOverview()
      setCacheEnabled(overview.enabled)
      setCacheFileCount(overview.fileCount)
      setCacheSizeBytes(overview.sizeBytes)
      // 缓存详情页每 6 秒轮询一次，内容没变时跳过 setState，避免列表无谓重渲染。
      const signature = buildCacheEntriesSignature(overview.entries)
      if (signature !== cacheEntriesSignatureRef.current) {
        cacheEntriesSignatureRef.current = signature
        setCacheEntries(overview.entries)
      }
    } finally {
      if (!silent) setCacheLoading(false)
    }
  }, [])

  const handleToggleAudioCache = useCallback(async(value: boolean) => {
    setCacheEnabled(value)
    await audioFileCache.setEnabled(value)
    void loadAudioCacheStats(true)
  }, [loadAudioCacheStats])

  /** 单首删除：先本地乐观移除，再落盘并回读真实占用 */
  const deleteSingleCacheEntry = useCallback(async(entry: CachedAudioFileEntry) => {
    setDeletingCacheIds((prev) => ({ ...prev, [entry.musicId]: true }))
    try {
      await clearTrackCacheById(entry.musicId)
      setCacheEntries((prev) => prev.filter((item) => item.musicId !== entry.musicId))
      setCacheFileCount((prev) => Math.max(0, prev - 1))
      setCacheSizeBytes((prev) => Math.max(0, prev - Math.max(0, entry.size)))
      await loadAudioCacheStats(true)
    } catch (error) {
      Alert.alert('删除失败', error instanceof Error ? error.message : '请稍后重试')
      await loadAudioCacheStats(true)
    } finally {
      setDeletingCacheIds((prev) => {
        if (!prev[entry.musicId]) return prev
        const next = { ...prev }
        delete next[entry.musicId]
        return next
      })
    }
  }, [loadAudioCacheStats])

  const handleDeleteSingleCache = useCallback((entry: CachedAudioFileEntry) => {
    if (deletingCacheIds[entry.musicId]) return
    const title = entry.title?.trim() || '未知歌曲'
    const isCurrentTrack = (currentTrackIdRef.current || '') === entry.musicId

    if (!isCurrentTrack) {
      void deleteSingleCacheEntry(entry)
      return
    }

    Alert.alert('删除缓存', `「${title}」正在播放，删除本地文件后播放可能中断，仍要删除吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => void deleteSingleCacheEntry(entry),
      },
    ])
  }, [deleteSingleCacheEntry, deletingCacheIds])

  const handleClearAudioCache = useCallback(() => {
    const summary = cacheFileCount
      ? `确认删除全部 ${cacheFileCount} 首在线缓存歌曲（${formatCacheSize(cacheSizeBytes)}）吗？删除后将重新走在线获取。从「文件」导入的本地歌曲不会被删除。`
      : '确认删除所有在线缓存歌曲吗？删除后将重新走在线获取。从「文件」导入的本地歌曲不会被删除。'
    Alert.alert('清空本地缓存', summary, [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          void (async() => {
            try {
              setCacheLoading(true)
              await audioFileCache.clearAllCachedAudio()
              setCacheEntries([])
              cacheEntriesSignatureRef.current = ''
              await loadAudioCacheStats(true)
              Alert.alert('已清空', '本地歌曲缓存已删除')
            } catch (error) {
              Alert.alert('清空失败', error instanceof Error ? error.message : '请稍后重试')
            } finally {
              setCacheLoading(false)
            }
          })()
        },
      },
    ])
  }, [cacheFileCount, cacheSizeBytes, loadAudioCacheStats])

  const handleToggleCacheSort = useCallback(() => {
    setCacheSortMode((prev) => (prev === 'recent' ? 'size' : 'recent'))
  }, [])

  const loadLocalLibrary = useCallback(async() => {
    const [entries, stats] = await Promise.all([
      localMusicLibrary.getEntries(),
      localMusicLibrary.getStats(),
    ])
    setLocalEntries(entries)
    setLocalStats(stats)
  }, [])

  /**
   * 联网补全本地歌曲的封面与在线曲目信息（歌词按在线 id 取）。
   * 播放仍然走本地文件，这里只补元数据。
   */
  const runLocalEnrich = useCallback(async(announce = true) => {
    if (localEnrichRunningRef.current) return
    const entries = await localMusicLibrary.getEntries()
    const pending = entries.filter((entry) => !entry.missing && !entry.onlineId && !entry.coverUrl)
    if (!pending.length) {
      if (announce) Alert.alert('无需补全', '本地歌曲都已经有封面与歌词信息了')
      return
    }

    localEnrichRunningRef.current = true
    setLocalEnriching(true)
    setLocalEnrichProgress({ done: 0, total: pending.length })
    try {
      const result = await enrichLocalEntries(pending, (done, total) => {
        setLocalEnrichProgress({ done, total })
        // 边补边刷新，封面能立刻出现在列表里
        void loadLocalLibrary()
      })
      await loadLocalLibrary()
      if (announce) {
        Alert.alert(
          '补全完成',
          `成功 ${result.ok} 首${result.failed ? `，未匹配到在线曲目 ${result.failed} 首` : ''}`
        )
      }
    } catch (error) {
      if (announce) {
        Alert.alert('补全失败', error instanceof Error ? error.message : '请稍后重试')
      }
    } finally {
      localEnrichRunningRef.current = false
      setLocalEnriching(false)
      setLocalEnrichProgress(null)
    }
  }, [loadLocalLibrary])

  /** 从"文件"App 选取音频，复制进 App 并按"歌名-歌手"解析登记 */
  const handleImportLocalMusicFiles = useCallback(async() => {
    if (localImporting) return
    setLocalImporting(true)
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*', 'public.audio'],
        copyToCacheDirectory: false,
        multiple: true,
      })
      if (result.canceled) return

      const assets = (result.assets || [])
        .filter((asset) => Boolean(asset?.uri))
        .map((asset) => ({ uri: asset.uri, name: asset.name, size: asset.size }))
      if (!assets.length) {
        Alert.alert('未选择文件', '没有读取到可导入的音频文件')
        return
      }

      const importResult = await localMusicLibrary.importFiles(assets)
      await loadLocalLibrary()
      // 后台补全封面与在线曲目信息，不阻塞导入结果提示
      void runLocalEnrich(false)

      const lines: string[] = []
      if (importResult.imported.length) {
        lines.push(`新导入 ${importResult.imported.length} 首`)
      }
      if (importResult.replaced.length) {
        lines.push(`覆盖同名 ${importResult.replaced.length} 首`)
      }
      if (importResult.skipped.length) {
        const preview = importResult.skipped
          .slice(0, 3)
          .map((item) => `${item.name}（${item.reason}）`)
          .join('\n')
        const rest = importResult.skipped.length > 3
          ? `\n等 ${importResult.skipped.length} 个文件`
          : ''
        lines.push(`跳过 ${importResult.skipped.length} 个：\n${preview}${rest}`)
      }
      if (!importResult.imported.length && !importResult.replaced.length) {
        Alert.alert('没有导入成功', lines.join('\n') || '请确认所选文件是音频格式')
        return
      }
      Alert.alert('导入完成', `${lines.join('\n')}\n\n文件名按"歌名-歌手"解析，可在列表中核对。`)
    } catch (error) {
      Alert.alert('导入失败', error instanceof Error ? error.message : '读取文件失败')
    } finally {
      setLocalImporting(false)
    }
  }, [loadLocalLibrary, localImporting, runLocalEnrich])

  const handlePlayLocalTrack = useCallback((entry: LocalMusicEntry) => {
    if (entry.missing) {
      Alert.alert('文件已丢失', `「${entry.title}」的本地文件已不存在，可删除该记录后重新导入。`)
      return
    }
    const track = localEntryToTrack(entry)
    if (onTrackPress) {
      onTrackPress(track)
      return
    }
    void playerController.insertTrackAndPlay(track, { autoPlay: true })
  }, [onTrackPress])

  const handleDeleteLocalTrack = useCallback((entry: LocalMusicEntry) => {
    if (deletingLocalIds[entry.id]) return
    const isCurrentTrack = (currentTrackIdRef.current || '') === localEntryTrackId(entry)
    Alert.alert(
      '删除本地歌曲',
      `确认删除「${entry.title}」吗？会一并删掉 App 内的文件副本，之后需要重新导入。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async() => {
              setDeletingLocalIds((prev) => ({ ...prev, [entry.id]: true }))
              try {
                await localMusicLibrary.removeEntry(entry.id)
                await loadLocalLibrary()
                if (isCurrentTrack) {
                  await playerController.pause().catch(() => {})
                }
              } catch (error) {
                Alert.alert('删除失败', error instanceof Error ? error.message : '请稍后重试')
              } finally {
                setDeletingLocalIds((prev) => {
                  if (!prev[entry.id]) return prev
                  const next = { ...prev }
                  delete next[entry.id]
                  return next
                })
              }
            })()
          },
        },
      ]
    )
  }, [deletingLocalIds, loadLocalLibrary])

  const handleToggleLocalSort = useCallback(() => {
    setLocalSortMode((prev) => (prev === 'recent' ? 'size' : 'recent'))
  }, [])

  const handlePruneMissingLocal = useCallback(async() => {
    const removed = await localMusicLibrary.pruneMissing()
    await loadLocalLibrary()
    Alert.alert('已清理', removed ? `已移除 ${removed} 条失效记录` : '没有失效记录')
  }, [loadLocalLibrary])

  const refreshRuntimeLogState = useCallback(() => {
    const stats = getRuntimeLogStats()
    setRuntimeLogCount(stats.total)
    setRuntimeLastTimestamp(stats.lastTimestamp)
    setRuntimeLogPreview(getRuntimeLogEntries(120))
  }, [])

  const writeRuntimeLogFile = useCallback(async() => {
    const storageRoot = FileSystem.documentDirectory || FileSystem.cacheDirectory
    if (!storageRoot) {
      throw new Error('当前环境不支持导出本地文件')
    }

    const exportDir = `${storageRoot}joy_runtime_logs`
    await FileSystem.makeDirectoryAsync(exportDir, { intermediates: true })

    const fileUri = `${exportDir}/runtime_log_${Date.now()}.txt`
    const payload = formatRuntimeLogsForExport(1500)
    await FileSystem.writeAsStringAsync(fileUri, payload, {
      encoding: FileSystem.EncodingType.UTF8,
    })
    return fileUri
  }, [])

  const handleExportRuntimeLogs = useCallback(async() => {
    if (logExporting) return
    const stats = getRuntimeLogStats()
    if (!stats.total) {
      Alert.alert('暂无日志', '请先复现问题后再导出日志。')
      return
    }

    setLogExporting(true)
    try {
      const fileUri = await writeRuntimeLogFile()
      let sharedSuccessfully = false
      try {
        const shareResult = await Share.share({
          title: '运行日志',
          url: fileUri,
          message: Platform.OS === 'ios'
            ? undefined
            : `运行日志文件：${fileUri}`,
        })
        sharedSuccessfully = shareResult.action === Share.sharedAction
      } catch (shareError) {
        console.warn('Runtime log share failed:', shareError)
      }

      if (!sharedSuccessfully) return
      Alert.alert('导出成功', `日志文件已生成：\n${fileUri}`)
    } catch (error) {
      Alert.alert('导出失败', error instanceof Error ? error.message : '请稍后重试')
    } finally {
      setLogExporting(false)
    }
  }, [logExporting, writeRuntimeLogFile])

  const handleClearRuntimeLogs = useCallback(() => {
    Alert.alert('清空运行日志', '确认清空当前运行日志吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          clearRuntimeLogs()
          Alert.alert('已清空', '运行日志已清空')
        },
      },
    ])
  }, [])

  const handleOpenFeedbackWebsite = useCallback(async() => {
    const url = 'https://music.ojason.top'
    try {
      const supported = await Linking.canOpenURL(url)
      if (!supported) {
        Alert.alert('无法打开链接', '当前设备不支持打开该网址')
        return
      }
      await Linking.openURL(url)
    } catch (error) {
      Alert.alert('打开失败', error instanceof Error ? error.message : '请稍后重试')
    }
  }, [])

  const handleCheckUpdate = useCallback(async() => {
    if (checkingUpdate) return

    const owner = appConfig.update.githubOwner
    const repo = appConfig.update.githubRepo
    const fallbackReleaseUrl = owner && repo
      ? `https://github.com/${owner}/${repo}/releases`
      : 'https://music.ojason.top'

    setCheckingUpdate(true)
    try {
      const result = await checkGithubReleaseUpdate({
        owner,
        repo,
        currentVersion,
        requestTimeoutMs: appConfig.update.requestTimeoutMs,
      })

      if (result.status === 'has_update') {
        const summaryLines = [
          `当前版本：v${result.currentVersion}`,
          `最新版本：v${result.latestVersion || '-'}`,
        ]
        const notes = result.notes?.trim()
        if (notes) summaryLines.push('', notes.slice(0, 800))

        const updateUrl = result.releaseUrl || fallbackReleaseUrl
        Alert.alert('发现新版本', summaryLines.join('\n'), [
          { text: '取消', style: 'cancel' },
          {
            text: '前往更新',
            onPress: () => {
              void Linking.openURL(updateUrl).catch(() => {
                Alert.alert('打开失败', '请手动打开更新页面')
              })
            },
          },
        ])
        return
      }

      if (result.status === 'up_to_date') {
        Alert.alert('已是最新版本', `当前版本：v${result.currentVersion}`)
        return
      }

      const failedUrl = result.releaseUrl || fallbackReleaseUrl
      Alert.alert('检查更新失败', result.reason || '请稍后重试', [
        { text: '取消', style: 'cancel' },
        {
          text: '打开更新页',
          onPress: () => {
            void Linking.openURL(failedUrl).catch(() => {
              Alert.alert('打开失败', '请手动打开更新页面')
            })
          },
        },
      ])
    } catch (error) {
      Alert.alert('检查更新失败', error instanceof Error ? error.message : '请稍后重试')
    } finally {
      setCheckingUpdate(false)
    }
  }, [checkingUpdate, currentVersion])

  const openCreateSourceModal = useCallback(() => {
    setEditingSourceId('')
    setSourceModalMode('manual')
    setSourceModalLoading(false)
    setManualName('')
    setManualApiUrl('')
    setManualApiKey('')
    setImportUrl('')
    setSourceModalVisible(true)
  }, [])

  const openEditSourceModal = useCallback((source: ImportedMusicSource) => {
    setEditingSourceId(source.id)
    setSourceModalMode('manual')
    setSourceModalLoading(false)
    setManualName(source.name)
    setManualApiUrl(source.apiUrl)
    setManualApiKey(source.apiKey || '')
    setImportUrl('')
    setSourceModalVisible(true)
  }, [])

  const handleUseSource = useCallback((source: ImportedMusicSource) => {
    if (!source.enabled) {
      dispatch({ type: 'MUSIC_SOURCE_TOGGLE_IMPORTED_ENABLED', payload: { id: source.id, enabled: true } })
    }
    dispatch({ type: 'MUSIC_SOURCE_SET_SELECTED_IMPORTED', payload: source.id })
  }, [dispatch])

  const handleToggleSource = useCallback((source: ImportedMusicSource) => {
    const nextEnabled = !source.enabled
    dispatch({ type: 'MUSIC_SOURCE_TOGGLE_IMPORTED_ENABLED', payload: { id: source.id, enabled: nextEnabled } })
    if (!nextEnabled && selectedImportedSourceId === source.id) {
      const fallback = importedSources.find((item) => item.id !== source.id && item.enabled)
      dispatch({ type: 'MUSIC_SOURCE_SET_SELECTED_IMPORTED', payload: fallback?.id || '' })
    }
  }, [dispatch, importedSources, selectedImportedSourceId])

  const handleDeleteSource = useCallback((source: ImportedMusicSource) => {
    Alert.alert('删除音源', `确认删除「${source.name}」吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => dispatch({ type: 'MUSIC_SOURCE_DELETE_IMPORTED', payload: source.id }),
      },
    ])
  }, [dispatch])

  const handleSubmitSourceModal = useCallback(async() => {
    if (editingSourceId) {
      const name = manualName.trim()
      const apiUrl = manualApiUrl.trim()
      const apiKey = manualApiKey.trim()
      if (!name) return Alert.alert('提示', '请填写音源名称')
      if (!/^https?:\/\//i.test(apiUrl)) return Alert.alert('提示', '请输入有效的 API 地址')

      dispatch({
        type: 'MUSIC_SOURCE_UPDATE_IMPORTED',
        payload: { id: editingSourceId, patch: { name, apiUrl, apiKey: apiKey || undefined } },
      })
      setSourceModalVisible(false)
      return
    }

    if (sourceModalMode === 'manual') {
      const name = manualName.trim()
      const apiUrl = manualApiUrl.trim()
      const apiKey = manualApiKey.trim()
      if (!name) return Alert.alert('提示', '请填写音源名称')
      if (!/^https?:\/\//i.test(apiUrl)) return Alert.alert('提示', '请输入有效的 API 地址')

      const source = createManualSource({ name, apiUrl, apiKey: apiKey || undefined })
      dispatch({ type: 'MUSIC_SOURCE_ADD_IMPORTED', payload: source })
      ensureSelected(source.id)
      setSourceModalVisible(false)
      return
    }

    const sourceUrl = importUrl.trim()
    if (!/^https?:\/\//i.test(sourceUrl)) return Alert.alert('提示', '请输入有效 URL')

    try {
      setSourceModalLoading(true)
      const resp = await fetch(sourceUrl)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const text = await resp.text()
      const source = createSourceFromScriptText(text, { sourceUrl })
      dispatch({ type: 'MUSIC_SOURCE_ADD_IMPORTED', payload: source })
      ensureSelected(source.id)
      setSourceModalVisible(false)
      Alert.alert('导入成功', `已导入：${source.name}${source.apiUrl ? '' : '（请编辑补全 API 地址）'}`)
    } catch (error) {
      Alert.alert('导入失败', error instanceof Error ? error.message : 'URL 导入失败')
    } finally {
      setSourceModalLoading(false)
    }
  }, [dispatch, editingSourceId, ensureSelected, importUrl, manualApiKey, manualApiUrl, manualName, sourceModalMode])

  const handleImportLocalJsFile = useCallback(async() => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/javascript', 'text/javascript', 'text/plain'],
        copyToCacheDirectory: true,
        multiple: false,
      })

      if (result.canceled) return
      const asset = result.assets?.[0]
      if (!asset?.uri) {
        Alert.alert('导入失败', '未读取到文件地址')
        return
      }

      const fileName = asset.name || 'source.js'
      if (!/\.m?js$/i.test(fileName)) {
        Alert.alert('文件不支持', '请选择 .js 文件进行导入')
        return
      }

      const scriptText = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      })

      const source = createSourceFromScriptText(scriptText, {
        sourceUrl: asset.uri,
        fallbackName: fileName.replace(/\.m?js$/i, ''),
      })

      dispatch({ type: 'MUSIC_SOURCE_ADD_IMPORTED', payload: source })
      ensureSelected(source.id)
      Alert.alert('导入成功', `已导入本地脚本：${source.name}${source.apiUrl ? '' : '（请编辑补全 API 地址）'}`)
    } catch (error) {
      Alert.alert('导入失败', error instanceof Error ? error.message : '本地文件导入失败')
    }
  }, [dispatch, ensureSelected])

  useEffect(() => {
    void loadAudioCacheStats()
  }, [loadAudioCacheStats])

  useEffect(() => {
    currentTrackIdRef.current = currentTrackId
  }, [currentTrackId])

  useEffect(() => {
    void loadLocalLibrary()
  }, [loadLocalLibrary])

  useEffect(() => {
    // 已导入但还没补全过封面/歌词的歌曲，每次启动自动补一次（后台跑，不打扰）
    if (localAutoEnrichTriedRef.current) return
    localAutoEnrichTriedRef.current = true
    void (async() => {
      await loadLocalLibrary()
      await runLocalEnrich(false)
    })()
  }, [loadLocalLibrary, runLocalEnrich])

  useEffect(() => {
    // 导入/删除可能在别的子页发生，进入这两个页面时重新读一次索引
    if (subPage !== 'local' && subPage !== 'cache') return
    void loadLocalLibrary()
  }, [loadLocalLibrary, subPage])

  useEffect(() => {
    refreshRuntimeLogState()
    return subscribeRuntimeLogs(refreshRuntimeLogState)
  }, [refreshRuntimeLogState])

  useEffect(() => {
    if (subPage !== 'cache') return
    void loadAudioCacheStats(true)
  }, [subPage, loadAudioCacheStats])

  useEffect(() => {
    // 仅在缓存详情子页打开时定时刷新缓存大小，避免主页面后台轮询导致持续唤醒主线程。
    if (subPage !== 'cache') return
    const timer = setInterval(() => {
      void loadAudioCacheStats(true)
    }, 6000)
    return () => clearInterval(timer)
  }, [loadAudioCacheStats, subPage])

  useEffect(() => {
    return subscribeScrollToTop(() => {
      if (subPage === 'main') {
        mainListRef.current?.scrollToOffset({ offset: 0, animated: true })
        return
      }
      subPageScrollRef.current?.scrollTo({ y: 0, animated: true })
    })
  }, [subPage])

  const handleMainListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (subPage !== 'main') return
    emitScrollTopState(event.nativeEvent.contentOffset.y <= 4)
  }, [subPage])

  const handleSubPageScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (subPage === 'main') return
    emitScrollTopState(event.nativeEvent.contentOffset.y <= 4)
  }, [subPage])

  useEffect(() => {
    emitScrollTopState(true)
  }, [subPage])

  useEffect(() => {
    let mounted = true
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotionEnabled(Boolean(enabled))
      })
      .catch(() => {})

    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled) => {
      setReduceMotionEnabled(Boolean(enabled))
    })

    return () => {
      mounted = false
      subscription?.remove?.()
    }
  }, [])

  useEffect(() => {
    pageAnim.stopAnimation()
    pageAnim.setValue(0)
    Animated.timing(pageAnim, {
      toValue: 1,
      duration: reduceMotionEnabled ? 140 : 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
    
    reportDetailVisibility(subPage !== 'main')
  }, [pageAnim, reduceMotionEnabled, reportDetailVisibility, subPage])

  useEffect(() => {
    return () => {
      reportDetailVisibility(false)
    }
  }, [reportDetailVisibility])

  const handleSubPageSwipeStateChange = useCallback((event: any) => {
    if (subPage === 'main') return
    const state = Number(event?.nativeEvent?.state)
    if (state !== State.END && state !== State.CANCELLED && state !== State.FAILED) {
      return
    }

    const deltaX = Number(event?.nativeEvent?.translationX ?? 0)
    const velocityX = Number(event?.nativeEvent?.velocityX ?? 0)
    if (deltaX > 68 || velocityX > 700) {
      navigateToSubPage('main')
    }
  }, [navigateToSubPage, subPage])

  const renderHeader = useCallback(() => (
    <View style={[styles.header, { paddingTop: normalizedTopInset + spacing.sm }]}>
      {subPage === 'main' ? (
        <View style={styles.headerSidePlaceholder} />
      ) : (
        <MotionPressable
          onPress={() => navigateToSubPage('main')}
          reducedMotion={reduceMotionEnabled}
          style={[styles.backButtonShell, { backgroundColor: colors.surface }]}
          activeScale={0.97}
        >
          <View style={styles.backButton}>
            <Ionicons name="chevron-back" size={16} color={colors.textSecondary} />
            <Text style={[styles.backText, { color: colors.textSecondary }]}>返回</Text>
          </View>
        </MotionPressable>
      )}
      <Text style={[styles.largeTitle, { color: colors.text }]}>{pageTitle}</Text>
      <View style={styles.headerSidePlaceholder} />
    </View>
  ), [colors.surface, colors.text, colors.textSecondary, navigateToSubPage, normalizedTopInset, pageTitle, reduceMotionEnabled, subPage])

  const mainListHeader = useMemo(() => (
    <>
      {renderHeader()}

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>状态总览</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>实时同步</Text>
        </View>
        <View style={[styles.overviewCard, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={styles.overviewGrid}>
            {overviewItems.map((item, index) => {
              const showRightBorder = index % 2 === 0
              const showBottomBorder = index < 2
              const onPressItem = item.key === 'queue' && queueCount > 0
                ? openQueueSheet
                : item.key === 'theme'
                  ? () => navigateToSubPage('appearance')
                  : item.key === 'source'
                    ? () => navigateToSubPage('sources')
                    : item.key === 'cache'
                      ? () => navigateToSubPage('cache')
                      : undefined
              const itemStyle = [
                styles.overviewItem,
                showRightBorder ? { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator } : null,
                showBottomBorder ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator } : null,
              ]
              const content = (
                <>
                  <View style={styles.overviewTopRow}>
                    <View style={[styles.overviewIconWrap, { backgroundColor: colors.surfaceSecondary }]}>
                      <Ionicons name={item.icon} size={13} color={colors.textSecondary} />
                    </View>
                    <Text style={[styles.overviewLabel, { color: colors.textSecondary }]}>{item.label}</Text>
                  </View>
                  <Text style={[styles.overviewValue, { color: colors.text }]} numberOfLines={1}>
                    {item.value}
                  </Text>
                </>
              )
              if (onPressItem) {
                return (
                  <Pressable
                    key={item.key}
                    style={({ pressed }) => [
                      ...itemStyle,
                      pressed ? { opacity: 0.6 } : null,
                    ]}
                    onPress={onPressItem}
                  >
                    {content}
                  </Pressable>
                )
              }
              return (
                <View key={item.key} style={itemStyle}>
                  {content}
                </View>
              )
            })}
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>本地音乐</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
            {localImporting ? '导入中...' : localSummaryText}
          </Text>
        </View>

        <View style={styles.actionsRow}>
          <MotionPressable
            onPress={handleImportLocalMusicFiles}
            reducedMotion={reduceMotionEnabled}
            disabled={localImporting}
            style={[styles.actionBtn, { backgroundColor: colors.surfaceSecondary }]}
          >
            <View style={styles.actionBtnContent}>
              {localImporting
                ? <ActivityIndicator size="small" color={colors.textSecondary} />
                : <Ionicons name="folder-open-outline" size={15} color={colors.textSecondary} />}
              <Text style={[styles.actionText, { color: colors.textSecondary }]}>从文件导入</Text>
            </View>
          </MotionPressable>

          <MotionPressable
            onPress={() => navigateToSubPage('local')}
            reducedMotion={reduceMotionEnabled}
            style={[styles.actionBtn, { backgroundColor: colors.surfaceSecondary }]}
          >
            <View style={styles.actionBtnContent}>
              <Ionicons name="list-outline" size={15} color={colors.textSecondary} />
              <Text style={[styles.actionText, { color: colors.textSecondary }]}>管理全部</Text>
            </View>
          </MotionPressable>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          {localEntries.length === 0 && (
            <View style={styles.cacheEmptyWrap}>
              <Ionicons name="folder-outline" size={22} color={colors.textTertiary} />
              <Text style={[styles.cacheEmptyText, { color: colors.textSecondary }]}>
                还没有导入歌曲，从「文件」App 选择音频即可
              </Text>
            </View>
          )}

          {localEntries.slice(0, MAIN_LOCAL_PREVIEW_COUNT).map((entry, index) => (
            <LocalTrackRow
              key={entry.id}
              entry={entry}
              colors={colors}
              deleting={Boolean(deletingLocalIds[entry.id])}
              isCurrentTrack={currentTrackId === localEntryTrackId(entry)}
              reducedMotion={reduceMotionEnabled}
              isLast={index === Math.min(localEntries.length, MAIN_LOCAL_PREVIEW_COUNT) - 1}
              onPlay={handlePlayLocalTrack}
              onDelete={handleDeleteLocalTrack}
            />
          ))}

          {localEntries.length > MAIN_LOCAL_PREVIEW_COUNT && (
            <TouchableOpacity
              style={[styles.cacheMoreHint, { borderTopColor: colors.separator }]}
              activeOpacity={0.6}
              onPress={() => navigateToSubPage('local')}
            >
              <Text style={[styles.cacheMoreHintText, { color: colors.accent }]}>
                查看全部 {localEntries.length} 首
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>功能入口</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>常用设置</Text>
        </View>
        <View style={styles.entryList}>
          <EntryCard
            icon="color-palette-outline"
            title="外观设置"
            subtitle={THEME_LABELS[themeMode]}
            onPress={() => navigateToSubPage('appearance')}
            reducedMotion={reduceMotionEnabled}
          />
          <EntryCard
            icon="server-outline"
            title="自定义源管理"
            subtitle={selectedSource ? `当前：${selectedSource.name}` : '未配置音源'}
            onPress={() => navigateToSubPage('sources')}
            reducedMotion={reduceMotionEnabled}
          />
          <EntryCard
            icon="cloud-download-outline"
            title="歌曲缓存"
            subtitle={cacheSummaryText}
            onPress={() => navigateToSubPage('cache')}
            reducedMotion={reduceMotionEnabled}
          />
          <EntryCard
            icon="folder-outline"
            title="本地音乐"
            subtitle={localImporting ? '导入中...' : localSummaryText}
            onPress={() => navigateToSubPage('local')}
            reducedMotion={reduceMotionEnabled}
          />
          <EntryCard
            icon="document-text-outline"
            title="运行日志"
            subtitle={runtimeLogSummaryText}
            onPress={() => navigateToSubPage('logs')}
            reducedMotion={reduceMotionEnabled}
          />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>支持与关于</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>信息与链接</Text>
        </View>
        <View style={styles.entryList}>
          <EntryCard
            icon="information-circle-outline"
            title="关于"
            subtitle={`v${currentVersion}`}
            onPress={() => navigateToSubPage('about')}
            reducedMotion={reduceMotionEnabled}
          />
          <EntryCard
            icon="heart-outline"
            title="赞助作者"
            subtitle="微信赞赏"
            onPress={() => setSponsorModalVisible(true)}
            reducedMotion={reduceMotionEnabled}
          />
          <EntryCard
            icon="globe-outline"
            title="反馈"
            subtitle="官网：music.ojason.top"
            onPress={() => { void handleOpenFeedbackWebsite() }}
            reducedMotion={reduceMotionEnabled}
          />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>鸣谢</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>开源项目</Text>
        </View>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          {ACKNOWLEDGEMENTS.map((item, index) => (
            <View
              key={item.key}
              style={[
                styles.optionRow,
                index < ACKNOWLEDGEMENTS.length - 1
                  ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
                  : null,
              ]}
            >
              <View style={[styles.themeIconWrap, { backgroundColor: colors.surfaceSecondary }]}>
                <Ionicons name={item.icon} size={16} color={colors.textSecondary} />
              </View>
              <View style={styles.rowMeta}>
                <Text style={[styles.rowTitle, { color: colors.text }]}>{item.title}</Text>
                <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>{item.subtitle}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>
    </>
  ), [
    cacheSummaryText,
    colors.accent,
    colors.accentLight,
    colors.separator,
    colors.surface,
    colors.surfaceSecondary,
    colors.text,
    colors.textSecondary,
    colors.textTertiary,
    colors.warning,
    currentTrackId,
    currentVersion,
    deletingLocalIds,
    handleDeleteLocalTrack,
    handleImportLocalMusicFiles,
    handlePlayLocalTrack,
    localEntries,
    localImporting,
    localSummaryText,
    navigateToSubPage,
    runtimeLogSummaryText,
    overviewItems,
    handleOpenFeedbackWebsite,
    reduceMotionEnabled,
    renderHeader,
    selectedSource,
    themeMode,
  ])

  const renderNoopItem = useCallback(() => null, [])

  const renderAppearancePage = () => (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>主题模式</Text>
        <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>{THEME_LABELS[themeMode]}</Text>
      </View>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
        {THEME_OPTIONS.map((option, index) => {
          const active = themeMode === option.value
          const isLast = index === THEME_OPTIONS.length - 1
          return (
            <MotionPressable
              key={option.value}
              onPress={() => handleThemeChange(option.value)}
              reducedMotion={reduceMotionEnabled}
              style={!isLast ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator } : null}
            >
              <View style={styles.optionRow}>
                <View style={[styles.themeIconWrap, { backgroundColor: active ? colors.accentLight : colors.surfaceSecondary }]}>
                  <Ionicons name={option.icon} size={16} color={active ? colors.accent : colors.textSecondary} />
                </View>
                <View style={styles.rowMeta}>
                  <Text style={[styles.rowTitle, { color: colors.text }]}>{option.label}</Text>
                  <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>{option.description}</Text>
                </View>
                {active && <Ionicons name="checkmark-circle" size={20} color={colors.accent} />}
              </View>
            </MotionPressable>
          )
        })}
      </View>
      <Text style={[styles.swipeHint, { color: colors.textTertiary }]}>从屏幕最左侧向右滑动可返回</Text>
    </View>
  )

  const renderSourcesPage = () => (
    <>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>播放配置</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>{selectedSource ? `当前：${selectedSource.name}` : '未选择音源'}</Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={[styles.switchRow, { borderBottomColor: colors.separator }]}>
            <View style={styles.rowMeta}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>自动切换音源</Text>
              <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>当前源失败后自动尝试其它已启用音源</Text>
            </View>
            <Switch value={musicSourceState.autoSwitch} onValueChange={handleAutoSwitchChange} />
          </View>

          <Text style={[styles.qualityTitle, { color: colors.textSecondary }]}>音源品质</Text>
          <View style={styles.qualityWrap}>
            {ALL_QUALITIES.map((quality) => {
              const active = musicSourceState.preferredQuality === quality
              return (
                <MotionPressable
                  key={quality}
                  onPress={() => handleQualityChange(quality)}
                  reducedMotion={reduceMotionEnabled}
                  style={[styles.qualityChip, { backgroundColor: active ? colors.accent : colors.surfaceSecondary }]}
                >
                  <View style={styles.qualityChipInner}>
                    <Text style={[styles.qualityText, { color: active ? '#FFFFFF' : colors.textSecondary }]}>
                      {QUALITY_LABELS[quality]}
                    </Text>
                  </View>
                </MotionPressable>
              )
            })}
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>已导入音源</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>{importedSources.length} 个</Text>
        </View>

        <View style={styles.actionsRow}>
          <MotionPressable
            onPress={openCreateSourceModal}
            reducedMotion={reduceMotionEnabled}
            style={[styles.actionBtn, { backgroundColor: colors.surfaceSecondary }]}
          >
            <View style={styles.actionBtnContent}>
              <Ionicons name="add-circle-outline" size={15} color={colors.textSecondary} />
              <Text style={[styles.actionText, { color: colors.textSecondary }]}>添加 / URL 导入</Text>
            </View>
          </MotionPressable>

          <MotionPressable
            onPress={handleImportLocalJsFile}
            reducedMotion={reduceMotionEnabled}
            style={[styles.actionBtn, { backgroundColor: colors.surfaceSecondary }]}
          >
            <View style={styles.actionBtnContent}>
              <Ionicons name="document-attach-outline" size={15} color={colors.textSecondary} />
              <Text style={[styles.actionText, { color: colors.textSecondary }]}>本地 JS 导入</Text>
            </View>
          </MotionPressable>
        </View>

        <View style={styles.listWrap}>
          {importedSources.length === 0 && (
            <View style={[styles.emptyCard, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
              <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>还没有导入音源</Text>
            </View>
          )}

          {importedSources.map((source) => {
            const active = source.id === selectedImportedSourceId
            const enabled = source.enabled
            return (
              <View
                key={source.id}
                style={[
                  styles.sourceCard,
                  {
                    backgroundColor: enabled ? colors.accentLight : colors.surface,
                    borderColor: enabled ? colors.accent : colors.separator,
                  },
                ]}
              >
                <View style={styles.sourceHeadRow}>
                  <Text style={[styles.sourceName, { color: colors.text }]} numberOfLines={1}>{source.name}</Text>
                  <View
                    style={[
                      styles.sourceStatusBadge,
                      { backgroundColor: enabled ? colors.accent : colors.surfaceSecondary },
                    ]}
                  >
                    <Text style={[styles.sourceStatusBadgeText, { color: enabled ? '#FFFFFF' : colors.textSecondary }]}>
                      {enabled ? '已启用' : '已停用'}
                    </Text>
                  </View>
                </View>

                {active && (
                  <View style={[styles.sourceCurrentBadge, { backgroundColor: colors.surfaceSecondary }]}>
                    <Text style={[styles.sourceCurrentBadgeText, { color: colors.textSecondary }]}>当前使用中</Text>
                  </View>
                )}

                <Text style={[styles.sourceMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                  API: {source.apiUrl || '未配置'}
                </Text>

                <View style={styles.sourceActions}>
                  <MotionPressable
                    onPress={() => handleUseSource(source)}
                    reducedMotion={reduceMotionEnabled}
                    style={[styles.cardBtn, { backgroundColor: colors.surfaceSecondary }]}
                  >
                    <View style={styles.cardBtnContent}>
                      <Text style={[styles.cardBtnText, { color: colors.textSecondary }]}>设为当前</Text>
                    </View>
                  </MotionPressable>

                  <MotionPressable
                    onPress={() => handleToggleSource(source)}
                    reducedMotion={reduceMotionEnabled}
                    style={[
                      styles.cardBtn,
                      {
                        backgroundColor: enabled ? 'rgba(255,59,48,0.14)' : 'rgba(52,199,89,0.16)',
                      },
                    ]}
                  >
                    <View style={styles.cardBtnContent}>
                      <Text style={[styles.cardBtnText, { color: enabled ? '#D70015' : '#16833D' }]}>
                        {enabled ? '停用' : '启用'}
                      </Text>
                    </View>
                  </MotionPressable>

                  <MotionPressable
                    onPress={() => openEditSourceModal(source)}
                    reducedMotion={reduceMotionEnabled}
                    style={[styles.cardBtn, { backgroundColor: colors.surfaceSecondary }]}
                  >
                    <View style={styles.cardBtnContent}>
                      <Text style={[styles.cardBtnText, { color: colors.textSecondary }]}>编辑</Text>
                    </View>
                  </MotionPressable>

                  <MotionPressable
                    onPress={() => handleDeleteSource(source)}
                    reducedMotion={reduceMotionEnabled}
                    style={[styles.cardBtn, { backgroundColor: colors.surfaceSecondary }]}
                  >
                    <View style={styles.cardBtnContent}>
                      <Text style={[styles.cardBtnText, { color: colors.textSecondary }]}>删除</Text>
                    </View>
                  </MotionPressable>
                </View>
              </View>
            )
          })}
        </View>
      </View>

      <Text style={[styles.swipeHint, { color: colors.textTertiary }]}>从屏幕最左侧向右滑动可返回</Text>
    </>
  )

  const renderLocalPage = () => (
    <>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>导入说明</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
            {localStats.count} 首 · {formatCacheSize(localStats.sizeBytes)}
          </Text>
        </View>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={styles.localHintWrap}>
            <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>
              1. 文件名按「歌名-歌手」解析，例如「晴天-周杰伦.mp3」，横杠两边有没有空格都能识别{'\n'}
              2. 文件会复制进 App，不占用「文件」App 里的原件，删除 App 数据会丢失{'\n'}
              3. 搜索到同名歌曲时会自动命中本地文件播放，不再联网下载{'\n'}
              4. 同名文件重复导入会覆盖旧文件{'\n'}
              5. 导入后会自动联网补全封面与歌词（按歌名 + 歌手匹配在线曲目），没补上的可点上方按钮重试
            </Text>
          </View>
          {localStats.missingCount > 0 && (
            <MotionPressable
              onPress={() => void handlePruneMissingLocal()}
              reducedMotion={reduceMotionEnabled}
              style={styles.dangerAction}
            >
              <View style={styles.dangerActionInner}>
                <Ionicons name="warning-outline" size={17} color={colors.warning} />
                <Text style={[styles.dangerActionText, { color: colors.warning }]}>
                  清理 {localStats.missingCount} 条失效记录
                </Text>
              </View>
            </MotionPressable>
          )}

          <MotionPressable
            onPress={handleImportLocalMusicFiles}
            reducedMotion={reduceMotionEnabled}
            disabled={localImporting}
            style={styles.dangerAction}
          >
            <View style={styles.dangerActionInner}>
              {localImporting
                ? <ActivityIndicator size="small" color={colors.accent} />
                : <Ionicons name="add-circle-outline" size={17} color={colors.accent} />}
              <Text style={[styles.dangerActionText, { color: colors.accent }]}>
                {localImporting ? '正在导入...' : '从文件导入歌曲'}
              </Text>
            </View>
          </MotionPressable>

          <MotionPressable
            onPress={() => void runLocalEnrich(true)}
            reducedMotion={reduceMotionEnabled}
            disabled={localEnriching}
            style={styles.dangerAction}
          >
            <View style={styles.dangerActionInner}>
              {localEnriching
                ? <ActivityIndicator size="small" color={colors.textSecondary} />
                : <Ionicons name="images-outline" size={17} color={colors.textSecondary} />}
              <Text style={[styles.dangerActionText, { color: colors.textSecondary }]}>
                {localEnriching && localEnrichProgress
                  ? `补全中 ${localEnrichProgress.done}/${localEnrichProgress.total}`
                  : '补全封面与歌词'}
              </Text>
            </View>
          </MotionPressable>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>已导入歌曲</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
            {localKeyword.trim()
              ? `匹配 ${visibleLocalEntries.length} / ${localEntries.length} 首`
              : `共 ${localEntries.length} 首`}
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={[styles.cacheToolbar, { borderBottomColor: colors.separator }]}>
            <View style={[styles.cacheSearchWrap, { backgroundColor: colors.surfaceSecondary }]}>
              <Ionicons name="search-outline" size={14} color={colors.textTertiary} />
              <TextInput
                style={[styles.cacheSearchInput, { color: colors.text }]}
                value={localKeyword}
                onChangeText={setLocalKeyword}
                placeholder="搜索歌名 / 歌手 / 文件名"
                placeholderTextColor={colors.searchPlaceholder}
                returnKeyType="search"
                clearButtonMode="never"
              />
              {localKeyword.length > 0 && (
                <TouchableOpacity
                  onPress={() => setLocalKeyword('')}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="清除搜索关键字"
                >
                  <Ionicons name="close-circle" size={15} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>

            <MotionPressable
              onPress={handleToggleLocalSort}
              reducedMotion={reduceMotionEnabled}
              style={[styles.cacheSortBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <View style={styles.cacheSortBtnInner}>
                <Ionicons
                  name={localSortMode === 'size' ? 'resize-outline' : 'time-outline'}
                  size={13}
                  color={colors.textSecondary}
                />
                <Text style={[styles.cacheSortBtnText, { color: colors.textSecondary }]}>
                  {localSortMode === 'size' ? '占用最大' : '最近导入'}
                </Text>
              </View>
            </MotionPressable>
          </View>

          {visibleLocalEntries.length === 0 && (
            <View style={styles.cacheEmptyWrap}>
              <Ionicons name="folder-open-outline" size={22} color={colors.textTertiary} />
              <Text style={[styles.cacheEmptyText, { color: colors.textSecondary }]}>
                {localEntries.length === 0
                  ? '还没有导入歌曲，点上方「从文件导入歌曲」开始'
                  : '没有匹配的歌曲'}
              </Text>
            </View>
          )}

          {visibleLocalEntries.slice(0, LOCAL_LIST_RENDER_LIMIT).map((entry, index) => (
            <LocalTrackRow
              key={entry.id}
              entry={entry}
              colors={colors}
              deleting={Boolean(deletingLocalIds[entry.id])}
              isCurrentTrack={currentTrackId === localEntryTrackId(entry)}
              reducedMotion={reduceMotionEnabled}
              isLast={index === Math.min(visibleLocalEntries.length, LOCAL_LIST_RENDER_LIMIT) - 1}
              onPlay={handlePlayLocalTrack}
              onDelete={handleDeleteLocalTrack}
            />
          ))}

          {visibleLocalEntries.length > LOCAL_LIST_RENDER_LIMIT && (
            <View style={[styles.cacheMoreHint, { borderTopColor: colors.separator }]}>
              <Text style={[styles.cacheMoreHintText, { color: colors.textTertiary }]}>
                仅显示前 {LOCAL_LIST_RENDER_LIMIT} 条，可用上方搜索定位其他歌曲
              </Text>
            </View>
          )}
        </View>
      </View>

      <Text style={[styles.swipeHint, { color: colors.textTertiary }]}>从屏幕最左侧向右滑动可返回</Text>
    </>
  )

  const renderCachePage = () => (
    <>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>缓存策略</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>{cacheEnabled ? '自动缓存中' : '缓存已关闭'}</Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={[styles.switchRow, { borderBottomColor: colors.separator }]}>
            <View style={styles.rowMeta}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>开启歌曲缓存</Text>
              <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>点击播放歌曲后自动缓存到本地，下次优先本地播放</Text>
            </View>
            <Switch value={cacheEnabled} onValueChange={handleToggleAudioCache} />
          </View>

          <View style={styles.cacheStatsWrap}>
            <View style={[styles.cacheStatItem, { backgroundColor: colors.surfaceSecondary }]}>
              <Text style={[styles.cacheStatLabel, { color: colors.textSecondary }]}>在线缓存</Text>
              <Text style={[styles.cacheStatValue, { color: colors.text }]}>{cacheFileCount} 首</Text>
            </View>
            <View style={[styles.cacheStatItem, { backgroundColor: colors.surfaceSecondary }]}>
              <Text style={[styles.cacheStatLabel, { color: colors.textSecondary }]}>本地导入</Text>
              <Text style={[styles.cacheStatValue, { color: colors.text }]}>{localStats.count} 首</Text>
            </View>
          </View>

          <View style={[styles.cacheStatsWrap, styles.cacheStatsWrapTight]}>
            <View style={[styles.cacheStatItem, { backgroundColor: colors.surfaceSecondary }]}>
              <Text style={[styles.cacheStatLabel, { color: colors.textSecondary }]}>在线占用</Text>
              <Text style={[styles.cacheStatValue, { color: colors.text }]}>{formatCacheSize(cacheSizeBytes)}</Text>
            </View>
            <View style={[styles.cacheStatItem, { backgroundColor: colors.surfaceSecondary }]}>
              <Text style={[styles.cacheStatLabel, { color: colors.textSecondary }]}>本地占用</Text>
              <Text style={[styles.cacheStatValue, { color: colors.text }]}>
                {formatCacheSize(localStats.sizeBytes)}
                {localStats.missingCount ? ` · ${localStats.missingCount} 丢失` : ''}
              </Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>已缓存歌曲</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
            {cacheLoading && !cacheEntries.length
              ? '读取中...'
              : cacheKeyword.trim()
                ? `匹配 ${visibleCacheEntries.length} / ${cacheEntries.length} 首`
                : `共 ${cacheEntries.length} 首`}
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={[styles.cacheToolbar, { borderBottomColor: colors.separator }]}>
            <View style={[styles.cacheSearchWrap, { backgroundColor: colors.surfaceSecondary }]}>
              <Ionicons name="search-outline" size={14} color={colors.textTertiary} />
              <TextInput
                style={[styles.cacheSearchInput, { color: colors.text }]}
                value={cacheKeyword}
                onChangeText={setCacheKeyword}
                placeholder="搜索歌名 / 歌手 / ID"
                placeholderTextColor={colors.searchPlaceholder}
                returnKeyType="search"
                clearButtonMode="never"
              />
              {cacheKeyword.length > 0 && (
                <TouchableOpacity
                  onPress={() => setCacheKeyword('')}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="清除搜索关键字"
                >
                  <Ionicons name="close-circle" size={15} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>

            <MotionPressable
              onPress={handleToggleCacheSort}
              reducedMotion={reduceMotionEnabled}
              style={[styles.cacheSortBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <View style={styles.cacheSortBtnInner}>
                <Ionicons
                  name={cacheSortMode === 'size' ? 'resize-outline' : 'time-outline'}
                  size={13}
                  color={colors.textSecondary}
                />
                <Text style={[styles.cacheSortBtnText, { color: colors.textSecondary }]}>
                  {cacheSortMode === 'size' ? '占用最大' : '最近缓存'}
                </Text>
              </View>
            </MotionPressable>
          </View>

          {visibleCacheEntries.length === 0 && (
            <View style={styles.cacheEmptyWrap}>
              <Ionicons name="cloud-download-outline" size={22} color={colors.textTertiary} />
              <Text style={[styles.cacheEmptyText, { color: colors.textSecondary }]}>
                {cacheEntries.length === 0 ? '还没有缓存歌曲，播放后会自动缓存' : '没有匹配的歌曲'}
              </Text>
            </View>
          )}

          {visibleCacheEntries.slice(0, CACHE_LIST_RENDER_LIMIT).map((entry, index) => (
            <CachedSongRow
              key={entry.musicId}
              entry={entry}
              colors={colors}
              deleting={Boolean(deletingCacheIds[entry.musicId])}
              isCurrentTrack={currentTrackId === entry.musicId}
              reducedMotion={reduceMotionEnabled}
              isLast={index === Math.min(visibleCacheEntries.length, CACHE_LIST_RENDER_LIMIT) - 1}
              onDelete={handleDeleteSingleCache}
            />
          ))}

          {visibleCacheEntries.length > CACHE_LIST_RENDER_LIMIT && (
            <View style={[styles.cacheMoreHint, { borderTopColor: colors.separator }]}>
              <Text style={[styles.cacheMoreHintText, { color: colors.textTertiary }]}>
                仅显示前 {CACHE_LIST_RENDER_LIMIT} 条，可用上方搜索定位其他歌曲
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>本地导入歌曲</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
            {localStats.count ? `${localStats.count} 首 · ${formatCacheSize(localStats.sizeBytes)}` : '未导入'}
          </Text>
        </View>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={[styles.dangerHintWrap, { borderBottomColor: colors.separator }]}>
            <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>
              这些是你从「文件」导入的歌曲，不受「清空本地缓存」影响；删除会一并删掉 App 内的文件副本。
            </Text>
          </View>

          {localEntries.length === 0 && (
            <View style={styles.cacheEmptyWrap}>
              <Ionicons name="folder-open-outline" size={22} color={colors.textTertiary} />
              <Text style={[styles.cacheEmptyText, { color: colors.textSecondary }]}>
                还没有导入歌曲，可在「我的 &gt; 本地音乐」中导入
              </Text>
            </View>
          )}

          {localEntries.slice(0, CACHE_LIST_RENDER_LIMIT).map((entry, index) => (
            <LocalTrackRow
              key={entry.id}
              entry={entry}
              colors={colors}
              deleting={Boolean(deletingLocalIds[entry.id])}
              isCurrentTrack={currentTrackId === localEntryTrackId(entry)}
              reducedMotion={reduceMotionEnabled}
              isLast={index === Math.min(localEntries.length, CACHE_LIST_RENDER_LIMIT) - 1}
              onPlay={handlePlayLocalTrack}
              onDelete={handleDeleteLocalTrack}
            />
          ))}

          {localEntries.length > CACHE_LIST_RENDER_LIMIT && (
            <TouchableOpacity
              style={[styles.cacheMoreHint, { borderTopColor: colors.separator }]}
              activeOpacity={0.6}
              onPress={() => navigateToSubPage('local')}
            >
              <Text style={[styles.cacheMoreHintText, { color: colors.accent }]}>
                查看全部 {localEntries.length} 首
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>批量清理</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>{cacheLoading ? '处理中...' : '危险操作'}</Text>
        </View>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={[styles.dangerHintWrap, { borderBottomColor: colors.separator }]}>
            <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>
              单首删除请在上方列表操作；此处只删除在线缓存，从「文件」导入的本地歌曲不受影响。
            </Text>
          </View>
          <MotionPressable
            onPress={handleClearAudioCache}
            reducedMotion={reduceMotionEnabled}
            disabled={cacheLoading || cacheFileCount === 0}
            style={styles.dangerAction}
          >
            <View style={styles.dangerActionInner}>
              {cacheLoading
                ? <ActivityIndicator size="small" color={colors.danger} />
                : <Ionicons name="trash-outline" size={17} color={cacheFileCount === 0 ? colors.textTertiary : colors.danger} />}
              <Text style={[styles.dangerActionText, { color: cacheFileCount === 0 ? colors.textTertiary : colors.danger }]}>
                删除全部本地缓存
              </Text>
            </View>
          </MotionPressable>
        </View>
      </View>

      <Text style={[styles.swipeHint, { color: colors.textTertiary }]}>从屏幕最左侧向右滑动可返回</Text>
    </>
  )

  const renderLogsPage = () => {
    const previewList = [...runtimeLogPreview].slice(-80).reverse()
    const levelColor = (level: RuntimeLogEntry['level']) => getLogLevelColor(level, colors)

    return (
      <>
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>日志概览</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
              最近更新 {formatDateTime(runtimeLastTimestamp)}
            </Text>
          </View>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
            <View style={styles.logStatWrap}>
              <View style={[styles.logStatItem, { backgroundColor: colors.surfaceSecondary }]}>
                <Text style={[styles.logStatLabel, { color: colors.textSecondary }]}>当前条数</Text>
                <Text style={[styles.logStatValue, { color: colors.text }]}>{runtimeLogCount}</Text>
              </View>
              <View style={[styles.logStatItem, { backgroundColor: colors.surfaceSecondary }]}>
                <Text style={[styles.logStatLabel, { color: colors.textSecondary }]}>采集状态</Text>
                <Text style={[styles.logStatValue, { color: colors.text }]}>已开启</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>日志操作</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>导出给开发排查</Text>
          </View>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
            <View style={styles.logActionsRow}>
              <MotionPressable
                onPress={() => { void handleExportRuntimeLogs() }}
                reducedMotion={reduceMotionEnabled}
                disabled={logExporting}
                style={[styles.logActionBtn, { backgroundColor: colors.surfaceSecondary }]}
              >
                <View style={styles.actionBtnContent}>
                  {logExporting
                    ? <ActivityIndicator size="small" color={colors.accent} />
                    : <Ionicons name="share-social-outline" size={15} color={colors.textSecondary} />}
                  <Text style={[styles.actionText, { color: colors.textSecondary }]}>
                    {logExporting ? '导出中...' : '导出日志'}
                  </Text>
                </View>
              </MotionPressable>

              <MotionPressable
                onPress={handleClearRuntimeLogs}
                reducedMotion={reduceMotionEnabled}
                disabled={logExporting || runtimeLogCount === 0}
                style={[
                  styles.logActionBtn,
                  {
                    backgroundColor: runtimeLogCount === 0 ? colors.surfaceSecondary : 'rgba(255,59,48,0.14)',
                  },
                ]}
              >
                <View style={styles.actionBtnContent}>
                  <Ionicons name="trash-outline" size={15} color={runtimeLogCount === 0 ? colors.textSecondary : colors.danger} />
                  <Text style={[styles.actionText, { color: runtimeLogCount === 0 ? colors.textSecondary : colors.danger }]}>清空日志</Text>
                </View>
              </MotionPressable>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>最近日志</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>仅预览最近 80 条</Text>
          </View>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
            {previewList.length === 0 && (
              <View style={styles.logEmptyWrap}>
                <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>暂无日志，请先复现问题后再导出</Text>
              </View>
            )}

            {previewList.map((entry, index) => (
              <TouchableOpacity
                key={entry.id}
                activeOpacity={0.6}
                onPress={() => setLogDetail(entry)}
                accessibilityLabel={`查看日志详情：${entry.message}`}
                style={[
                  styles.logItem,
                  index < previewList.length - 1
                    ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
                    : null,
                ]}
              >
                <View style={styles.logItemTop}>
                  <Text style={[styles.logItemTime, { color: colors.textTertiary }]}>{formatDateTime(entry.timestamp)}</Text>
                  <Text style={[styles.logItemLevel, { color: levelColor(entry.level) }]}>{entry.level.toUpperCase()}</Text>
                </View>
                <Text style={[styles.logItemMessage, { color: colors.text }]} numberOfLines={3}>
                  {entry.message}
                </Text>
                {entry.meta ? (
                  <Text style={[styles.logItemMeta, { color: colors.textSecondary }]} numberOfLines={4}>
                    {entry.meta}
                  </Text>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <Text style={[styles.swipeHint, { color: colors.textTertiary }]}>从屏幕最左侧向右滑动可返回</Text>
      </>
    )
  }

  const renderAboutPage = () => (
    <>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>应用信息</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>IPA 自签分发</Text>
        </View>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <View style={[styles.optionRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}>
            <View style={[styles.themeIconWrap, { backgroundColor: colors.surfaceSecondary }]}>
              <Ionicons name="apps-outline" size={16} color={colors.textSecondary} />
            </View>
            <View style={styles.rowMeta}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>当前版本</Text>
              <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>v{currentVersion}</Text>
            </View>
          </View>

          <MotionPressable
            onPress={() => { void handleCheckUpdate() }}
            reducedMotion={reduceMotionEnabled}
            disabled={checkingUpdate}
          >
            <View style={styles.optionRow}>
              <View style={[styles.themeIconWrap, { backgroundColor: colors.surfaceSecondary }]}>
                {checkingUpdate
                  ? <ActivityIndicator size="small" color={colors.accent} />
                  : <Ionicons name="cloud-download-outline" size={16} color={colors.textSecondary} />}
              </View>
              <View style={styles.rowMeta}>
                <Text style={[styles.rowTitle, { color: colors.text }]}>检查更新</Text>
                <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>
                  {checkingUpdate ? '正在检查...' : '检查 GitHub Release 最新版本'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
            </View>
          </MotionPressable>
        </View>
      </View>

      <Text style={[styles.swipeHint, { color: colors.textTertiary }]}>从屏幕最左侧向右滑动可返回</Text>
    </>
  )

  const pageAnimatedStyle = {
    opacity: pageAnim,
    transform: [
      {
        translateY: reduceMotionEnabled
          ? 0
          : pageAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [10, 0],
          }),
      },
    ],
  }

  return (
    <PanGestureHandler
      enabled={subPage !== 'main'}
      hitSlop={{ left: 0, width: 24 }}
      activeOffsetX={16}
      failOffsetY={[-16, 16]}
      onHandlerStateChange={handleSubPageSwipeStateChange}
    >
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Animated.View style={[styles.pageContainer, pageAnimatedStyle]}>
          {subPage === 'main' ? (
            <FlatList
              ref={mainListRef}
              onScroll={handleMainListScroll}
              scrollEventThrottle={16}
              data={[] as Track[]}
              renderItem={renderNoopItem}
              ListHeaderComponent={mainListHeader}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.mainListContent, { paddingBottom: BOTTOM_INSET + spacing.md }]}
            />
          ) : (
            <ScrollView
              ref={subPageScrollRef}
              onScroll={handleSubPageScroll}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: BOTTOM_INSET + spacing.md }}
            >
              {renderHeader()}
              {subPage === 'appearance' && renderAppearancePage()}
              {subPage === 'sources' && renderSourcesPage()}
              {subPage === 'cache' && renderCachePage()}
              {subPage === 'local' && renderLocalPage()}
              {subPage === 'logs' && renderLogsPage()}
              {subPage === 'about' && renderAboutPage()}
            </ScrollView>
          )}
        </Animated.View>

        <Modal
          transparent
          visible={Boolean(logDetail)}
          animationType="fade"
          onRequestClose={() => setLogDetail(null)}
        >
          <View style={styles.modalMask}>
            <View style={[styles.modalCard, styles.logDetailCard, { backgroundColor: colors.surface }]}>
              <View style={styles.logDetailHead}>
                <Text style={[styles.modalTitle, styles.logDetailTitle, { color: colors.text }]}>日志详情</Text>
                {logDetail && (
                  <View style={[styles.logDetailLevel, { backgroundColor: colors.surfaceSecondary }]}>
                    <Text
                      style={[
                        styles.logDetailLevelText,
                        { color: getLogLevelColor(logDetail.level, colors) },
                      ]}
                    >
                      {logDetail.level.toUpperCase()}
                    </Text>
                  </View>
                )}
              </View>

              <Text style={[styles.logDetailTime, { color: colors.textTertiary }]}>
                {logDetail ? formatDateTime(logDetail.timestamp) : ''}
              </Text>

              <ScrollView
                style={[styles.logDetailScroll, { backgroundColor: colors.surfaceSecondary }]}
                showsVerticalScrollIndicator
              >
                <Text selectable style={[styles.logDetailText, { color: colors.text }]}>
                  {logDetail?.message}
                </Text>
                {logDetail?.meta ? (
                  <Text selectable style={[styles.logDetailMeta, { color: colors.textSecondary }]}>
                    {logDetail.meta}
                  </Text>
                ) : null}
              </ScrollView>

              <TouchableOpacity
                style={[styles.modalBtn, styles.logDetailCloseBtn, { backgroundColor: colors.accent }]}
                activeOpacity={0.8}
                onPress={() => setLogDetail(null)}
              >
                <Text style={[styles.cardBtnText, { color: '#FFFFFF' }]}>关闭</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        <Modal transparent visible={sponsorModalVisible} animationType="fade" onRequestClose={() => setSponsorModalVisible(false)}>
          <View style={styles.modalMask}>
            <View style={[styles.modalCard, styles.sponsorModalCard, { backgroundColor: colors.surface }]}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>赞助作者</Text>
              <Text style={[styles.sponsorHint, { color: colors.textSecondary }]}>微信扫一扫支持一下</Text>
              <Image
                source={{ uri: 'https://ojason.oss-cn-chengdu.aliyuncs.com/hexo-blog/dfc8ad9d3f5cf38d65f3d7516360d8e9.jpg' }}
                style={[styles.sponsorQrImage, { borderColor: colors.separator }]}
                resizeMode="cover"
              />
              <TouchableOpacity
                style={[styles.modalBtn, styles.sponsorCloseBtn, { backgroundColor: colors.accent }]}
                onPress={() => setSponsorModalVisible(false)}
              >
                <Text style={[styles.cardBtnText, { color: '#FFFFFF' }]}>关闭</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        <Modal transparent visible={sourceModalVisible} animationType="fade" onRequestClose={() => setSourceModalVisible(false)}>
          <View style={styles.modalMask}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>{editingSourceId ? '编辑音源' : '添加 / URL 导入音源'}</Text>

            {!editingSourceId && (
              <View style={[styles.segmentWrap, { backgroundColor: colors.surfaceSecondary }]}>
                <TouchableOpacity
                  style={[styles.segmentItem, sourceModalMode === 'manual' ? { backgroundColor: colors.accentLight } : null]}
                  onPress={() => setSourceModalMode('manual')}
                >
                  <Text style={[styles.segmentText, { color: sourceModalMode === 'manual' ? colors.accent : colors.textSecondary }]}>手动添加</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.segmentItem, sourceModalMode === 'url' ? { backgroundColor: colors.accentLight } : null]}
                  onPress={() => setSourceModalMode('url')}
                >
                  <Text style={[styles.segmentText, { color: sourceModalMode === 'url' ? colors.accent : colors.textSecondary }]}>URL 导入</Text>
                </TouchableOpacity>
              </View>
            )}

            {(editingSourceId || sourceModalMode === 'manual') && (
              <>
                <TextInput
                  value={manualName}
                  onChangeText={setManualName}
                  placeholder="音源名称"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.input, { color: colors.text, borderColor: colors.separator }]}
                />
                <TextInput
                  value={manualApiUrl}
                  onChangeText={setManualApiUrl}
                  placeholder="API 地址"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  style={[styles.input, { color: colors.text, borderColor: colors.separator }]}
                />
                <TextInput
                  value={manualApiKey}
                  onChangeText={setManualApiKey}
                  placeholder="API Key（可选）"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  style={[styles.input, { color: colors.text, borderColor: colors.separator }]}
                />
              </>
            )}

            {!editingSourceId && sourceModalMode === 'url' && (
              <TextInput
                value={importUrl}
                onChangeText={setImportUrl}
                placeholder="https://xxx.com/source.js"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                style={[styles.input, { color: colors.text, borderColor: colors.separator }]}
              />
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.surfaceSecondary }]} onPress={() => setSourceModalVisible(false)}>
                <Text style={[styles.cardBtnText, { color: colors.textSecondary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.accent }]} onPress={handleSubmitSourceModal} disabled={sourceModalLoading}>
                {sourceModalLoading
                  ? <ActivityIndicator size="small" color="#FFFFFF" />
                  : <Text style={[styles.cardBtnText, { color: '#FFFFFF' }]}>{editingSourceId ? '保存' : '确认'}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </Modal>

        <QueueSheet
          visible={queueSheetVisible}
          renderTrack={playerState.currentTrack}
          animValue={queueSheetAnim}
          isPlaying={playerState.isPlaying}
          onClose={() => setQueueSheetVisible(false)}
          onSyncStore={syncQueueSheetStore}
        />
      </View>
    </PanGestureHandler>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  pageContainer: { flex: 1 },
  mainListContent: {
    paddingBottom: spacing.md,
  },
  header: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  largeTitle: {
    fontSize: fontSize.largeTitle - 2,
    fontWeight: '800',
    letterSpacing: 0.24,
  },
  headerSidePlaceholder: { width: 72 },
  backButtonShell: {
    width: 72,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  backButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  backText: {
    fontSize: fontSize.caption1,
    marginLeft: 2,
    fontWeight: '600',
  },
  section: { marginBottom: spacing.lg },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  sectionTitle: { fontSize: fontSize.headline, fontWeight: '700' },
  sectionSubtitle: { fontSize: fontSize.footnote, fontWeight: '600' },

  overviewCard: {
    marginHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  overviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  overviewItem: {
    width: '50%',
    minHeight: 92,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    justifyContent: 'center',
  },
  overviewTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  overviewIconWrap: {
    width: 22,
    height: 22,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overviewLabel: {
    marginLeft: 6,
    fontSize: fontSize.caption1,
    fontWeight: '600',
  },
  overviewValue: {
    fontSize: fontSize.subhead,
    fontWeight: '700',
  },

  entryList: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  entryCard: {
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  entryCardContent: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  entryIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryMeta: {
    flex: 1,
    marginLeft: spacing.sm,
    marginRight: spacing.sm,
  },
  entryTitle: {
    fontSize: fontSize.body,
    fontWeight: '700',
  },
  entrySubtitle: {
    marginTop: 2,
    fontSize: fontSize.caption1,
    fontWeight: '500',
  },
  card: {
    marginHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  optionRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  themeIconWrap: {
    width: 30,
    height: 30,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMeta: { flex: 1 },
  rowTitle: { fontSize: fontSize.body, fontWeight: '700' },
  rowDesc: { marginTop: 2, fontSize: fontSize.caption1 },
  switchRow: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  qualityTitle: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    fontSize: fontSize.caption1,
    fontWeight: '600',
  },
  qualityWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.xs,
  },
  qualityChip: {
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  qualityChipInner: {
    minHeight: 30,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  qualityText: { fontSize: fontSize.caption2, fontWeight: '700' },

  actionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  actionBtnContent: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  actionText: { fontSize: fontSize.caption1, fontWeight: '700' },

  listWrap: { gap: spacing.sm, marginHorizontal: spacing.md },
  emptyCard: {
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    alignItems: 'center',
  },
  sourceCard: {
    borderRadius: borderRadius.md,
    padding: spacing.md,
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sourceHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  sourceName: {
    flex: 1,
    fontSize: fontSize.body,
    fontWeight: '700',
  },
  sourceStatusBadge: {
    minHeight: 22,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceStatusBadgeText: { fontSize: fontSize.caption2, fontWeight: '700' },
  sourceCurrentBadge: {
    alignSelf: 'flex-start',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    minHeight: 20,
    justifyContent: 'center',
  },
  sourceCurrentBadgeText: { fontSize: fontSize.caption2, fontWeight: '600' },
  sourceMeta: { fontSize: fontSize.caption1 },
  sourceActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  cardBtn: {
    flexGrow: 1,
    minWidth: 64,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  cardBtnContent: {
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  cardBtnText: { fontSize: fontSize.caption1, fontWeight: '700' },

  cacheStatsWrap: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  cacheStatItem: {
    flex: 1,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  cacheStatLabel: {
    fontSize: fontSize.caption2,
    marginBottom: 4,
  },
  cacheStatsWrapTight: {
    paddingTop: 0,
  },
  cacheStatValue: {
    fontSize: fontSize.subhead,
    fontWeight: '700',
  },
  cacheToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cacheSearchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    height: 32,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
  },
  cacheSearchInput: {
    flex: 1,
    fontSize: fontSize.caption1,
    paddingVertical: 0,
  },
  cacheSortBtn: {
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  cacheSortBtnInner: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm,
  },
  cacheSortBtnText: { fontSize: fontSize.caption2, fontWeight: '700' },
  cacheEmptyWrap: {
    minHeight: 96,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  cacheEmptyText: { fontSize: fontSize.caption1, textAlign: 'center' },
  cacheRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  cacheRowIcon: {
    width: 34,
    height: 34,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cacheRowMeta: { flex: 1 },
  cacheRowTitle: { fontSize: fontSize.subhead, fontWeight: '600' },
  cacheRowSubtitle: { marginTop: 1, fontSize: fontSize.caption1 },
  cacheRowInfo: { marginTop: 1, fontSize: fontSize.caption2 },
  cacheRowRight: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  cacheRowSize: { fontSize: fontSize.caption1, fontWeight: '700' },
  cacheRowDeleteBtn: {
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  cacheRowDeleteInner: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cacheMoreHint: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  cacheMoreHintText: { fontSize: fontSize.caption2, textAlign: 'center' },
  localRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  localRowTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  localBadge: {
    borderRadius: borderRadius.full,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  localBadgeText: { fontSize: 9, fontWeight: '700' },
  localHintWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  dangerHintWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dangerAction: {
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  dangerActionInner: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  dangerActionText: {
    fontSize: fontSize.subhead,
    fontWeight: '700',
  },
  logStatWrap: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  logStatItem: {
    flex: 1,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  logStatLabel: {
    fontSize: fontSize.caption2,
    marginBottom: 4,
  },
  logStatValue: {
    fontSize: fontSize.subhead,
    fontWeight: '700',
  },
  logActionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  logActionBtn: {
    flex: 1,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  logEmptyWrap: {
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  logItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 4,
  },
  logItemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  logItemTime: {
    fontSize: fontSize.caption2,
    fontWeight: '600',
  },
  logItemLevel: {
    fontSize: fontSize.caption2,
    fontWeight: '700',
  },
  logItemMessage: {
    fontSize: fontSize.caption1,
    fontWeight: '600',
  },
  logItemMeta: {
    fontSize: fontSize.caption2,
    lineHeight: 16,
  },
  logDetailCard: {
    width: '94%',
    maxWidth: 520,
    maxHeight: '80%',
  },
  logDetailHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  logDetailTitle: {
    flex: 1,
    marginBottom: 0,
  },
  logDetailLevel: {
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  logDetailLevelText: {
    fontSize: fontSize.caption2,
    fontWeight: '700',
  },
  logDetailTime: {
    fontSize: fontSize.caption2,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  logDetailScroll: {
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
    maxHeight: 380,
  },
  logDetailText: {
    fontSize: fontSize.caption1,
    lineHeight: 18,
  },
  logDetailMeta: {
    marginTop: spacing.sm,
    fontSize: fontSize.caption2,
    lineHeight: 16,
  },
  logDetailCloseBtn: {
    flex: 0,
    marginTop: spacing.md,
  },

  swipeHint: {
    textAlign: 'center',
    marginTop: spacing.md,
    fontSize: fontSize.caption2,
    fontWeight: '500',
  },

  modalMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  modalCard: {
    width: '100%',
    borderRadius: borderRadius.md,
    padding: spacing.md,
  },
  modalTitle: {
    fontSize: fontSize.headline,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  segmentWrap: {
    height: 34,
    borderRadius: borderRadius.sm,
    padding: 2,
    flexDirection: 'row',
    marginBottom: spacing.sm,
  },
  segmentItem: {
    flex: 1,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: {
    fontSize: fontSize.caption1,
    fontWeight: '700',
  },
  input: {
    height: 42,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
  },
  modalActions: { flexDirection: 'row', gap: spacing.sm },
  modalBtn: {
    flex: 1,
    height: 38,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sponsorModalCard: {
    width: '86%',
    maxWidth: 340,
    alignItems: 'center',
  },
  sponsorHint: {
    marginBottom: spacing.sm,
    fontSize: fontSize.caption1,
    fontWeight: '500',
  },
  sponsorQrImage: {
    width: 260,
    height: 260,
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sponsorCloseBtn: {
    marginTop: spacing.md,
    minWidth: 120,
    flex: 0,
    paddingHorizontal: spacing.lg,
  },
})
