import * as SQLite from 'expo-sqlite'

const CACHE_DB_NAME = 'joy_music_cache.db'
const URL_CACHE_TABLE = 'music_url_cache'
const LYRIC_CACHE_TABLE = 'music_lyric_cache'
const AUDIO_SETTINGS_TABLE = 'audio_cache_settings'
const AUDIO_INDEX_TABLE = 'audio_cache_index'
const LOCAL_MUSIC_TABLE = 'local_music_index'

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null

/**
 * 给已存在的表补列：CREATE TABLE IF NOT EXISTS 对老库不会加新列，
 * 所以逐列 PRAGMA 检查后 ALTER TABLE，兼容已经导入过歌曲的旧安装。
 */
async function ensureColumns(
  db: SQLite.SQLiteDatabase,
  table: string,
  columns: Array<[string, string]>
): Promise<void> {
  try {
    const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)
    const existing = new Set(rows.map((row) => row.name))
    for (const [name, type] of columns) {
      if (existing.has(name)) continue
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
    }
  } catch (error) {
    console.warn(`[CacheSqlite] ensureColumns failed for ${table}:`, error)
  }
}

async function initializeDatabase(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS ${URL_CACHE_TABLE} (
      cache_key TEXT PRIMARY KEY NOT NULL,
      music_id TEXT NOT NULL,
      quality TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${URL_CACHE_TABLE}_music_id
      ON ${URL_CACHE_TABLE}(music_id);

    CREATE TABLE IF NOT EXISTS ${LYRIC_CACHE_TABLE} (
      music_id TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${AUDIO_SETTINGS_TABLE} (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      enabled INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${AUDIO_INDEX_TABLE} (
      music_id TEXT PRIMARY KEY NOT NULL,
      file_uri TEXT NOT NULL,
      quality TEXT NOT NULL,
      source TEXT NOT NULL,
      size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title TEXT,
      artist TEXT
    );

    CREATE TABLE IF NOT EXISTS ${LOCAL_MUSIC_TABLE} (
      id TEXT PRIMARY KEY NOT NULL,
      file_uri TEXT NOT NULL,
      file_name TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      size INTEGER NOT NULL,
      format TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      cover_url TEXT,
      online_id TEXT,
      online_source TEXT,
      songmid TEXT
    );
  `)

  // 老版本已经建过 local_music_index 的，用 ALTER 补上新列
  await ensureColumns(db, LOCAL_MUSIC_TABLE, [
    ['cover_url', 'TEXT'],
    ['online_id', 'TEXT'],
    ['online_source', 'TEXT'],
    ['songmid', 'TEXT'],
  ])
}

async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async() => {
      const db = await SQLite.openDatabaseAsync(CACHE_DB_NAME)
      await initializeDatabase(db)
      return db
    })()
  }
  return dbPromise
}

export interface UrlCacheRecord {
  cacheKey: string
  musicId: string
  quality: string
  url: string
  source: string
  timestamp: number
  ttlMs: number
}

interface UrlCacheRow {
  cache_key: string
  music_id: string
  quality: string
  url: string
  source: string
  timestamp: number
  ttl_ms: number
}

export async function saveUrlCacheRecord(record: UrlCacheRecord): Promise<void> {
  const db = await getDatabase()
  await db.runAsync(
    `
      INSERT OR REPLACE INTO ${URL_CACHE_TABLE}
      (cache_key, music_id, quality, url, source, timestamp, ttl_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    record.cacheKey,
    record.musicId,
    record.quality,
    record.url,
    record.source,
    record.timestamp,
    record.ttlMs
  )
}

export async function getUrlCacheRecord(cacheKey: string): Promise<UrlCacheRecord | null> {
  const db = await getDatabase()
  const row = await db.getFirstAsync<UrlCacheRow>(
    `
      SELECT cache_key, music_id, quality, url, source, timestamp, ttl_ms
      FROM ${URL_CACHE_TABLE}
      WHERE cache_key = ?
      LIMIT 1
    `,
    cacheKey
  )

  if (!row) return null
  return {
    cacheKey: row.cache_key,
    musicId: row.music_id,
    quality: row.quality,
    url: row.url,
    source: row.source,
    timestamp: Number(row.timestamp || 0),
    ttlMs: Number(row.ttl_ms || 0),
  }
}

export async function removeUrlCacheRecord(cacheKey: string): Promise<void> {
  const db = await getDatabase()
  await db.runAsync(
    `DELETE FROM ${URL_CACHE_TABLE} WHERE cache_key = ?`,
    cacheKey
  )
}

export async function removeUrlCacheByMusicId(musicId: string): Promise<void> {
  const db = await getDatabase()
  await db.runAsync(
    `DELETE FROM ${URL_CACHE_TABLE} WHERE music_id = ?`,
    musicId
  )
}

export async function clearUrlCacheRecords(): Promise<void> {
  const db = await getDatabase()
  await db.execAsync(`DELETE FROM ${URL_CACHE_TABLE}`)
}

interface LyricCacheRow {
  payload: string
}

export async function saveLyricCacheRecord(
  musicId: string,
  payload: string
): Promise<void> {
  const db = await getDatabase()
  await db.runAsync(
    `
      INSERT OR REPLACE INTO ${LYRIC_CACHE_TABLE}
      (music_id, payload, updated_at)
      VALUES (?, ?, ?)
    `,
    musicId,
    payload,
    Date.now()
  )
}

export async function getLyricCacheRecord(musicId: string): Promise<string | null> {
  const db = await getDatabase()
  const row = await db.getFirstAsync<LyricCacheRow>(
    `
      SELECT payload
      FROM ${LYRIC_CACHE_TABLE}
      WHERE music_id = ?
      LIMIT 1
    `,
    musicId
  )
  return row?.payload ?? null
}

export async function removeLyricCacheRecord(musicId: string): Promise<void> {
  const db = await getDatabase()
  await db.runAsync(
    `DELETE FROM ${LYRIC_CACHE_TABLE} WHERE music_id = ?`,
    musicId
  )
}

export async function clearLyricCacheRecords(): Promise<void> {
  const db = await getDatabase()
  await db.execAsync(`DELETE FROM ${LYRIC_CACHE_TABLE}`)
}

interface AudioSettingsRow {
  enabled: number
}

export async function getAudioCacheEnabledSetting(): Promise<boolean | null> {
  const db = await getDatabase()
  const row = await db.getFirstAsync<AudioSettingsRow>(
    `
      SELECT enabled
      FROM ${AUDIO_SETTINGS_TABLE}
      WHERE id = 1
      LIMIT 1
    `
  )
  if (!row) return null
  return Number(row.enabled) !== 0
}

export async function saveAudioCacheEnabledSetting(enabled: boolean): Promise<void> {
  const db = await getDatabase()
  await db.runAsync(
    `
      INSERT OR REPLACE INTO ${AUDIO_SETTINGS_TABLE}
      (id, enabled)
      VALUES (1, ?)
    `,
    enabled ? 1 : 0
  )
}

export interface AudioCacheIndexRecord {
  musicId: string
  fileUri: string
  quality: string
  source: string
  size: number
  updatedAt: number
  title?: string
  artist?: string
}

interface AudioCacheIndexRow {
  music_id: string
  file_uri: string
  quality: string
  source: string
  size: number
  updated_at: number
  title: string | null
  artist: string | null
}

export async function loadAudioCacheIndexRecords(): Promise<AudioCacheIndexRecord[]> {
  const db = await getDatabase()
  const rows = await db.getAllAsync<AudioCacheIndexRow>(
    `
      SELECT music_id, file_uri, quality, source, size, updated_at, title, artist
      FROM ${AUDIO_INDEX_TABLE}
    `
  )
  return rows.map((row) => ({
    musicId: row.music_id,
    fileUri: row.file_uri,
    quality: row.quality,
    source: row.source,
    size: Number(row.size || 0),
    updatedAt: Number(row.updated_at || 0),
    title: row.title || undefined,
    artist: row.artist || undefined,
  }))
}

export async function replaceAudioCacheIndexRecords(
  records: AudioCacheIndexRecord[]
): Promise<void> {
  const db = await getDatabase()
  await db.execAsync('BEGIN IMMEDIATE TRANSACTION')
  try {
    await db.execAsync(`DELETE FROM ${AUDIO_INDEX_TABLE}`)
    for (const record of records) {
      await db.runAsync(
        `
          INSERT INTO ${AUDIO_INDEX_TABLE}
          (music_id, file_uri, quality, source, size, updated_at, title, artist)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        record.musicId,
        record.fileUri,
        record.quality,
        record.source,
        record.size,
        record.updatedAt,
        record.title || null,
        record.artist || null
      )
    }
    await db.execAsync('COMMIT')
  } catch (error) {
    await db.execAsync('ROLLBACK')
    throw error
  }
}

export interface LocalMusicRecord {
  id: string
  fileUri: string
  fileName: string
  title: string
  artist: string
  size: number
  format: string
  importedAt: number
  coverUrl?: string
  onlineId?: string
  onlineSource?: string
  songmid?: string
}

interface LocalMusicRow {
  id: string
  file_uri: string
  file_name: string
  title: string
  artist: string
  size: number
  format: string
  imported_at: number
  cover_url: string | null
  online_id: string | null
  online_source: string | null
  songmid: string | null
}

const LOCAL_MUSIC_COLUMNS =
  'id, file_uri, file_name, title, artist, size, format, imported_at, cover_url, online_id, online_source, songmid'

const LOCAL_MUSIC_PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

function localMusicValues(record: LocalMusicRecord): Array<string | number | null> {
  return [
    record.id,
    record.fileUri,
    record.fileName,
    record.title,
    record.artist,
    Number(record.size || 0),
    record.format,
    Number(record.importedAt || Date.now()),
    record.coverUrl || null,
    record.onlineId || null,
    record.onlineSource || null,
    record.songmid || null,
  ]
}

export async function loadLocalMusicRecords(): Promise<LocalMusicRecord[]> {
  const db = await getDatabase()
  const rows = await db.getAllAsync<LocalMusicRow>(
    `
      SELECT ${LOCAL_MUSIC_COLUMNS}
      FROM ${LOCAL_MUSIC_TABLE}
      ORDER BY imported_at DESC
    `
  )
  return rows.map((row) => ({
    id: row.id,
    fileUri: row.file_uri,
    fileName: row.file_name,
    title: row.title || '',
    artist: row.artist || '',
    size: Number(row.size || 0),
    format: row.format || '',
    importedAt: Number(row.imported_at || 0),
    coverUrl: row.cover_url || undefined,
    onlineId: row.online_id || undefined,
    onlineSource: row.online_source || undefined,
    songmid: row.songmid || undefined,
  }))
}

export async function insertLocalMusicRecords(records: LocalMusicRecord[]): Promise<void> {
  if (!records.length) return
  const db = await getDatabase()
  await db.execAsync('BEGIN IMMEDIATE TRANSACTION')
  try {
    for (const record of records) {
      await db.runAsync(
        `
          INSERT OR REPLACE INTO ${LOCAL_MUSIC_TABLE}
          (${LOCAL_MUSIC_COLUMNS})
          VALUES ${LOCAL_MUSIC_PLACEHOLDERS}
        `,
        ...localMusicValues(record)
      )
    }
    await db.execAsync('COMMIT')
  } catch (error) {
    await db.execAsync('ROLLBACK')
    throw error
  }
}

export async function deleteLocalMusicRecord(id: string): Promise<void> {
  const db = await getDatabase()
  await db.runAsync(`DELETE FROM ${LOCAL_MUSIC_TABLE} WHERE id = ?`, id)
}

export async function replaceLocalMusicRecords(records: LocalMusicRecord[]): Promise<void> {
  const db = await getDatabase()
  await db.execAsync('BEGIN IMMEDIATE TRANSACTION')
  try {
    await db.execAsync(`DELETE FROM ${LOCAL_MUSIC_TABLE}`)
    for (const record of records) {
      await db.runAsync(
        `
          INSERT INTO ${LOCAL_MUSIC_TABLE}
          (${LOCAL_MUSIC_COLUMNS})
          VALUES ${LOCAL_MUSIC_PLACEHOLDERS}
        `,
        ...localMusicValues(record)
      )
    }
    await db.execAsync('COMMIT')
  } catch (error) {
    await db.execAsync('ROLLBACK')
    throw error
  }
}
