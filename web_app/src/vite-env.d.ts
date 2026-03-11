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
  }
}
