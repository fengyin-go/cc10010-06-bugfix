import { SEED_COLLECTIONS, SEED_ROWS } from './seed'
import type { EntryRow, PropagationRecord, SyncBatch } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'lake-govern-config:entries'
const COLLECTION_STORAGE_KEY = 'lake-govern-config:collections'

// 集合种子版本：字段口径调整后改版本号，浏览器里的旧集合会整体回落到新种子。
const COLLECTION_VERSION = 2

export type CollectionKey = 'syncBatches' | 'propagations'

type CollectionMap = {
  syncBatches: SyncBatch[]
  propagations: PropagationRecord[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

function seedCollections(): CollectionMap {
  return clone({
    syncBatches: SEED_COLLECTIONS.syncBatches,
    propagations: SEED_COLLECTIONS.propagations,
  } as CollectionMap)
}

function readCollections(): CollectionMap {
  const fallback = seedCollections()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(COLLECTION_STORAGE_KEY)
  if (!raw) {
    const seeded = seedCollections()
    window.localStorage.setItem(
      COLLECTION_STORAGE_KEY,
      JSON.stringify({ version: COLLECTION_VERSION, data: seeded }),
    )
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as { version?: number; data?: Partial<CollectionMap> }
    if (parsed.version !== COLLECTION_VERSION || !parsed.data) {
      const seeded = seedCollections()
      window.localStorage.setItem(
        COLLECTION_STORAGE_KEY,
        JSON.stringify({ version: COLLECTION_VERSION, data: seeded }),
      )
      return seeded
    }
    return { ...fallback, ...parsed.data }
  } catch {
    const seeded = seedCollections()
    window.localStorage.setItem(
      COLLECTION_STORAGE_KEY,
      JSON.stringify({ version: COLLECTION_VERSION, data: seeded }),
    )
    return seeded
  }
}

let collectionCache: CollectionMap | null = null

export function listCollection<K extends CollectionKey>(key: K): CollectionMap[K] {
  if (collectionCache === null) {
    collectionCache = readCollections()
  }
  return collectionCache[key]
}

export function saveCollection<K extends CollectionKey>(key: K, rows: CollectionMap[K]): void {
  const next = { ...(collectionCache ?? readCollections()), [key]: rows }
  collectionCache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(
      COLLECTION_STORAGE_KEY,
      JSON.stringify({ version: COLLECTION_VERSION, data: next }),
    )
  }
}

/** 回到种子：模块清单重置时，批次与传播结论也一起回到初始口径。 */
export function resetCollections(): void {
  collectionCache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(COLLECTION_STORAGE_KEY)
  }
}
