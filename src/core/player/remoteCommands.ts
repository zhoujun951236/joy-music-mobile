/**
 * 桥接 iOS 锁屏 / 控制中心 / 蓝牙耳机的远程控制事件。
 * 监听原生模块发出的下一曲 / 上一曲 / 播放 / 暂停事件，调用 playerController。
 */

import { NativeEventEmitter, NativeModules, Platform } from 'react-native'
import { playerController } from './controller'
import type { Track } from '../../types/music'

interface JoyRemoteCommandsModule {
  activate: () => Promise<void>
  setNowPlaying: (info: {
    title?: string
    artist?: string
    album?: string
    duration?: number
    position?: number
    rate?: number
  }) => Promise<void>
}

const nativeModule = (NativeModules.JoyRemoteCommands as JoyRemoteCommandsModule | undefined)
let installed = false
let unsubscribers: Array<() => void> = []

function getEmitter(): NativeEventEmitter | null {
  if (!nativeModule) return null
  return new NativeEventEmitter(NativeModules.JoyRemoteCommands as any)
}

/**
 * 安装远程控制事件订阅。仅 iOS 生效；其他平台或原生模块缺失时静默跳过。
 */
export function installRemoteCommandHandlers(): void {
  if (installed) return
  if (Platform.OS !== 'ios') return
  if (!nativeModule) {
    console.warn('[RemoteCommands] Native module JoyRemoteCommands not found, skipping')
    return
  }

  installed = true

  void nativeModule.activate().catch((error) => {
    console.warn('[RemoteCommands] activate failed:', error)
  })

  const emitter = getEmitter()
  if (!emitter) return

  const safe = (label: string, action: () => Promise<void> | void) => async() => {
    try {
      await action()
    } catch (error) {
      console.warn(`[RemoteCommands] ${label} handler failed:`, error)
    }
  }

  // 只订阅 next / previous —— expo-audio 内置 MediaController 没注册这两个。
  // play / pause / togglePlayPause 完全交给 expo-audio，避免双重注册让 iOS
  // 判定不出唯一的 Now Playing App。
  const subs = [
    emitter.addListener('RemoteNextTrack', safe('next', () => playerController.playNext())),
    emitter.addListener('RemotePreviousTrack', safe('previous', () => playerController.playPrevious())),
  ]

  unsubscribers = subs.map((s) => () => s.remove())
}

/**
 * 同步当前歌曲与播放进度到 iOS Now Playing Info Center。
 * 锁屏与控制中心会展示这些信息。
 */
export function pushNowPlayingInfo(track: Track | null, positionMillis: number, durationMillis: number, isPlaying: boolean): void {
  if (Platform.OS !== 'ios' || !nativeModule || !track) return
  void nativeModule.setNowPlaying({
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: durationMillis > 0 ? durationMillis / 1000 : undefined,
    position: positionMillis > 0 ? positionMillis / 1000 : 0,
    rate: isPlaying ? 1 : 0,
  }).catch(() => {})
}

export function uninstallRemoteCommandHandlers(): void {
  unsubscribers.forEach((fn) => {
    try { fn() } catch {}
  })
  unsubscribers = []
  installed = false
}
