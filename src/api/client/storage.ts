import { invoke } from "../transport"

export type StorageCategoryId = "sessions" | "archivedSessions" | "cache" | "logs" | "appData"

export interface StorageCategory {
  id: StorageCategoryId
  bytes: number
  fileCount: number
  /** Session count for session categories, file count for the others. */
  itemCount: number
}

export interface StorageSummary {
  totalBytes: number
  categories: StorageCategory[]
  dataDirectory: string
  sessionsDirectory: string
  scannedAt: number
}

export interface StorageCleanupResult {
  freedBytes: number
  deletedItems: number
  failed: number
}

export const getStorageSummary = () => invoke<StorageSummary>("storage_summary")
export const cleanupStorage = (kind: Exclude<StorageCategoryId, "sessions" | "appData">) =>
  invoke<StorageCleanupResult>("storage_cleanup", { kind })
