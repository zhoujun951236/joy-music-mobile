/**
 * QueueSheet - 播放队列底部弹出面板。
 * 从 NowPlaying/index.tsx 提取的独立组件，包含队列渲染、操作回调及内部状态。
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Easing,
  Dimensions,
  Pressable,
  Alert,
  FlatList,
  ListRenderItemInfo,
  Platform,
} from 'react-native';
import DraggableFlatList, {
  RenderItemParams,
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme, spacing, fontSize, borderRadius } from '../../theme';
import { playerController } from '../../core/player';
import { clearTrackCacheById } from '../../core/music/cache';
import type { RootState } from '../../store';
import type { Track } from '../../types/music';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const QUEUE_SHEET_HEIGHT = Math.min(560, SCREEN_HEIGHT * 0.66);
const QUEUE_ITEM_HEIGHT = 56;

interface QueueSheetProps {
  visible: boolean;
  renderTrack: Track | null;
  animValue: Animated.Value;
  isPlaying: boolean;
  onClose: () => void;
  onSyncStore: () => void;
}

function QueueSheet({
  visible,
  renderTrack,
  animValue,
  isPlaying,
  onClose,
  onSyncStore,
}: QueueSheetProps) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const dispatch = useDispatch();
  const queue = useSelector((state: RootState) => state.player.playlist);
  const playlists = useSelector((state: RootState) => state.playlist.playlists);

  /* ── 队列内部状态 ── */
  const [queueDraft, setQueueDraft] = useState<Track[]>(queue);
  // DraggableFlatList 内部使用 react-native-gesture-handler 的 FlatList，
  // 这里只用到 scrollToIndex/scrollToOffset 接口，弱类型即可。
  const listRef = useRef<any>(null);

  /* ── 身份工具 ── */
  const getTrackIdentityToken = useCallback(
    (track: Track | null | undefined): string => {
      if (!track) return '';
      const raw = track.id || track.songmid || track.hash || track.copyrightId;
      const normalized = String(raw || '').trim();
      if (normalized) return normalized;
      const title = String(track.title || '').trim();
      const artist = String(track.artist || '').trim();
      const duration = Number.isFinite(track.duration) ? String(track.duration) : '';
      return `${title}::${artist}::${duration}`.trim();
    },
    [],
  );

  const isValidTrack = useCallback(
    (track: Track | null | undefined): track is Track => {
      if (!track) return false;
      return getTrackIdentityToken(track).length > 0;
    },
    [getTrackIdentityToken],
  );

  const getTrackIdentity = useCallback(
    (track: Track) => {
      const source = String(track.source || 'unknown').toLowerCase();
      const token = getTrackIdentityToken(track);
      return `${source}::${token}`;
    },
    [getTrackIdentityToken],
  );

  const resolveQueueSnapshot = useCallback((): Track[] => {
    const runtimeQueue = playerController.getPlaylist().filter(isValidTrack);
    if (runtimeQueue.length) return runtimeQueue;
    const reduxQueue = queue.filter(isValidTrack);
    if (reduxQueue.length) return reduxQueue;
    return isValidTrack(renderTrack) ? [renderTrack] : [];
  }, [isValidTrack, queue, renderTrack]);

  /* ── 同步队列快照 ── */
  useEffect(() => {
    setQueueDraft(resolveQueueSnapshot());
  }, [queue, resolveQueueSnapshot, renderTrack?.id, renderTrack?.songmid, renderTrack?.source]);

  /* ── 派生列表数据 ── */
  const queueListData = useMemo(
    () => queueDraft.filter(isValidTrack),
    [isValidTrack, queueDraft],
  );
  const queueRenderData = useMemo(() => {
    if (queueListData.length > 0) return queueListData;
    return isValidTrack(renderTrack) ? [renderTrack] : [];
  }, [isValidTrack, queueListData, renderTrack]);

  const queueDisplayCount = useMemo(
    () => queueRenderData.length,
    [queueRenderData],
  );

  /* ── 当前播放在队列中的位置，决定打开 sheet 时 FlatList 自动滚到哪一行 ── */
  const currentRenderIndex = useMemo(() => {
    if (!isValidTrack(renderTrack)) return -1;
    const targetId = getTrackIdentity(renderTrack);
    return queueRenderData.findIndex((track) => getTrackIdentity(track) === targetId);
  }, [getTrackIdentity, isValidTrack, queueRenderData, renderTrack]);

  const initialScrollIndex = useMemo(() => {
    if (currentRenderIndex < 0) return undefined;
    if (currentRenderIndex >= queueRenderData.length) return undefined;
    return currentRenderIndex;
  }, [currentRenderIndex, queueRenderData.length]);

  /* ── 仅在 sheet 从关闭 → 打开的瞬间滚到当前歌曲一次。
   *
   *    设计目标：
   *    - 用户进 sheet 第一眼能看到"现在在播/暂停"那首歌
   *    - 用户拖动排序松手后不要跳（拖动 → moveTrackInQueue → currentIndex 变 →
   *      千万不能因此重跑滚动逻辑，否则视野被强行拉到当前歌，体感是"跳跃"）
   *
   *    实现：用 ref 记住上一次 visible，只在 false → true 边沿触发；
   *    依赖数组只放 visible，不依赖 currentRenderIndex（拖动时它会变）。
   *    用 ref 读取最新 currentRenderIndex 避免 stale closure。 ── */
  const prevVisibleRef = useRef(false);
  const currentRenderIndexRef = useRef(currentRenderIndex);
  useEffect(() => {
    currentRenderIndexRef.current = currentRenderIndex;
  }, [currentRenderIndex]);

  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible || wasVisible) return; // 只处理 false → true

    let cancelled = false;
    let firstTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const tryScroll = () => {
      if (cancelled) return;
      const idx = currentRenderIndexRef.current;
      if (idx < 0) return;
      try {
        listRef.current?.scrollToIndex({
          index: idx,
          animated: false,
          viewPosition: 0.3,
        });
      } catch {
        // onScrollToIndexFailed 兜底
      }
    };

    firstTimer = setTimeout(() => {
      tryScroll();
      // 大列表第一次可能因 measure 不到位失败，再重试一次。
      retryTimer = setTimeout(() => {
        if (cancelled) return;
        tryScroll();
      }, 250);
    }, 280);

    return () => {
      cancelled = true;
      if (firstTimer) clearTimeout(firstTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [visible]);

  /* ── 关闭动画 ── */
  const closeQueueSheet = useCallback(() => {
    // 关闭时若仍在排序模式视为放弃修改
    setIsReorderMode(false);
    setReorderDraft([]);
    Animated.timing(animValue, {
      toValue: 0,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      onClose();
    });
  }, [animValue, onClose]);

  /* ── 队列操作回调 ── */
  const handleAppendTrackToPlaylist = useCallback(
    (track: Track, playlistId: string) => {
      const targetPlaylist = playlists.find((item) => item.id === playlistId);
      if (!targetPlaylist) {
        Alert.alert('添加失败', '目标歌单不存在或已删除。');
        return;
      }

      const exists = targetPlaylist.tracks.some(
        (item) => getTrackIdentity(item) === getTrackIdentity(track),
      );
      if (exists) {
        Alert.alert('已存在', `「${track.title}」已经在「${targetPlaylist.name}」中。`);
        return;
      }

      dispatch({
        type: 'PLAYLIST_UPDATE',
        payload: {
          ...targetPlaylist,
          tracks: [...targetPlaylist.tracks, { ...track }],
          updatedAt: Date.now(),
        },
      });
      Alert.alert('添加成功', `已添加到「${targetPlaylist.name}」。`);
    },
    [dispatch, getTrackIdentity, playlists],
  );

  const handleAddQueueTrackToPlaylist = useCallback(
    (track: Track) => {
      if (!playlists.length) {
        Alert.alert('暂无自定义歌单', '请先在歌单页创建或导入歌单。');
        return;
      }
      Alert.alert(
        '添加到歌单',
        `选择要添加「${track.title}」的歌单`,
        [
          ...playlists.map((playlist) => ({
            text: playlist.name,
            onPress: () => {
              handleAppendTrackToPlaylist(track, playlist.id);
            },
          })),
          { text: '取消', style: 'cancel' as const },
        ],
      );
    },
    [handleAppendTrackToPlaylist, playlists],
  );

  const handleRemoveQueueTrack = useCallback(
    async (track: Track) => {
      try {
        const removed = await playerController.removeTrackFromQueue(track);
        if (!removed) {
          Alert.alert('提示', '当前播放列表中未找到该歌曲。');
          return;
        }
        const latestQueue = playerController.getPlaylist();
        setQueueDraft(latestQueue);
        if (!latestQueue.length) {
          onClose();
        }
        onSyncStore();
      } catch (error) {
        console.error('Remove queue track error:', error);
        Alert.alert('移除失败', '从播放列表移除歌曲失败，请稍后重试。');
      }
    },
    [onClose, onSyncStore],
  );

  /**
   * 移除播放列表 + 清理该歌曲缓存。
   * 本地导入的歌曲不清理：那是用户自己放进来的文件，由用户在「本地音乐」里管理。
   */
  const handleRemoveQueueTrackAndCache = useCallback(
    async (track: Track) => {
      const isLocalFile =
        track.isLocalFile === true ||
        String(track.source || '').toLowerCase() === 'local';
      try {
        const removed = await playerController.removeTrackFromQueue(track);
        if (!removed) {
          Alert.alert('提示', '当前播放列表中未找到该歌曲。');
          return;
        }
        const latestQueue = playerController.getPlaylist();
        setQueueDraft(latestQueue);
        if (!latestQueue.length) {
          onClose();
        }
        onSyncStore();

        if (isLocalFile) {
          Alert.alert(
            '已移除',
            `「${track.title}」已移出播放列表。本地导入的文件未删除，可在「我的 > 本地音乐」中管理。`,
          );
          return;
        }

        const musicId = String(track.id || track.songmid || track.hash || '').trim();
        if (!musicId) {
          Alert.alert('已移除', `「${track.title}」已移出播放列表（未找到可清理的缓存标识）。`);
          return;
        }

        await clearTrackCacheById(musicId);
        Alert.alert(
          '已移除并清理缓存',
          `「${track.title}」已移出播放列表，本地音频缓存与播放地址缓存已删除，下次播放将重新在线获取。`,
        );
      } catch (error) {
        console.error('Remove queue track and cache error:', error);
        Alert.alert('操作失败', '移除或清理缓存失败，请稍后重试。');
      }
    },
    [onClose, onSyncStore],
  );

  const handleQueueTrackMorePress = useCallback(
    (track: Track) => {
      Alert.alert(
        '队列操作',
        `${track.title} · ${track.artist}`,
        [
          {
            text: '添加到歌单',
            onPress: () => {
              handleAddQueueTrackToPlaylist(track);
            },
          },
          {
            text: '移除播放列表',
            style: 'destructive',
            onPress: () => {
              void handleRemoveQueueTrack(track);
            },
          },
          {
            text: '移除播放列表与缓存',
            style: 'destructive',
            onPress: () => {
              void handleRemoveQueueTrackAndCache(track);
            },
          },
          { text: '取消', style: 'cancel' },
        ],
      );
    },
    [handleAddQueueTrackToPlaylist, handleRemoveQueueTrack, handleRemoveQueueTrackAndCache],
  );

  const handleClearQueue = useCallback(() => {
    if (!queueRenderData.length) {
      Alert.alert('播放列表为空', '当前没有可清空的歌曲。');
      return;
    }
    Alert.alert(
      '清空播放列表',
      '清空后将停止播放，并移除当前队列中的全部歌曲。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清空',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await playerController.clearQueue();
                setQueueDraft([]);
                onSyncStore();
                closeQueueSheet();
              } catch (error) {
                console.error('Clear queue error:', error);
                Alert.alert('清空失败', '请稍后重试。');
              }
            })();
          },
        },
      ],
    );
  }, [closeQueueSheet, onSyncStore, queueRenderData.length]);

  const handleQueueTrackPress = useCallback(
    async (index: number) => {
      if (index < 0 || index >= queueRenderData.length) return;
      try {
        await playerController.playFromPlaylist(queueRenderData, index, {
          autoPlay: true,
        });
        onSyncStore();
        closeQueueSheet();
      } catch (error) {
        console.error('Play queue item error:', error);
        Alert.alert('播放失败', '切换到该歌曲失败，请稍后重试。');
      }
    },
    [closeQueueSheet, onSyncStore, queueRenderData],
  );

  /* ── 排序模式 ──
   *
   *   交互：
   *   - 默认态：列表正常显示，短按播放，长按无效（不触发拖动）
   *   - 点击 header 的 ≡ → 进入 isReorderMode：
   *     * 给定 reorderDraft = 当前队列快照
   *     * header 切成"取消 / 完成"
   *     * 行支持长按拖动（drag 只动 reorderDraft，不动控制器）
   *     * 行点击不触发播放
   *   - 完成：把 reorderDraft 与原 queue 比较，按差异调用 moveTrackInQueue 应用到底层
   *   - 取消：直接丢弃 reorderDraft，回默认态
   */
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [reorderDraft, setReorderDraft] = useState<Track[]>([]);

  const enterReorderMode = useCallback(() => {
    setReorderDraft(queueRenderData.slice());
    setIsReorderMode(true);
  }, [queueRenderData]);

  const cancelReorderMode = useCallback(() => {
    setIsReorderMode(false);
    setReorderDraft([]);
  }, []);

  const commitReorderMode = useCallback(() => {
    // 把 reorderDraft 一次应用到 controller 上：用最简单方式 —— 计算每首歌从原来的索引到新索引，
    // 调用底层 moveTrackInQueue。为了避免互相影响，我们重建一个 working copy 来跟踪移动。
    const working = queueRenderData.slice();
    const findIndexInWorking = (track: Track) => {
      const targetId = getTrackIdentity(track);
      return working.findIndex((t) => getTrackIdentity(t) === targetId);
    };
    for (let targetIdx = 0; targetIdx < reorderDraft.length; targetIdx += 1) {
      const draftTrack = reorderDraft[targetIdx];
      const fromIdx = findIndexInWorking(draftTrack);
      if (fromIdx < 0 || fromIdx === targetIdx) continue;
      playerController.moveTrackInQueue(fromIdx, targetIdx);
      // working 也同步移动，保持下一步的 fromIdx 计算正确
      const [moved] = working.splice(fromIdx, 1);
      working.splice(targetIdx, 0, moved);
    }
    setIsReorderMode(false);
    setReorderDraft([]);
    setQueueDraft(playerController.getPlaylist());
    onSyncStore();
  }, [getTrackIdentity, onSyncStore, queueRenderData, reorderDraft]);

  /* ── 拖动结束回调：仅在排序模式下使用，更新 reorderDraft 不动底层 ── */
  const handleDragEnd = useCallback(
    ({ data: nextData }: { data: Track[]; from: number; to: number }) => {
      setReorderDraft(nextData);
    },
    [],
  );

  /* ── 列表项渲染（DraggableFlatList 入参） ── */
  const renderQueueItem = useCallback(
    ({ item: track, getIndex, drag, isActive }: RenderItemParams<Track>) => {
      if (!track) return null;
      const idx = getIndex?.() ?? 0;
      const safeIndex = idx >= 0 ? idx : 0;
      const isCurrent = renderTrack
        ? getTrackIdentity(track) === getTrackIdentity(renderTrack)
        : false;

      return (
        <ScaleDecorator>
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => {
              if (isActive) return;
              if (isReorderMode) return; // 排序模式下不响应短按播放
              void handleQueueTrackPress(safeIndex);
            }}
            // 仅排序模式下整行长按可触发拖动；默认态不触发，避免误触。
            onLongPress={isReorderMode ? drag : undefined}
            delayLongPress={200}
            style={[
              styles.queueItem,
              {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: colors.separator,
                backgroundColor: isActive
                  ? (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)')
                  : isCurrent
                    ? isDark
                      ? 'rgba(10,132,255,0.16)'
                      : 'rgba(0,122,255,0.1)'
                    : isDark
                      ? 'rgba(255,255,255,0.04)'
                      : 'rgba(0,0,0,0.03)',
                ...(isActive && Platform.OS === 'ios' ? {
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 6 },
                  shadowOpacity: 0.25,
                  shadowRadius: 12,
                } : null),
              },
            ]}
          >
            <View style={styles.queueItemIndex}>
              <Text
                style={[
                  styles.queueIndexText,
                  { color: isCurrent ? colors.accent : colors.textTertiary },
                ]}
              >
                {safeIndex + 1}
              </Text>
            </View>
            <View style={styles.queueItemInfo}>
              <Text
                numberOfLines={1}
                style={[
                  styles.queueItemTitle,
                  { color: isCurrent ? colors.accent : colors.text },
                ]}
              >
                {track.title || '未知歌曲'}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.queueItemArtist, { color: colors.textSecondary }]}
              >
                {track.artist || '未知歌手'}
              </Text>
            </View>
            <View style={styles.queueItemActions}>
              {isCurrent && !isReorderMode && (
                <Ionicons
                  name={isPlaying ? 'volume-high' : 'pause'}
                  size={18}
                  color={colors.accent}
                />
              )}
              {isReorderMode ? (
                // 排序模式：右侧只显示一个明显的拖动把手，按住即可拖
                <Pressable
                  style={styles.queueDragHandle}
                  hitSlop={8}
                  onLongPress={drag}
                  delayLongPress={120}
                >
                  <Ionicons
                    name="reorder-three"
                    size={22}
                    color={colors.textSecondary}
                  />
                </Pressable>
              ) : (
                <Pressable
                  style={styles.queueMoreButton}
                  hitSlop={8}
                  onPress={(event) => {
                    event.stopPropagation?.();
                    handleQueueTrackMorePress(track);
                  }}
                >
                  <Ionicons
                    name="ellipsis-horizontal"
                    size={18}
                    color={colors.textSecondary}
                  />
                </Pressable>
              )}
            </View>
          </TouchableOpacity>
        </ScaleDecorator>
      );
    },
    [
      colors.accent,
      colors.separator,
      colors.text,
      colors.textSecondary,
      colors.textTertiary,
      getTrackIdentity,
      handleQueueTrackMorePress,
      handleQueueTrackPress,
      isDark,
      isPlaying,
      isReorderMode,
      renderTrack,
    ],
  );

  /* ── 动画插值 ── */
  const queueSheetMaskOpacity = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const queueSheetTranslateY = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [QUEUE_SHEET_HEIGHT + 24, 0],
  });

  /* ── 不可见时返回 null ── */
  if (!visible) return null;

  return (
    <View style={styles.queueSheetOverlay} pointerEvents="box-none">
      <Pressable
        style={[StyleSheet.absoluteFill, { zIndex: 1 }]}
        onPress={closeQueueSheet}
      >
        <Animated.View
          style={[
            styles.queueSheetMask,
            {
              opacity: queueSheetMaskOpacity,
            },
          ]}
        />
      </Pressable>
      <Animated.View
        style={[
          styles.queueSheet,
          {
            paddingBottom: insets.bottom + spacing.md,
            backgroundColor: isDark ? '#111317' : '#F8FAFD',
            borderColor: colors.separator,
            transform: [{ translateY: queueSheetTranslateY }],
            zIndex: 2,
          },
        ]}
      >
        <View style={styles.queueSheetHeader}>
          <Text style={[styles.queueSheetTitle, { color: colors.text }]}>
            {isReorderMode ? '排序模式' : '当前播放列表'}
          </Text>
          <View style={styles.queueSheetHeaderRight}>
            {isReorderMode ? (
              <>
                <TouchableOpacity
                  style={[
                    styles.queueHeaderTextAction,
                    {
                      borderColor: colors.separator,
                      backgroundColor: isDark
                        ? 'rgba(255,255,255,0.08)'
                        : 'rgba(0,0,0,0.04)',
                    },
                  ]}
                  activeOpacity={0.78}
                  onPress={cancelReorderMode}
                >
                  <Text style={[styles.queueHeaderActionText, { color: colors.textSecondary }]}>
                    取消
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.queueHeaderTextAction,
                    {
                      borderColor: colors.accent,
                      backgroundColor: colors.accent,
                    },
                  ]}
                  activeOpacity={0.78}
                  onPress={commitReorderMode}
                >
                  <Text style={[styles.queueHeaderActionText, { color: '#FFFFFF' }]}>
                    完成
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text
                  style={[
                    styles.queueSheetCount,
                    { color: colors.textSecondary },
                  ]}
                >
                  共 {queueDisplayCount} 首
                </Text>
                <TouchableOpacity
                  style={[
                    styles.queueHeaderAction,
                    {
                      borderColor: colors.separator,
                      backgroundColor: isDark
                        ? 'rgba(255,255,255,0.08)'
                        : 'rgba(0,0,0,0.04)',
                      opacity: queueDisplayCount > 1 ? 1 : 0.4,
                    },
                  ]}
                  activeOpacity={0.78}
                  disabled={queueDisplayCount <= 1}
                  onPress={enterReorderMode}
                >
                  <Ionicons
                    name="swap-vertical-outline"
                    size={16}
                    color={colors.textSecondary}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.queueHeaderAction,
                    {
                      borderColor: colors.separator,
                      backgroundColor: isDark
                        ? 'rgba(255,255,255,0.08)'
                        : 'rgba(0,0,0,0.04)',
                      opacity: queueDisplayCount > 0 ? 1 : 0.45,
                    },
                  ]}
                  activeOpacity={0.78}
                  disabled={queueDisplayCount <= 0}
                  onPress={handleClearQueue}
                >
                  <Ionicons
                    name="trash-outline"
                    size={15}
                    color={colors.textSecondary}
                  />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        <View style={styles.queueListGestureLayer}>
          {queueRenderData.length === 0 ? (
            <View style={styles.queueEmptyState}>
              <Text
                style={[
                  styles.queueEmptyText,
                  { color: colors.textSecondary },
                ]}
              >
                暂无可展示的歌曲
              </Text>
            </View>
          ) : (
            <DraggableFlatList
              ref={listRef}
              // 注意：DraggableFlatList 外层 wrapper 由 containerStyle 控制；
              // 只给 FlatList 的 style 不会让外层撑高 → 视觉上整个列表会空白。
              containerStyle={styles.queueSheetScroll}
              style={styles.queueSheetScroll}
              contentContainerStyle={styles.queueSheetList}
              data={isReorderMode ? reorderDraft : queueRenderData}
              // 注意：keyExtractor 必须 stable（不能拼 index），否则 DraggableFlatList
              // 在 reorder 时 key 跟着变 → React unmount/mount → lib 的 activeKey 失效
              // → 长按那瞬间会自动跟相邻行对调（症状："长按第 52 立刻跳到 53"）。
              keyExtractor={(track) => getTrackIdentity(track)}
              showsVerticalScrollIndicator={false}
              renderItem={renderQueueItem}
              onDragEnd={handleDragEnd}
              // 行高固定，给 getItemLayout 让 scrollToIndex 在大列表上稳定，
              // 不至于因为 measure 异步导致跳到当前歌时落空。
              getItemLayout={(_, index) => ({
                length: QUEUE_ITEM_HEIGHT,
                offset: QUEUE_ITEM_HEIGHT * index,
                index,
              })}
              onScrollToIndexFailed={(info) => {
                requestAnimationFrame(() => {
                  listRef.current?.scrollToOffset?.({
                    offset: QUEUE_ITEM_HEIGHT * info.index,
                    animated: false,
                  });
                });
              }}
              // 与歌单详情手感一致：长按触发后小幅滑动就开始跟随手指，整体响应自然。
              activationDistance={8}
              autoscrollThreshold={48}
            />
          )}
        </View>
      </Animated.View>
    </View>
  );
}

