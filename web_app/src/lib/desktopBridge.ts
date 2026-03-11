export type DesktopCleanupTarget = "logs" | "models" | "all"

export interface DesktopRuntimeInfo {
  isDesktop: boolean
  outputDir: string | null
  dataDir: string | null
  logDir: string | null
  modelDir: string | null
}

export interface DesktopActionResult {
  ok: boolean
  error?: string | null
  restarted?: boolean
  canceled?: boolean
  selected?: string
}

export interface DesktopFileInfo {
  name: string
  path: string
  size: number
  mtimeMs: number
}

export interface DesktopDirSummary {
  path: string
  exists: boolean
  fileCount: number
  dirCount: number
  totalBytes: number
  recentFiles: DesktopFileInfo[]
}

export interface DesktopDataOverview {
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

export interface DesktopDataOverviewResult {
  ok: boolean
  error?: string | null
  overview?: DesktopDataOverview
}

interface DesktopBridge {
  isDesktop: boolean
  getRuntimeInfo: () => Promise<DesktopRuntimeInfo>
  getDataOverview: () => Promise<DesktopDataOverviewResult>
  selectOutputDir: () => Promise<DesktopActionResult>
  openOutputDir: () => Promise<DesktopActionResult>
  openDataDir: () => Promise<DesktopActionResult>
  cleanup: (target: DesktopCleanupTarget) => Promise<DesktopActionResult>
}

function getBridge(): DesktopBridge | null {
  if (typeof window === "undefined") {
    return null
  }
  return window.iopaintDesktop ?? null
}

export function isDesktopBridgeAvailable(): boolean {
  return getBridge() !== null
}

export async function getDesktopRuntimeInfo(): Promise<DesktopRuntimeInfo | null> {
  const bridge = getBridge()
  if (!bridge) {
    return null
  }
  return bridge.getRuntimeInfo()
}

export async function getDesktopDataOverview(): Promise<DesktopDataOverviewResult> {
  const bridge = getBridge()
  if (!bridge) {
    return { ok: false, error: "Desktop bridge unavailable" }
  }
  return bridge.getDataOverview()
}

export async function openDesktopOutputDir(): Promise<DesktopActionResult> {
  const bridge = getBridge()
  if (!bridge) {
    return { ok: false, error: "Desktop bridge unavailable" }
  }
  return bridge.openOutputDir()
}

export async function selectDesktopOutputDir(): Promise<DesktopActionResult> {
  const bridge = getBridge()
  if (!bridge) {
    return { ok: false, error: "Desktop bridge unavailable" }
  }
  return bridge.selectOutputDir()
}

export async function openDesktopDataDir(): Promise<DesktopActionResult> {
  const bridge = getBridge()
  if (!bridge) {
    return { ok: false, error: "Desktop bridge unavailable" }
  }
  return bridge.openDataDir()
}

export async function cleanupDesktopData(
  target: DesktopCleanupTarget
): Promise<DesktopActionResult> {
  const bridge = getBridge()
  if (!bridge) {
    return { ok: false, error: "Desktop bridge unavailable" }
  }
  return bridge.cleanup(target)
}
