import { invoke } from "../transport"

export type StorageCategoryId = "sessions" | "archivedSessions" | "workspaces"

export interface StorageCategory {
  id: StorageCategoryId
  bytes: number
  fileCount: number
  /** Session count for session categories, file count for workspaces. */
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
