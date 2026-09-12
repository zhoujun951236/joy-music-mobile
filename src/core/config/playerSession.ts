import AsyncStorage from '@react-native-async-storage/async-storage'
import { Track } from '../../types/music'

const PLAYER_SESSION_KEY = '@joy_player_session_v1'

export interface PlayerSessionSnapshot {
  playlist: Track[]
  currentIndex: number
  repeatMode: 'off' | 'all' | 'one'
  shuffleMode: boolean
  positionMillis: number
}

const DEFAULT_SESSION: PlayerSessionSnapshot = {
  playlist: [],
  currentIndex: -1,
  repeatMode: 'all',
  shuffleMode: false,
  positionMillis: 0,
}

let cache: PlayerSessionSnapshot | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function normalizeTrack(input: any, index: number): Track | null {
  if (!input || typeof input !== 'object') return null
  const id = String(input.id || input.songmid || input.hash || `track_${index}`)
  if (!id) return null
  return {
    id,
    title: String(input.title || '未知歌曲'),
    artist: String(input.artist || '未知歌手'),
    album: input.album ? String(input.album) : undefined,
    duration: Number(input.duration || 0),
    url: String(input.url || ''),
    coverUrl: input.coverUrl ? String(input.coverUrl) : undefined,
    source: input.source ? String(input.source) : undefined,
    songmid: input.songmid ? String(input.songmid) : undefined,
    copyrightId: input.copyrightId ? String(input.copyrightId) : undefined,
    hash: input.hash ? String(input.hash) : undefined,
    picUrl: input.picUrl ? String(input.picUrl) : undefined,
  }
}

function sanitize(raw: any): PlayerSessionSnapshot {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SESSION }
  const playlistRaw = Array.isArray(raw.playlist) ? raw.playlist : []
  const playlist = playlistRaw
    .map((track: any, index: number) => normalizeTrack(track, index))
    .filter(Boolean) as Track[]
  const repeatMode = raw.repeatMode === 'off' || raw.repeatMode === 'one' ? raw.repeatMode : 'all'
  let currentIndex = Number.isFinite(raw.currentIndex) ? Number(raw.currentIndex) : -1
  if (currentIndex < 0 || currentIndex >= playlist.length) {
    currentIndex = playlist.length ? 0 : -1
  }
  const positionMillis = Math.max(0, Number(raw.positionMillis) || 0)
  return {
    playlist,
    currentIndex,
    repeatMode,
    shuffleMode: !!raw.shuffleMode,
    positionMillis,
  }
}

export async function loadPlayerSession(): Promise<PlayerSessionSnapshot> {
  if (cache) return cache
  try {
    const raw = await AsyncStorage.getItem(PLAYER_SESSION_KEY)
    if (!raw) {
      cache = { ...DEFAULT_SESSION }
      return cache
    }
    cache = sanitize(JSON.parse(raw))
    return cache
  } catch {
    cache = { ...DEFAULT_SESSION }
    return cache
  }
}

export function savePlayerSession(snapshot: PlayerSessionSnapshot): void {
  cache = sanitize(snapshot)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void AsyncStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(cache)).catch(() => {})
  }, 600)
}

export function flushPlayerSession(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!cache) return Promise.resolve()
  return AsyncStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(cache)).catch(() => {})
}

export async function clearPlayerSession(): Promise<void> {
  cache = { ...DEFAULT_SESSION }
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await AsyncStorage.removeItem(PLAYER_SESSION_KEY).catch(() => {})
}
