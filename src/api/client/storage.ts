import { invoke } from "../transport"

export type StorageCategoryId = "sessions" | "archivedSessions"

export interface StorageCategory {
  id: StorageCategoryId
  bytes: number
  fileCount: number
  /** Number of sessions in this category. */
  itemCount: number
}

export interface StorageSummary {
  totalBytes: number
  categories: StorageCategory[]
  sessionsDirectory: string
  scannedAt: number
}

export interface StorageCleanupResult {
  freedBytes: number
  deletedItems: number
  failed: number
}

export const getStorageSummary = () => invoke<StorageSummary>("storage_summary")
export const cleanupStorage = (kind: "archivedSessions") => invoke<StorageCleanupResult>("storage_cleanup", { kind })
