"use strict";

const { app, BrowserWindow, dialog, Menu, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const APP_NAME = "IOPaint";
const DEFAULT_MODEL = process.env.IOPAINT_MODEL || "lama";
const DEFAULT_DEVICE = process.env.IOPAINT_DEVICE || "mps";
const DEFAULT_HOST = process.env.IOPAINT_HOST || "127.0.0.1";
const START_TIMEOUT_MS = Number(process.env.IOPAINT_START_TIMEOUT_MS || "120000");
const DISABLE_HARDWARE_ACCELERATION = process.env.IOPAINT_DISABLE_GPU !== "0";
const HF_MIRROR_ENDPOINT = process.env.IOPAINT_HF_MIRROR || "https://hf-mirror.com";

let backendProc = null;
let backendPort = null;
let mainWindow = null;
let dataPaths = null;
let modelDownloadProc = null;
let modelDownloadState = {
  running: false,
  modelName: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  error: null,
  logFile: null
};

if (DISABLE_HARDWARE_ACCELERATION) {
  app.disableHardwareAcceleration();
}

function resolveBackendPaths() {
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  const backendRoot = path.join(base, "backend");
  return {
    backendRoot,
    backendSrc: path.join(backendRoot, "src"),
    backendRuntime: path.join(backendRoot, "runtime"),
    bundledModel: path.join(backendRoot, "preload_models", "big-lama.pt")
  };
}

function findRuntimeSitePackages(runtimeDir) {
  const libDir = path.join(runtimeDir, "lib");
  if (!fs.existsSync(libDir)) {
    return null;
  }
  const entries = fs.readdirSync(libDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith("python")) {
      continue;
    }
    const site = path.join(libDir, entry.name, "site-packages");
    if (fs.existsSync(site)) {
      return site;
    }
  }
  return null;
}

