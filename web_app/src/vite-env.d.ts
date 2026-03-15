/// <reference types="vite/client" />

interface DesktopRuntimeInfo {
  isDesktop: boolean
  outputDir: string | null
  dataDir: string | null
  logDir: string | null
  modelDir: string | null
}

interface DesktopActionResult {
  ok: boolean
  error?: string | null
  restarted?: boolean
  canceled?: boolean
  selected?: string
}

interface DesktopFileInfo {
  name: string
  path: string
  size: number
  mtimeMs: number
}

interface DesktopDirSummary {
  path: string
  exists: boolean
  fileCount: number
  dirCount: number
  totalBytes: number
  recentFiles: DesktopFileInfo[]
}

interface DesktopDataOverview {
  paths: {
    outputDir: string
    dataDir: string
    logDir: string
    modelDir: string
  }
  output: DesktopDirSummary
  logs: DesktopDirSummary
  models: DesktopDirSummary
}

interface DesktopDataOverviewResult {
  ok: boolean
  error?: string | null
  overview?: DesktopDataOverview
}

interface DesktopModelDownloadStatus {
  running: boolean
  modelName: string | null
  startedAt: number | null
  endedAt: number | null
  exitCode: number | null
  error: string | null
  logFile: string | null
  pid: number | null
  logTail: string
}

interface DesktopModelDownloadStatusResult {
  ok: boolean
  error?: string | null
  status?: DesktopModelDownloadStatus
}

interface DesktopStartModelDownloadResult {
  ok: boolean
  error?: string | null
  status?: DesktopModelDownloadStatus
}

type DesktopCleanupTarget = "logs" | "models" | "all"

interface Window {
  iopaintDesktop?: {
    isDesktop: boolean
    getRuntimeInfo: () => Promise<DesktopRuntimeInfo>
    getDataOverview: () => Promise<DesktopDataOverviewResult>
    selectOutputDir: () => Promise<DesktopActionResult>
    openOutputDir: () => Promise<DesktopActionResult>
    openDataDir: () => Promise<DesktopActionResult>
    cleanup: (target: DesktopCleanupTarget) => Promise<DesktopActionResult>
    getModelDownloadStatus: () => Promise<DesktopModelDownloadStatusResult>
    startModelDownload: (
      modelName: string
    ) => Promise<DesktopStartModelDownloadResult>
  }
}
