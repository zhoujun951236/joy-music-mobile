/**
 * Expo Audio based music player implementation.
 * Keeps the original public interface to avoid touching controller callers.
 */

import { AudioPlayer, createAudioPlayer, setAudioModeAsync } from 'expo-audio'
import { AppState, type AppStateStatus, Platform } from 'react-native'
import { Track } from '../../types/music'

export interface PlayerConfig {
  volume?: number
  playbackRate?: number
  shouldPlay?: boolean
}

export interface PlaybackStatus {
  isLoaded: boolean
  isPlaying: boolean
  didJustFinish: boolean
  durationMillis: number
  positionMillis: number
  rate: number
  volume: number
}

class ExpoAudioPlayerWrapper {
  private player: AudioPlayer | null = null
  private isInitialized = false
  private currentTrack: Track | null = null
  private statusUpdateCallback: ((status: PlaybackStatus) => void) | null = null
  private statusSubscription: { remove: () => void } | null = null
  private appStateSubscription: { remove: () => void } | null = null
  // 后台节流：息屏 / App 进入后台时只放过结构变化的事件（isPlaying/duration/didJustFinish），
  // 高频 position-only 推送会被丢弃，避免 JS 线程被 250-500ms 一次的回调持续唤醒导致发热。
  private isInBackground = false
  private lastEmittedIsPlaying = false
  private lastEmittedDurationMillis = 0

  async initialize(): Promise<void> {
    if (this.isInitialized) return
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
      shouldRouteThroughEarpiece: false,
    })
    this.installAppStateListener()
    this.isInitialized = true
    console.log('[ExpoAudioPlayer] Initialized')
  }

  private installAppStateListener(): void {
    if (this.appStateSubscription) return
    this.isInBackground = AppState.currentState !== 'active'
    this.appStateSubscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      const wasBackground = this.isInBackground
      this.isInBackground = next !== 'active'
      // 回到前台时主动推送一次最新状态，让 UI 立即同步进度。
      if (wasBackground && !this.isInBackground) {
        const player = this.player
        if (player) {
          this.handlePlaybackStatusUpdate(player.currentStatus)
        }
      }
    })
  }

  async play(track: Track, url: string, config?: PlayerConfig): Promise<void> {
    if (!this.isInitialized) await this.initialize()

    if (!this.player) {
      // updateInterval 决定状态回调频率，500ms 已足够 UI 进度平滑，
      // 同时减半 JS<->Native 桥接调用以降低 CPU 占用与发热。
      this.player = createAudioPlayer(
        { uri: url },
        { updateInterval: 500, keepAudioSessionActive: true }
      )
      this.statusSubscription = this.player.addListener('playbackStatusUpdate', (status) => {
        this.handlePlaybackStatusUpdate(status)
      })
    } else {
      this.player.replace({ uri: url })
    }

    this.player.volume = Math.max(0, Math.min(1, config?.volume ?? 1))
    this.player.setPlaybackRate(config?.playbackRate ?? 1, 'high')
    this.currentTrack = track
    this.updateLockScreen(track)

    if (config?.shouldPlay ?? true) {
      this.player.play()
    }
  }

  async pause(): Promise<void> {
    if (!this.player) return
    this.player.pause()
  }

  async resume(): Promise<void> {
    if (!this.player) return
    this.player.play()
  }

  async stop(): Promise<void> {
    if (!this.player) return
    try {
      this.player.pause()
      await this.player.seekTo(0)
      this.clearLockScreen()
    } finally {
      this.statusSubscription?.remove()
      this.statusSubscription = null
      this.player.remove()
      this.player = null
      this.currentTrack = null
    }
  }

  async seek(positionMillis: number): Promise<void> {
    if (!this.player) return
    await this.player.seekTo(Math.max(0, positionMillis) / 1000)
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.player) return
    this.player.volume = Math.max(0, Math.min(1, volume))
  }

  async setRate(rate: number): Promise<void> {
    if (!this.player) return
    this.player.setPlaybackRate(rate, 'high')
  }

  async getStatus(): Promise<PlaybackStatus | null> {
    if (!this.player) return null
    const s = this.player.currentStatus
    return {
      isLoaded: s.isLoaded,
      isPlaying: s.playing,
      didJustFinish: s.didJustFinish ?? false,
      durationMillis: Math.max(0, Math.round((s.duration || 0) * 1000)),
      positionMillis: Math.max(0, Math.round((s.currentTime || 0) * 1000)),
      rate: s.playbackRate ?? 1,
      volume: this.player.volume ?? 1,
    }
  }

  setStatusCallback(callback: (status: PlaybackStatus) => void): void {
    this.statusUpdateCallback = callback
  }

  getCurrentTrack(): Track | null {
    return this.currentTrack
  }

  private handlePlaybackStatusUpdate(status: any): void {
    const payload: PlaybackStatus = {
      isLoaded: !!status?.isLoaded,
      isPlaying: !!status?.playing,
      didJustFinish: !!status?.didJustFinish,
      durationMillis: Math.max(0, Math.round((status?.duration || 0) * 1000)),
      positionMillis: Math.max(0, Math.round((status?.currentTime || 0) * 1000)),
      rate: status?.playbackRate ?? 1,
      volume: this.player?.volume ?? 1,
    }

    // 后台时仅放过"结构变化"事件：isPlaying / duration 改变 / 自然播完。
    // 纯 position 变化（息屏听歌的常态）不再唤醒 JS 链路。
    if (this.isInBackground) {
      const structuralChange = payload.didJustFinish
        || payload.isPlaying !== this.lastEmittedIsPlaying
        || payload.durationMillis !== this.lastEmittedDurationMillis
      if (!structuralChange) return
    }

    this.lastEmittedIsPlaying = payload.isPlaying
    this.lastEmittedDurationMillis = payload.durationMillis
    this.statusUpdateCallback?.(payload)
  }

  private updateLockScreen(track: Track): void {
    if (!this.player || Platform.OS !== 'ios') return
    const playerWithLockScreen = this.player as AudioPlayer & {
      setActiveForLockScreen?: (
        active: boolean,
        metadata: {
          title: string
          artist: string
          albumTitle: string
          artworkUrl: string
        },
        controls: {
          showSeekBackward: boolean
          showSeekForward: boolean
        }
      ) => void
    }
    if (typeof playerWithLockScreen.setActiveForLockScreen !== 'function') {
      return
    }
    try {
      playerWithLockScreen.setActiveForLockScreen(
        true,
        {
          title: track.title,
          artist: track.artist,
          albumTitle: track.album || '',
          artworkUrl: track.coverUrl || '',
        },
        {
          showSeekBackward: true,
          showSeekForward: true,
        }
      )
    } catch (error) {
      console.warn('[ExpoAudioPlayer] Failed to set lock screen metadata:', error)
    }
  }

  private clearLockScreen(): void {
    if (!this.player || Platform.OS !== 'ios') return
    const playerWithLockScreen = this.player as AudioPlayer & {
      clearLockScreenControls?: () => void
    }
    if (typeof playerWithLockScreen.clearLockScreenControls !== 'function') {
      return
    }
    try {
      playerWithLockScreen.clearLockScreenControls()
    } catch (error) {
      console.warn('[ExpoAudioPlayer] Failed to clear lock screen controls:', error)
    }
  }

  isLoaded(): boolean {
    return !!this.player && !!this.player.isLoaded
  }
}

export const expoAVPlayer = new ExpoAudioPlayerWrapper()