function isPythonUsable(pythonPath) {
  try {
    if (!fs.existsSync(pythonPath)) {
      return false;
    }
    const result = spawnSync(pythonPath, ["-c", "import sys;print('ok')"], {
      encoding: "utf8"
    });
    return result.status === 0;
  } catch (err) {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function removeDirSafe(target, baseDir) {
  const resolvedTarget = path.resolve(target);
  const resolvedBase = path.resolve(baseDir);
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error(`Refuse to delete path outside app data dir: ${resolvedTarget}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function readSettings(settingsFile) {
  try {
    if (!fs.existsSync(settingsFile)) {
      return {};
    }
    const raw = fs.readFileSync(settingsFile, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function writeSettings(settingsFile, settings) {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (err) {
    // ignore
  }
}

function getDataPaths() {
  const dataDir = app.getPath("userData");
  const modelDir = path.join(dataDir, "models");
  const logDir = path.join(dataDir, "logs");
  const settingsFile = path.join(dataDir, "settings.json");
  const settings = readSettings(settingsFile);
  const defaultOutputDir = getDefaultOutputDir();
  const outputDir = settings.outputDir || defaultOutputDir;
  ensureDir(modelDir);
  ensureDir(outputDir);
  ensureDir(logDir);
  if (!settings.outputDir) {
    writeSettings(settingsFile, { ...settings, outputDir });
  }
  return { dataDir, modelDir, outputDir, logDir, settingsFile };
}

function getDefaultOutputDir() {
  return path.join(app.getPath("pictures"), "IOPaint-output");
}

function getModelCheckpointPath(modelDir) {
  return path.join(modelDir, "torch", "hub", "checkpoints", "big-lama.pt");
}

function assertWritableDir(dirPath, label) {
  ensureDir(dirPath);
  const probe = path.join(
    dirPath,
    `.iopaint-write-check-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch (err) {
    throw new Error(
      `${label} 不可写: ${dirPath}\n` +
      `请检查目录权限，或在菜单里切换到可写目录。`
    );
  }
}

function resolvePython(paths) {
  const runtimePythonPath = path.join(paths.backendRuntime, "bin", "python3");
  const fallbackPythonPath = "/usr/bin/python3";
  const runtimeSitePackages = findRuntimeSitePackages(paths.backendRuntime);

  if (isPythonUsable(runtimePythonPath)) {
    return {
      pythonPath: runtimePythonPath,
      runtimePythonPath,
      fallbackPythonPath,
      runtimeSitePackages,
      usingFallback: false
    };
  }

  if (app.isPackaged) {
    throw new Error(
      `Bundled Python runtime not found or unusable:\n` +
      `- bundled: ${runtimePythonPath}\n` +
      `请重新安装最新版 dmg（必须包含 backend/runtime）。`
    );
  }

  if (isPythonUsable(fallbackPythonPath)) {
    return {
      pythonPath: fallbackPythonPath,
      runtimePythonPath,
      fallbackPythonPath,
      runtimeSitePackages,
      usingFallback: true
    };
  }

  throw new Error(
    `Python runtime not found or unusable:\n` +
    `- bundled: ${runtimePythonPath}\n` +
    `- fallback: ${fallbackPythonPath}`
  );
}

function buildPythonEnv(paths, dataPaths, runtimeSitePackages) {
  return {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: runtimeSitePackages
      ? `${paths.backendSrc}:${runtimeSitePackages}`
      : paths.backendSrc,
    HF_HOME: dataPaths.modelDir,
    TRANSFORMERS_CACHE: dataPaths.modelDir,
    XDG_CACHE_HOME: dataPaths.modelDir
  };
}

function runStartupPreflight(paths, dataPaths) {
  const mainPy = path.join(paths.backendSrc, "main.py");
  if (!fs.existsSync(mainPy)) {
    throw new Error(`后端入口不存在: ${mainPy}`);
  }

  assertWritableDir(dataPaths.modelDir, "模型目录");
  assertWritableDir(dataPaths.outputDir, "输出目录");
  assertWritableDir(dataPaths.logDir, "日志目录");

  const modelPath = getModelCheckpointPath(dataPaths.modelDir);
  if (!fs.existsSync(modelPath)) {
    throw new Error(
      `未找到必需模型: ${modelPath}\n` +
      `请重新打包并确保已内置 big-lama.pt，或手动复制到该路径。`
    );
  }

  const python = resolvePython(paths);
  const env = buildPythonEnv(paths, dataPaths, python.runtimeSitePackages);
  const smoke = spawnSync(
    python.pythonPath,
    ["-c", "import fastapi,uvicorn,torch,loguru,iopaint;print('ok')"],
    {
      cwd: paths.backendSrc,
      env,
      encoding: "utf8"
    }
  );
  if (smoke.status !== 0) {
    const output = `${smoke.stdout || ""}\n${smoke.stderr || ""}`.trim();
    throw new Error(
      `Python 依赖自检失败（${python.pythonPath}）\n` +
      (output ? `${output}\n` : "") +
      `请使用最新 dmg 重新安装，或重新打包 runtime。`
    );
  }

  return python;
}

function inferBackendHint(tail) {
  const text = tail || "";
  if (/No such option:\s+--disable-model-switch/i.test(text)) {
    return "当前后端版本不支持 --disable-model-switch，已自动兼容；请确认使用最新打包产物。";
  }
  if (/No module named/i.test(text)) {
    return "Python 依赖缺失。请重新打包 runtime，或使用包含 runtime 的最新 dmg。";
  }
  if (/Permission denied|Errno 13/i.test(text)) {
    return "目录权限不足。请检查输出目录/模型目录权限，必要时切换到用户目录。";
  }
  if (/Address already in use/i.test(text)) {
    return "端口被占用。请关闭旧的 IOPaint 进程后重试。";
  }
  if (/big-lama\.pt|No such file.*checkpoints/i.test(text)) {
    return "模型文件缺失。请确认 big-lama.pt 已内置或已复制到模型目录。";
  }
  return "";
}

function buildBackendErrorMessage(prefix, logFile, tail) {
  const hint = inferBackendHint(tail);
  return (
    `${prefix}\n` +
    (hint ? `建议：${hint}\n\n` : "") +
    `日志：${logFile}\n\n` +
    (tail ? `--- last 50 lines ---\n${tail}` : "")
  );
}

function inferModelDownloadHint(tail) {
  const text = tail || "";
  if (/No space left on device|Errno 28/i.test(text)) {
    return "磁盘空间不足。请释放磁盘空间后重试。";
  }
  if (/Permission denied|Errno 13/i.test(text)) {
    return "模型目录权限不足。请检查数据目录权限后重试。";
  }
  if (/401 Client Error|403 Client Error|Repository Not Found|gated repo|restricted/i.test(text)) {
    return "模型仓库访问受限。请确认模型名称、权限或 HuggingFace 登录状态。";
  }
  if (/NotOpenSSLWarning|LibreSSL/i.test(text)) {
    return "当前 Python SSL 环境较旧，建议更新打包 runtime（OpenSSL 1.1.1+）。";
  }
  if (
    /Couldn.t connect to the Hub|MaxRetryError|NameResolutionError|Failed to resolve|ConnectionError|ProxyError|SSLError|SSLEOFError|CERTIFICATE_VERIFY_FAILED/i.test(
      text
    )
  ) {
    return "无法连接 HuggingFace。请检查网络/代理配置；应用已自动尝试镜像重试一次。";
  }
  return "";
}

function shouldRetryModelDownloadWithMirror(tail) {
  const text = tail || "";
  return /Couldn.t connect to the Hub|MaxRetryError|NameResolutionError|Failed to resolve|ConnectionError|ProxyError|SSLError|SSLEOFError|CERTIFICATE_VERIFY_FAILED/i.test(
    text
  );
}

function scanDirSummary(rootDir, maxRecentFiles = 8) {
  const result = {
    path: rootDir,
    exists: fs.existsSync(rootDir),
    fileCount: 0,
    dirCount: 0,
    totalBytes: 0,
    recentFiles: []
  };
  if (!result.exists) {
    return result;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result.dirCount += 1;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      result.fileCount += 1;
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch (err) {
        continue;
      }
      result.totalBytes += stat.size;
      result.recentFiles.push({
        name: entry.name,
        path: fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
  }

  result.recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  result.recentFiles = result.recentFiles.slice(0, maxRecentFiles);
  return result;
}

function tailFile(logFile, maxLines = 50, maxBytes = 65536) {
  try {
    if (!fs.existsSync(logFile)) {
      return "";
    }
    const stat = fs.statSync(logFile);
    const size = stat.size;
    const readSize = Math.min(size, maxBytes);
    const fd = fs.openSync(logFile, "r");
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const text = buffer.toString("utf8");
    const lines = text.trim().split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
  } catch (err) {
    return "";
  }
}

function appendRendererLog(message) {
  try {
    const baseLogDir = dataPaths?.logDir || path.join(app.getPath("userData"), "logs");
    ensureDir(baseLogDir);
    const logFile = path.join(baseLogDir, "renderer.log");
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(logFile, line);
  } catch (err) {
    // ignore renderer log write failure
  }
}

function copyBundledModelIfNeeded(bundledModel, modelDir) {
  const target = path.join(modelDir, "torch", "hub", "checkpoints", "big-lama.pt");
  if (!fs.existsSync(bundledModel)) {
    return;
  }
  if (fs.existsSync(target)) {
    return;
  }
  ensureDir(path.dirname(target));
  fs.copyFileSync(bundledModel, target);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, DEFAULT_HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(port) {
  const start = Date.now();
  const url = `http://${DEFAULT_HOST}:${port}/api/v1/server-config`;

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, { timeout: 2000 }, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          res.resume();
          return resolve();
        }
        res.resume();
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - start > START_TIMEOUT_MS) {
        return reject(new Error("Backend start timeout"));
      }
      setTimeout(tick, 1000);
    };

    tick();
  });
}

function startBackend(port, paths, dataPaths) {
  const python = runStartupPreflight(paths, dataPaths);
  const pythonPath = python.pythonPath;
  const mainPy = path.join(paths.backendSrc, "main.py");

  const args = [
    mainPy,
    "start",
    "--host",
    DEFAULT_HOST,
    "--port",
    String(port),
    "--model",
    DEFAULT_MODEL,
    "--device",
    DEFAULT_DEVICE,
    "--model-dir",
    dataPaths.modelDir,
    "--output-dir",
    dataPaths.outputDir,
    "--local-files-only"
  ];

  // Some older versions don't support --disable-model-switch. Detect once.
  const supportsDisableModelSwitch = (() => {
    try {
      const result = spawnSync(
        pythonPath,
        [mainPy, "start", "--help"],
        { encoding: "utf8" }
      );
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      return output.includes("--disable-model-switch");
    } catch (err) {
      return false;
    }
  })();

  if (supportsDisableModelSwitch) {
    args.splice(args.length - 1, 0, "--disable-model-switch");
  }

  const logFile = path.join(dataPaths.logDir, "backend.log");
  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  const env = buildPythonEnv(paths, dataPaths, python.runtimeSitePackages);

  const proc = spawn(pythonPath, args, {
    cwd: paths.backendSrc,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  proc._expectedExit = false;
  backendProc = proc;

  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  proc.on("exit", (code) => {
    backendProc = null;
    if (proc._expectedExit) {
      return;
    }
    if (code !== 0 && code !== null) {
      const tail = tailFile(logFile);
      const message = buildBackendErrorMessage(
        `Backend exited with code ${code}.`,
        logFile,
        tail
      );
      dialog.showErrorBox(`${APP_NAME} backend error`, message);
    } else if (code === null) {
      const tail = tailFile(logFile);
      const message = buildBackendErrorMessage(
        "Backend exited (signal).",
        logFile,
        tail
      );
      dialog.showErrorBox(`${APP_NAME} backend error`, message);
    }
  });
}

function stopBackend() {
  if (!backendProc) {
    return;
  }
  const proc = backendProc;
  backendProc = null;
  try {
    proc._expectedExit = true;
    proc.kill("SIGTERM");
  } catch (e) {
    return;
  }
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch (e) {
      // ignore
    }
  }, 3000);
}

function stopModelDownload() {
  if (!modelDownloadProc) {
    return;
  }
  const proc = modelDownloadProc;
  modelDownloadProc = null;
  try {
    proc.kill("SIGTERM");
  } catch (err) {
    // ignore
  }
}

async function restartBackend() {
  if (!backendPort || !dataPaths) {
    return;
  }
  stopBackend();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  startBackend(backendPort, resolveBackendPaths(), dataPaths);
  await waitForServer(backendPort);
  if (mainWindow) {
    await mainWindow.loadURL(`http://${DEFAULT_HOST}:${backendPort}`);
  }
}

function openOutputDir() {
  if (!dataPaths?.outputDir) {
    return Promise.resolve("Output directory not configured");
  }
  ensureDir(dataPaths.outputDir);
  return shell.openPath(dataPaths.outputDir);
}

function openDataDir() {
  if (!dataPaths?.dataDir) {
    return Promise.resolve("Data directory not configured");
  }
  ensureDir(dataPaths.dataDir);
  return shell.openPath(dataPaths.dataDir);
}

async function selectOutputDirAndRestart() {
  if (!dataPaths) {
    throw new Error("Data paths not initialized");
  }
  const result = await dialog.showOpenDialog({
    title: "选择输出目录",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }

  const selected = result.filePaths[0];
  ensureDir(selected);
  const settings = readSettings(dataPaths.settingsFile);
  writeSettings(dataPaths.settingsFile, {
    ...settings,
    outputDir: selected
  });
  dataPaths.outputDir = selected;
  await restartBackend();
  return { canceled: false, selected };
}

function clearLogFiles() {
  if (!dataPaths?.logDir) {
    throw new Error("Log directory not configured");
  }
  ensureDir(dataPaths.logDir);
  const entries = fs.readdirSync(dataPaths.logDir);
  for (const entry of entries) {
    const fullPath = path.join(dataPaths.logDir, entry);
    if (backendProc && entry === "backend.log" && fs.existsSync(fullPath)) {
      fs.truncateSync(fullPath, 0);
      continue;
    }
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

function getModelDownloadStatus() {
  return {
    ...modelDownloadState,
    pid: modelDownloadProc ? modelDownloadProc.pid : null,
    logTail: modelDownloadState.logFile
      ? tailFile(modelDownloadState.logFile, 80, 131072)
      : ""
  };
}

function startModelDownload(modelNameInput) {
  if (!dataPaths) {
    throw new Error("Data paths not initialized");
  }
  if (modelDownloadProc) {
    throw new Error(
      `已有下载任务进行中: ${modelDownloadState.modelName || "unknown"}`
    );
  }

  const modelName = String(modelNameInput || "").trim();
  if (!modelName) {
    throw new Error("模型名称不能为空");
  }

  const paths = resolveBackendPaths();
  const mainPy = path.join(paths.backendSrc, "main.py");
  if (!fs.existsSync(mainPy)) {
    throw new Error(`后端入口不存在: ${mainPy}`);
  }

  assertWritableDir(dataPaths.modelDir, "模型目录");
  assertWritableDir(dataPaths.logDir, "日志目录");

  const python = resolvePython(paths);
  const env = buildPythonEnv(paths, dataPaths, python.runtimeSitePackages);
  // Download command needs online mode even if backend runtime uses local-files-only.
  env.TRANSFORMERS_OFFLINE = "0";
  env.HF_HUB_OFFLINE = "0";

  const logFile = path.join(
    dataPaths.logDir,
    `model-download-${Date.now()}.log`
  );
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const args = [
    mainPy,
    "download",
    "--model",
    modelName,
    "--model-dir",
    dataPaths.modelDir
  ];

  modelDownloadState = {
    running: true,
    modelName,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    error: null,
    logFile
  };
  let hasRetriedWithMirror = false;

  const startAttempt = (attemptEnv, attemptLabel) => {
    const proc = spawn(python.pythonPath, args, {
      cwd: paths.backendSrc,
      env: attemptEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    modelDownloadProc = proc;

    proc.stdout.pipe(logStream, { end: false });
    proc.stderr.pipe(logStream, { end: false });

    let settled = false;
    const finalize = (exitCode, errorMessage) => {
      if (settled) {
        return;
      }
      settled = true;
      modelDownloadState = {
        ...modelDownloadState,
        running: false,
        endedAt: Date.now(),
        exitCode,
        error: errorMessage
      };
      modelDownloadProc = null;
      logStream.end();
    };

    proc.on("error", (err) => {
      finalize(-1, String(err));
    });

    proc.on("exit", (code, signal) => {
      if (signal) {
        finalize(typeof code === "number" ? code : null, `下载进程被信号终止: ${signal}`);
        return;
      }
      if (code === 0) {
        finalize(0, null);
        return;
      }

      const tail = tailFile(logFile, 120, 262144);
      if (
        !hasRetriedWithMirror &&
        !attemptEnv.HF_ENDPOINT &&
        shouldRetryModelDownloadWithMirror(tail)
      ) {
        hasRetriedWithMirror = true;
        try {
          logStream.write(
            `\n[desktop] Download failed on ${attemptLabel}, retry with HF mirror: ${HF_MIRROR_ENDPOINT}\n\n`
          );
        } catch (err) {
          // ignore log write error
        }
        modelDownloadState = {
          ...modelDownloadState,
          running: true,
          endedAt: null,
          exitCode: null,
          error: "首次下载失败，正在使用镜像重试..."
        };
        startAttempt({ ...attemptEnv, HF_ENDPOINT: HF_MIRROR_ENDPOINT }, "mirror");
        return;
      }

      const hint = inferModelDownloadHint(tail);
      const endpointSuffix = attemptEnv.HF_ENDPOINT
        ? `，HF_ENDPOINT=${attemptEnv.HF_ENDPOINT}`
        : "";
      const errorMessage = hint
        ? `下载失败，退出码 ${code}${endpointSuffix}。${hint}`
        : `下载失败，退出码 ${code}${endpointSuffix}`;
      finalize(typeof code === "number" ? code : null, errorMessage);
    });
  };

  startAttempt(env, "primary");
}

async function clearModelCacheAndRestart() {
  if (!dataPaths) {
    throw new Error("Data paths not initialized");
  }
  stopBackend();
  removeDirSafe(dataPaths.modelDir, dataPaths.dataDir);
  ensureDir(dataPaths.modelDir);
  const paths = resolveBackendPaths();
  copyBundledModelIfNeeded(paths.bundledModel, dataPaths.modelDir);
  await restartBackend();
}

function resetSettingsToDefaultOutput() {
  if (!dataPaths) {
    throw new Error("Data paths not initialized");
  }
  const defaultOutputDir = getDefaultOutputDir();
  ensureDir(defaultOutputDir);
  const settings = readSettings(dataPaths.settingsFile);
  writeSettings(dataPaths.settingsFile, {
    ...settings,
    outputDir: defaultOutputDir
  });
  dataPaths.outputDir = defaultOutputDir;
}

async function clearAllAppDataAndRestart() {
  clearLogFiles();
  resetSettingsToDefaultOutput();
  await clearModelCacheAndRestart();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const splashContent =
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<style>" +
    "html,body{margin:0;height:100%;}" +
    "body{display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 800px at 20% 10%,#1f2a3a 0%,#0b0f15 60%,#07090c 100%);color:#e8eef5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}" +
    ".wrap{display:flex;flex-direction:column;align-items:center;gap:12px;}" +
    ".title{font-size:24px;letter-spacing:0.5px;font-weight:600;}" +
    ".sub{font-size:13px;color:#9aa7b6;}" +
    ".spinner{width:28px;height:28px;border-radius:50%;border:3px solid rgba(232,238,245,0.2);border-top-color:#e8eef5;animation:spin 1s linear infinite;}" +
    "@keyframes spin{to{transform:rotate(360deg)}}" +
    "</style></head><body>" +
    "<div class='wrap'><div class='spinner'></div><div class='title'>IOPaint 正在启动</div><div class='sub'>首次加载可能需要几十秒</div></div>" +
    "</body></html>";
  const splashHtml =
    "data:text/html;base64," +
    Buffer.from(splashContent, "utf8").toString("base64");
  mainWindow.loadURL(splashHtml);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
    const message = `did-fail-load code=${code} desc=${desc} url=${url}`;
    appendRendererLog(message);
    dialog.showErrorBox(`${APP_NAME} 页面加载失败`, message);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const message =
      `render-process-gone reason=${details.reason} ` +
      `exitCode=${details.exitCode}`;
    appendRendererLog(message);
    dialog.showErrorBox(`${APP_NAME} 渲染进程异常`, message);
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    appendRendererLog(
      `console level=${level} source=${sourceId}:${line} message=${message}`
    );
  });
  mainWindow.webContents.on("did-finish-load", () => {
    appendRendererLog(`did-finish-load url=${mainWindow.webContents.getURL()}`);
    void mainWindow.webContents
      .executeJavaScript(
        "({ title: document.title || '', bodyClass: document.body?.className || '', textLen: (document.body?.innerText || '').trim().length })",
        true
      )
      .then((summary) => {
        appendRendererLog(
          `dom-summary title=${summary.title} bodyClass=${summary.bodyClass} textLen=${summary.textLen}`
        );
      })
      .catch((err) => {
        appendRendererLog(`dom-summary-failed error=${String(err)}`);
      });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createAppMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: "quit" }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:get-runtime-info", () => {
    if (!dataPaths) {
      return {
        isDesktop: true,
        outputDir: null,
        dataDir: null,
        logDir: null,
        modelDir: null
      };
    }
    return {
      isDesktop: true,
      outputDir: dataPaths.outputDir,
      dataDir: dataPaths.dataDir,
      logDir: dataPaths.logDir,
      modelDir: dataPaths.modelDir
    };
  });

  ipcMain.handle("desktop:get-data-overview", () => {
    if (!dataPaths) {
      return {
        ok: false,
        error: "Data paths not initialized"
      };
    }
    try {
      const outputSummary = scanDirSummary(dataPaths.outputDir);
      const logSummary = scanDirSummary(dataPaths.logDir);
      const modelSummary = scanDirSummary(dataPaths.modelDir);
      return {
        ok: true,
        overview: {
          paths: {
            outputDir: dataPaths.outputDir,
            dataDir: dataPaths.dataDir,
            logDir: dataPaths.logDir,
            modelDir: dataPaths.modelDir
          },
          output: outputSummary,
          logs: logSummary,
          models: modelSummary
        }
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err)
      };
    }
  });

  ipcMain.handle("desktop:open-output-dir", async () => {
    try {
      const error = await openOutputDir();
      return { ok: !error, error: error || null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("desktop:select-output-dir", async () => {
    try {
      const result = await selectOutputDirAndRestart();
      if (result.canceled) {
        return { ok: false, canceled: true };
      }
      return { ok: true, selected: result.selected, restarted: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("desktop:open-data-dir", async () => {
    try {
      const error = await openDataDir();
      return { ok: !error, error: error || null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("desktop:cleanup", async (_event, target) => {
    try {
      if (target === "logs") {
        clearLogFiles();
        return { ok: true };
      }
      if (target === "models") {
        await clearModelCacheAndRestart();
        return { ok: true, restarted: true };
      }
      if (target === "all") {
        await clearAllAppDataAndRestart();
        return { ok: true, restarted: true };
      }
      return { ok: false, error: `Unknown cleanup target: ${target}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("desktop:get-model-download-status", () => {
    try {
      return { ok: true, status: getModelDownloadStatus() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("desktop:start-model-download", (_event, modelName) => {
    try {
      startModelDownload(modelName);
      return { ok: true, status: getModelDownloadStatus() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}

async function boot() {
  createWindow();

  const paths = resolveBackendPaths();
  dataPaths = getDataPaths();
  copyBundledModelIfNeeded(paths.bundledModel, dataPaths.modelDir);
  createAppMenu();

  backendPort = await getFreePort();

  try {
    startBackend(backendPort, paths, dataPaths);
    await waitForServer(backendPort);
    const url = `http://${DEFAULT_HOST}:${backendPort}`;
    await mainWindow.loadURL(url);
  } catch (err) {
    const logFile = path.join(dataPaths.logDir, "backend.log");
    const tail = tailFile(logFile);
    const detail = err instanceof Error ? `${err.message}\n\n` : "";
    dialog.showErrorBox(
      `${APP_NAME} 启动失败`,
      detail + buildBackendErrorMessage("后端服务未能启动。", logFile, tail)
    );
  }
}

app.on("before-quit", () => {
  stopBackend();
  stopModelDownload();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(() => {
  registerIpcHandlers();
  boot().catch((err) => {
    dialog.showErrorBox(`${APP_NAME} 启动失败`, String(err));
    app.quit();
  });
});