export default React.memo(QueueSheet);

const styles = StyleSheet.create({
  queueSheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    zIndex: 200,
  },
  queueSheetMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  queueSheet: {
    height: QUEUE_SHEET_HEIGHT,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.md,
  },
  queueSheetHeader: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  queueSheetHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  queueSheetTitle: {
    fontSize: fontSize.title3,
    fontWeight: '700',
  },
  queueSheetCount: {
    fontSize: fontSize.footnote,
  },
  queueHeaderAction: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueHeaderTextAction: {
    height: 28,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueHeaderActionText: {
    fontSize: fontSize.caption1,
    fontWeight: '600',
  },
  queueSheetScroll: {
    flex: 1,
  },
  queueSheetList: {
    paddingBottom: spacing.sm,
    flexGrow: 1,
  },
  queueListGestureLayer: {
    flex: 1,
    minHeight: QUEUE_ITEM_HEIGHT + spacing.md,
  },
  queueEmptyState: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  queueEmptyText: {
    fontSize: fontSize.callout,
  },
  queueItem: {
    height: QUEUE_ITEM_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  queueItemIndex: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  queueIndexText: {
    fontSize: fontSize.caption1,
    fontWeight: '600',
  },
  queueItemInfo: {
    flex: 1,
  },
  queueItemTitle: {
    fontSize: fontSize.callout,
    fontWeight: '600',
  },
  queueItemArtist: {
    fontSize: fontSize.caption1,
    marginTop: 2,
  },
  queueItemActions: {
    minWidth: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  queueMoreButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueDragHandle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
