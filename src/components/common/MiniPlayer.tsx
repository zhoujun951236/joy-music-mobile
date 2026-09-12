/**
 * 底部 Mini 播放条。
 * 横向布局：封面 + 歌名/作者 + 中间歌词 + 播放控制，底部可拖动进度条。
 *
 * 性能拆分：
 * - 外壳（BlurView/LinearGradient 等高代价视觉层）只依赖 track + isPlaying，
 *   切歌或暂停/继续时才重渲染。
 * - 高频更新（进度条 + 当前歌词行）单独以 LyricTicker / SeekBar 两个独立子组件
 *   订阅 playerController 的 onStatusUpdate，setState 仅作用于自身，
 *   避免外壳每 500ms 一次 reconciliation。
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Image,
  Animated,
  Platform,
  Text,
  type LayoutChangeEvent,
} from 'react-native'
import Slider from '@react-native-community/slider'
import { Ionicons } from '@expo/vector-icons'
import { BlurView } from 'expo-blur'
import { LinearGradient } from 'expo-linear-gradient'
import { useSelector } from 'react-redux'
import { useTheme, MINI_PLAYER_HEIGHT, fontSize } from '../../theme'
import { usePlayerTrack } from '../../hooks/usePlayerStatus'
import { playerController } from '../../core/player'
import { getLyric, findCurrentLineIndex, type LyricLine } from '../../core/lyric'
import type { RootState } from '../../store'

interface MiniPlayerProps {
  onOpenPlayer?: () => void
}

const COVER_SIZE = 44
const CONTROL_SIZE = 36
const SEEK_TRACK_HEIGHT = 5
const SEEK_TOUCH_HEIGHT = 18

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1)

interface LyricTickerProps {
  lyricLines: LyricLine[]
  lyricLoading: boolean
  accentColor: string
  textSecondaryColor: string
}

/** 歌词行 — 仅订阅 position，500ms 内部 setState，不重绘外壳。 */
const LyricTicker = memo(function LyricTicker({
  lyricLines,
  lyricLoading,
  accentColor,
  textSecondaryColor,
}: LyricTickerProps) {
  const [position, setPosition] = useState(0)

  useEffect(() => {
    let active = true
    void playerController.getPlaybackStatus().then((status) => {
      if (active && status) setPosition(status.positionMillis)
    })
    const unsubscribe = playerController.onStatusUpdate((status) => {
      if (active) setPosition(status.positionMillis)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const currentLyricIndex = findCurrentLineIndex(lyricLines, position)
  const currentLyricText = !lyricLines.length
    ? (lyricLoading ? '歌词加载中...' : '暂无歌词')
    : (currentLyricIndex < 0
      ? (lyricLines[0]?.text || '暂无歌词')
      : (lyricLines[currentLyricIndex]?.text || '暂无歌词'))
  const hasActiveLyric = lyricLines.length > 0 && currentLyricIndex >= 0

  return (
    <View style={styles.lyricWrap}>
      <Text
        numberOfLines={1}
        style={[
          styles.lyricText,
          { color: hasActiveLyric ? accentColor : textSecondaryColor },
        ]}
      >
        {currentLyricText}
      </Text>
    </View>
  )
})

interface SeekBarProps {
  trackKey: string
  isDark: boolean
  accentColor: string
}

/** 进度条 — 自订阅 position/duration，与外壳解耦。 */
const SeekBar = memo(function SeekBar({
  trackKey,
  isDark,
  accentColor,
}: SeekBarProps) {
  const [duration, setDuration] = useState(0)
  const [progress, setProgress] = useState(0)
  const [isSeeking, setIsSeeking] = useState(false)
  const [seekProgress, setSeekProgress] = useState(0)
  const [seekBarWidth, setSeekBarWidth] = useState(0)
  const isSeekingRef = useRef(false)

  useEffect(() => {
    let active = true
    void playerController.getPlaybackStatus().then((status) => {
      if (!active || !status) return
      setDuration(status.durationMillis)
      setProgress(status.durationMillis > 0
        ? status.positionMillis / status.durationMillis
        : 0)
    })
    const unsubscribe = playerController.onStatusUpdate((status) => {
      if (!active) return
      setDuration(status.durationMillis)
      if (!isSeekingRef.current) {
        setProgress(status.durationMillis > 0
          ? status.positionMillis / status.durationMillis
          : 0)
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    isSeekingRef.current = false
    setIsSeeking(false)
    setSeekProgress(0)
  }, [trackKey])

  const handleSeekLayout = useCallback((event: LayoutChangeEvent) => {
    setSeekBarWidth(event.nativeEvent.layout.width)
  }, [])

  const handleSeekStart = useCallback((value: number) => {
    const nextProgress = clamp01(value)
    isSeekingRef.current = true
    setIsSeeking(true)
    setSeekProgress(nextProgress)
  }, [])

  const handleSeekChange = useCallback((value: number) => {
    setSeekProgress(clamp01(value))
  }, [])

  const handleSeekComplete = useCallback((value: number) => {
    const nextProgress = clamp01(value)
    setSeekProgress(nextProgress)
    isSeekingRef.current = false
    setIsSeeking(false)
    if (duration > 0) {
      void playerController.seek(Math.floor(duration * nextProgress))
    }
  }, [duration])

  const activeProgress = isSeeking ? seekProgress : clamp01(progress)
  const thumbSize = isSeeking ? 10 : 8
  const trackTop = (SEEK_TOUCH_HEIGHT - SEEK_TRACK_HEIGHT) / 2
  const thumbTop = trackTop + (SEEK_TRACK_HEIGHT - thumbSize) / 2
  const thumbOffset = seekBarWidth > 0
    ? Math.max(
      0,
      Math.min(
        seekBarWidth - thumbSize,
        activeProgress * seekBarWidth - thumbSize / 2
      )
    )
    : 0

  return (
    <View style={styles.seekWrap}>
      <View style={styles.seekTouchArea} onLayout={handleSeekLayout}>
        <View
          style={[
            styles.seekTrack,
            { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)' },
          ]}
        />
        <View
          style={[
            styles.seekFill,
            {
              backgroundColor: accentColor,
              width: `${activeProgress * 100}%`,
            },
          ]}
        />
        <View
          pointerEvents="none"
          style={[
            styles.seekThumb,
            {
              width: thumbSize,
              height: thumbSize,
              borderRadius: thumbSize / 2,
              left: thumbOffset,
              top: thumbTop,
              backgroundColor: '#FFFFFF',
              borderColor: 'rgba(0,0,0,0.1)',
              opacity: isSeeking ? 1 : 0.9,
              transform: [{ scale: isSeeking ? 1.06 : 1 }],
            },
          ]}
        />
        <Slider
          style={styles.seekNativeSlider}
          minimumValue={0}
          maximumValue={1}
          step={0}
          value={activeProgress}
          onSlidingStart={handleSeekStart}
          onValueChange={handleSeekChange}
          onSlidingComplete={handleSeekComplete}
          minimumTrackTintColor="transparent"
          maximumTrackTintColor="transparent"
          thumbTintColor="transparent"
        />
      </View>
    </View>
  )
})

/**
 * 渲染底部条形 Mini 播放器。
 * 融合沉浸式液态玻璃质感的设计。
 * @param onOpenPlayer - 点击打开全屏播放器的回调
 */
export default function MiniPlayer({ onOpenPlayer }: MiniPlayerProps) {
  const { colors, isDark } = useTheme()
  // 优先用 Redux 里的 currentTrack —— 启动时 restoreSession 会把 controller 状态同步到 Redux，
  // 所以即便没开始播放，只要队列里有歌，Mini 播放栏就能持续显示，不会因为没 status 推送而消失。
  const reduxCurrentTrack = useSelector((state: RootState) => state.player.currentTrack)
  const { isPlaying, currentTrack: liveCurrentTrack } = usePlayerTrack()
  const currentTrack = liveCurrentTrack || reduxCurrentTrack

  const entryAnim = useRef(new Animated.Value(currentTrack ? 1 : 0)).current
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([])
  const [lyricLoading, setLyricLoading] = useState(false)
  const lyricTrackKey = currentTrack
    ? `${currentTrack.source || 'kw'}_${currentTrack.songmid || currentTrack.id}`
    : ''

  useEffect(() => {
    Animated.spring(entryAnim, {
      toValue: currentTrack ? 1 : 0,
      useNativeDriver: true,
      tension: 180,
      friction: 18,
    }).start()
  }, [currentTrack, entryAnim])

  useEffect(() => {
    if (!currentTrack) {
      setLyricLines([])
      setLyricLoading(false)
      return
    }

    let active = true
    setLyricLoading(true)
    setLyricLines([])

    void getLyric(currentTrack)
      .then((data) => {
        if (!active) return
        setLyricLines(data.lines || [])
      })
      .catch(() => {
        if (!active) return
        setLyricLines([])
      })
      .finally(() => {
        if (!active) return
        setLyricLoading(false)
      })

    return () => {
      active = false
    }
  }, [lyricTrackKey])

  const handleOpen = useCallback(() => {
    onOpenPlayer?.()
  }, [onOpenPlayer])

  const handlePlayPause = useCallback(async () => {
    try {
      if (isPlaying) {
        await playerController.pause()
      } else {
        await playerController.resume()
      }
    } catch (e) {
      console.error('MiniPlayer play/pause error:', e)
    }
  }, [isPlaying])

  const artistInfo = useMemo(() => {
    if (!currentTrack) return ''
    return currentTrack.source
      ? `${currentTrack.artist} · ${currentTrack.source.toUpperCase()}`
      : currentTrack.artist
  }, [currentTrack])

  if (!currentTrack) return null

  return (
    <Animated.View
      style={[
        styles.positioner,
        {
          opacity: entryAnim,
          transform: [
            {
              translateY: entryAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [24, 0],
              }),
            },
          ],
        },
      ]}
    >
      <View style={styles.shadowLayer}>
        <View style={styles.container}>
          {/* —— 沉浸式玻璃底层 —— */}
          <BlurView
            intensity={isDark ? 55 : 85}
            tint={isDark ? 'dark' : 'light'}
            style={styles.absoluteFill}
          />

          {/* —— 半透明底色，减少过杂的透底 —— */}
          <View
            style={[
              styles.absoluteFill,
              { backgroundColor: isDark ? 'rgba(28,28,30,0.65)' : 'rgba(255,255,255,0.7)' },
            ]}
          />

          {/* —— 高光层，顶部加强反射 —— */}
          <LinearGradient
            colors={
              isDark
                ? ['rgba(255,255,255,0.1)', 'rgba(255,255,255,0)']
                : ['rgba(255,255,255,0.8)', 'rgba(255,255,255,0.1)']
            }
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={styles.absoluteFill}
            pointerEvents="none"
          />

          {/* —— 内发光边框 —— */}
          <View
            style={[
              styles.innerBorder,
              { borderColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.6)' },
            ]}
            pointerEvents="none"
          />

          {/* —— 主内容区域 —— */}
          <View style={styles.row}>
            <TouchableOpacity
              style={styles.mainArea}
              activeOpacity={0.8}
              onPress={handleOpen}
            >
              <View
                style={[
                  styles.cover,
                  { backgroundColor: colors.surfaceSecondary },
                ]}
              >
                {currentTrack.coverUrl ? (
                  <Image source={{ uri: currentTrack.coverUrl }} style={styles.coverImage} />
                ) : (
                  <Ionicons name="musical-note" size={20} color={colors.textTertiary} />
                )}
              </View>
              <View style={styles.trackMeta}>
                <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
                  {currentTrack.title}
                </Text>
                <Text numberOfLines={1} style={[styles.artist, { color: colors.textSecondary }]}>
                  {artistInfo}
                </Text>
              </View>
              <LyricTicker
                lyricLines={lyricLines}
                lyricLoading={lyricLoading}
                accentColor={colors.accent}
                textSecondaryColor={colors.textSecondary}
              />
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.controlButton,
                {
                  backgroundColor: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.06)',
                },
              ]}
              onPress={handlePlayPause}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isPlaying ? 'pause' : 'play'}
                size={18}
                color={colors.text}
              />
            </TouchableOpacity>
          </View>

          <SeekBar
            trackKey={lyricTrackKey}
            isDark={isDark}
            accentColor={colors.accent}
          />
        </View>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  positioner: {
    width: '100%',
  },
  shadowLayer: {
    borderRadius: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.15,
        shadowRadius: 16,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  container: {
    height: MINI_PLAYER_HEIGHT,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  absoluteFill: {
    ...StyleSheet.absoluteFillObject,
  },
  innerBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 20,
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    zIndex: 1,
  },
  mainArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  cover: {
    width: COVER_SIZE,
    height: COVER_SIZE,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  coverImage: {
    width: COVER_SIZE,
    height: COVER_SIZE,
  },
  trackMeta: {
    width: 118,
    marginLeft: 10,
    justifyContent: 'center',
  },
  title: {
    fontSize: fontSize.subhead,
    fontWeight: '700',
    lineHeight: 18,
  },
  artist: {
    marginTop: 2,
    fontSize: fontSize.caption1,
    fontWeight: '500',
    lineHeight: 14,
  },
  lyricWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  lyricText: {
    fontSize: fontSize.caption1 - 1,
    fontWeight: '600',
    textAlign: 'center',
  },
  controlButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: CONTROL_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seekWrap: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: -6,
    zIndex: 2,
  },
  seekTouchArea: {
    height: SEEK_TOUCH_HEIGHT,
    justifyContent: 'center',
  },
  seekNativeSlider: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: SEEK_TOUCH_HEIGHT,
    opacity: 0.02,
  },
  seekTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: (SEEK_TOUCH_HEIGHT - SEEK_TRACK_HEIGHT) / 2,
    height: SEEK_TRACK_HEIGHT,
    borderRadius: 9999,
    overflow: 'visible',
  },
  seekFill: {
    position: 'absolute',
    left: 0,
    top: (SEEK_TOUCH_HEIGHT - SEEK_TRACK_HEIGHT) / 2,
    height: SEEK_TRACK_HEIGHT,
    borderRadius: 9999,
  },
  seekThumb: {
    position: 'absolute',
    borderWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.25,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
})
