"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("iopaintDesktop", {
  isDesktop: true,
  getRuntimeInfo: () => ipcRenderer.invoke("desktop:get-runtime-info"),
  getDataOverview: () => ipcRenderer.invoke("desktop:get-data-overview"),
  selectOutputDir: () => ipcRenderer.invoke("desktop:select-output-dir"),
  openOutputDir: () => ipcRenderer.invoke("desktop:open-output-dir"),
  openDataDir: () => ipcRenderer.invoke("desktop:open-data-dir"),
  cleanup: (target) => ipcRenderer.invoke("desktop:cleanup", target)
});
