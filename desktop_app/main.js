"use strict";

const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
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

let backendProc = null;
let backendPort = null;
let mainWindow = null;
let dataPaths = null;

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
  const defaultOutputDir = path.join(app.getPath("pictures"), "IOPaint-output");
  const outputDir = settings.outputDir || defaultOutputDir;
  ensureDir(modelDir);
  ensureDir(outputDir);
  ensureDir(logDir);
  if (!settings.outputDir) {
    writeSettings(settingsFile, { ...settings, outputDir });
  }
  return { dataDir, modelDir, outputDir, logDir, settingsFile };
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
  const runtimePythonPath = path.join(paths.backendRuntime, "bin", "python3");
  const fallbackPythonPath = "/usr/bin/python3";
  const runtimeSitePackages = findRuntimeSitePackages(paths.backendRuntime);
  const pythonPath = isPythonUsable(runtimePythonPath)
    ? runtimePythonPath
    : fallbackPythonPath;
  const mainPy = path.join(paths.backendSrc, "main.py");

  if (!isPythonUsable(pythonPath)) {
    throw new Error(
      `Python runtime not found or unusable: ${runtimePythonPath}. ` +
      `Fallback also failed: ${fallbackPythonPath}`
    );
  }
  if (!fs.existsSync(mainPy)) {
    throw new Error(`Backend entry not found: ${mainPy}`);
  }

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

  const env = {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: runtimeSitePackages
      ? `${paths.backendSrc}:${runtimeSitePackages}`
      : paths.backendSrc,
    HF_HOME: dataPaths.modelDir,
    TRANSFORMERS_CACHE: dataPaths.modelDir,
    XDG_CACHE_HOME: dataPaths.modelDir
  };

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
      const message =
        `Backend exited with code ${code}.\n` +
        `Log: ${logFile}\n\n` +
        (tail ? `--- last 50 lines ---\n${tail}` : "");
      dialog.showErrorBox(`${APP_NAME} backend error`, message);
    } else if (code === null) {
      const tail = tailFile(logFile);
      const message =
        `Backend exited (signal).\n` +
        `Log: ${logFile}\n\n` +
        (tail ? `--- last 50 lines ---\n${tail}` : "");
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
    return;
  }
  ensureDir(dataPaths.outputDir);
  shell.openPath(dataPaths.outputDir);
}

function showOutputDir() {
  if (!dataPaths?.outputDir) {
    return;
  }
  const choice = dialog.showMessageBoxSync({
    type: "info",
    buttons: ["打开", "关闭"],
    defaultId: 0,
    message: "当前下载目录",
    detail: dataPaths.outputDir
  });
  if (choice === 0) {
    openOutputDir();
  }
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
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createAppMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: "设置输出目录...",
          click: async () => {
            if (!dataPaths) {
              return;
            }
            const result = await dialog.showOpenDialog({
              title: "选择输出目录",
              properties: ["openDirectory", "createDirectory"]
            });
            if (result.canceled || !result.filePaths.length) {
              return;
            }
            const selected = result.filePaths[0];
            ensureDir(selected);
            const settings = readSettings(dataPaths.settingsFile);
            writeSettings(dataPaths.settingsFile, {
              ...settings,
              outputDir: selected
            });
            dataPaths.outputDir = selected;
            const choice = dialog.showMessageBoxSync({
              type: "question",
              buttons: ["立即重启", "稍后"],
              defaultId: 0,
              message: "已更新输出目录，需重启后端生效。",
              detail: selected
            });
            if (choice === 0) {
              try {
                await restartBackend();
              } catch (err) {
                dialog.showErrorBox(
                  `${APP_NAME} 重启失败`,
                  String(err)
                );
              }
            }
          }
        },
        {
          label: "显示下载目录",
          click: () => {
            showOutputDir();
          }
        },
        {
          label: "打开下载目录",
          click: () => {
            openOutputDir();
          }
        },
        {
          label: "清理模型缓存",
          click: async () => {
            if (!dataPaths) {
              return;
            }
            const choice = dialog.showMessageBoxSync({
              type: "warning",
              buttons: ["取消", "清理并重启"],
              defaultId: 1,
              cancelId: 0,
              message: "确认清理模型缓存？",
              detail: "这会删除已下载的模型文件，应用将重启。"
            });
            if (choice !== 1) {
              return;
            }
            try {
              stopBackend();
              removeDirSafe(dataPaths.modelDir, dataPaths.dataDir);
              ensureDir(dataPaths.modelDir);
              await restartBackend();
            } catch (err) {
              dialog.showErrorBox(`${APP_NAME} 清理失败`, String(err));
            }
          }
        },
        { type: "separator" },
        { role: "quit" }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function boot() {
  createWindow();

  const paths = resolveBackendPaths();
  dataPaths = getDataPaths();
  copyBundledModelIfNeeded(paths.bundledModel, dataPaths.modelDir);
  createAppMenu();

  backendPort = await getFreePort();
  startBackend(backendPort, paths, dataPaths);

  try {
    await waitForServer(backendPort);
    const url = `http://${DEFAULT_HOST}:${backendPort}`;
    await mainWindow.loadURL(url);
  } catch (err) {
    const logFile = path.join(dataPaths.logDir, "backend.log");
    const tail = tailFile(logFile);
    dialog.showErrorBox(
      `${APP_NAME} 启动失败`,
      `后端服务未能启动。\n日志：${logFile}\n\n` +
        (tail ? `--- last 50 lines ---\n${tail}` : "")
    );
  }
}

app.on("before-quit", () => {
  stopBackend();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(() => {
  boot().catch((err) => {
    dialog.showErrorBox(`${APP_NAME} 启动失败`, String(err));
    app.quit();
  });
});
