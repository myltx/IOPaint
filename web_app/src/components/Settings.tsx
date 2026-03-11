import { IconButton } from "@/components/ui/button"
import { useToggle } from "@uidotdev/usehooks"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog"
import { Settings } from "lucide-react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form"
import { Switch } from "./ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs"
import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { getServerConfig, switchModel, switchPluginModel } from "@/lib/api"
import { ModelInfo, PluginName } from "@/lib/types"
import { useStore } from "@/lib/states"
import {
  cleanupDesktopData,
  DesktopCleanupTarget,
  DesktopDataOverview,
  DesktopRuntimeInfo,
  getDesktopDataOverview,
  getDesktopRuntimeInfo,
  isDesktopBridgeAvailable,
  openDesktopDataDir,
  openDesktopOutputDir,
  selectDesktopOutputDir,
} from "@/lib/desktopBridge"
import {
  AppLocale,
  getPreferredLocale,
  setPreferredLocale,
  t,
} from "@/lib/locale"
import { ScrollArea } from "./ui/scroll-area"
import { useToast } from "./ui/use-toast"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
} from "./ui/alert-dialog"
import {
  MODEL_TYPE_DIFFUSERS_SD,
  MODEL_TYPE_DIFFUSERS_SDXL,
  MODEL_TYPE_DIFFUSERS_SDXL_INPAINT,
  MODEL_TYPE_DIFFUSERS_SD_INPAINT,
  MODEL_TYPE_INPAINT,
  MODEL_TYPE_OTHER,
} from "@/lib/const"
import useHotKey from "@/hooks/useHotkey"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select"

const formSchema = z.object({
  enableFileManager: z.boolean(),
  inputDirectory: z.string(),
  outputDirectory: z.string(),
  enableDownloadMask: z.boolean(),
  enableManualInpainting: z.boolean(),
  enableUploadMask: z.boolean(),
  enableAutoExtractPrompt: z.boolean(),
  removeBGModel: z.string(),
  realesrganModel: z.string(),
  interactiveSegModel: z.string(),
})

const TAB_GENERAL = "general"
const TAB_MODEL = "model"
const TAB_PLUGINS = "plugins"
const TAB_DATA = "data"

const BASE_TAB_NAMES = [TAB_MODEL, TAB_GENERAL, TAB_PLUGINS]

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const fixed = value >= 100 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(fixed)} ${units[unitIndex]}`
}

function formatDateTime(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "-"
  }
  return new Date(ms).toLocaleString()
}

export function SettingsDialog() {
  const [open, toggleOpen] = useToggle(false)
  const [tab, setTab] = useState(TAB_MODEL)
  const [
    updateAppState,
    settings,
    updateSettings,
    fileManagerState,
    setAppModel,
    setServerConfig,
  ] = useStore((state) => [
    state.updateAppState,
    state.settings,
    state.updateSettings,
    state.fileManagerState,
    state.setModel,
    state.setServerConfig,
  ])
  const { toast } = useToast()
  const [model, setModel] = useState<ModelInfo>(settings.model)
  const [modelSwitchingTexts, setModelSwitchingTexts] = useState<string[]>([])
  const [desktopRuntimeInfo, setDesktopRuntimeInfo] =
    useState<DesktopRuntimeInfo | null>(null)
  const [desktopDataOverview, setDesktopDataOverview] =
    useState<DesktopDataOverview | null>(null)
  const [isLoadingDesktopData, setIsLoadingDesktopData] = useState(false)
  const [desktopBusyAction, setDesktopBusyAction] = useState<
    DesktopCleanupTarget | "open_output" | "open_data" | "set_output" | null
  >(null)
  const [locale, setLocale] = useState<AppLocale>(() => getPreferredLocale())
  const desktopSupported = isDesktopBridgeAvailable()
  const tabNames = desktopSupported
    ? [...BASE_TAB_NAMES, TAB_DATA]
    : BASE_TAB_NAMES
  const openModelSwitching = modelSwitchingTexts.length > 0
  useEffect(() => {
    setModel(settings.model)
  }, [settings.model])

  const {
    data: serverConfig,
    status,
    refetch,
  } = useQuery({
    queryKey: ["serverConfig"],
    queryFn: getServerConfig,
  })

  // 1. Define your form.
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      enableDownloadMask: settings.enableDownloadMask,
      enableManualInpainting: settings.enableManualInpainting,
      enableUploadMask: settings.enableUploadMask,
      enableAutoExtractPrompt: settings.enableAutoExtractPrompt,
      inputDirectory: fileManagerState.inputDirectory,
      outputDirectory: fileManagerState.outputDirectory,
      removeBGModel: serverConfig?.removeBGModel,
      realesrganModel: serverConfig?.realesrganModel,
      interactiveSegModel: serverConfig?.interactiveSegModel,
    },
  })

  useEffect(() => {
    if (serverConfig) {
      setServerConfig(serverConfig)
      form.setValue("removeBGModel", serverConfig.removeBGModel)
      form.setValue("realesrganModel", serverConfig.realesrganModel)
      form.setValue("interactiveSegModel", serverConfig.interactiveSegModel)
    }
  }, [form, serverConfig])

  useEffect(() => {
    if (!desktopSupported) {
      setDesktopRuntimeInfo(null)
      setDesktopDataOverview(null)
      return
    }
    let cancelled = false
    setIsLoadingDesktopData(true)
    Promise.all([getDesktopRuntimeInfo(), getDesktopDataOverview()])
      .then(([runtimeInfo, overviewResult]) => {
        if (cancelled) {
          return
        }
        setDesktopRuntimeInfo(runtimeInfo)
        if (overviewResult.ok && overviewResult.overview) {
          setDesktopDataOverview(overviewResult.overview)
        } else {
          setDesktopDataOverview(null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopRuntimeInfo(null)
          setDesktopDataOverview(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingDesktopData(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [desktopSupported, open])

  useEffect(() => {
    if (!desktopSupported && tab === TAB_DATA) {
      setTab(TAB_MODEL)
    }
  }, [desktopSupported, tab])

  function tabLabel(tabName: string) {
    if (tabName === TAB_MODEL) {
      return t(locale, "模型", "Model")
    }
    if (tabName === TAB_GENERAL) {
      return t(locale, "通用", "General")
    }
    if (tabName === TAB_PLUGINS) {
      return t(locale, "插件", "Plugins")
    }
    if (tabName === TAB_DATA) {
      return t(locale, "数据", "Data")
    }
    return tabName
  }

  function changeLocale(nextLocale: AppLocale) {
    setLocale(nextLocale)
    setPreferredLocale(nextLocale)
  }

  async function onSubmit(values: z.infer<typeof formSchema>) {
    // Do something with the form values. ✅ This will be type-safe and validated.
    updateSettings({
      enableDownloadMask: values.enableDownloadMask,
      enableManualInpainting: values.enableManualInpainting,
      enableUploadMask: values.enableUploadMask,
      enableAutoExtractPrompt: values.enableAutoExtractPrompt,
    })

    // TODO: validate input/output Directory
    // updateFileManagerState({
    //   inputDirectory: values.inputDirectory,
    //   outputDirectory: values.outputDirectory,
    // })

    const shouldSwitchModel = model.name !== settings.model.name
    const shouldSwitchRemoveBGModel =
      serverConfig?.removeBGModel !== values.removeBGModel && removeBGEnabled
    const shouldSwitchRealesrganModel =
      serverConfig?.realesrganModel !== values.realesrganModel &&
      realesrganEnabled
    const shouldSwitchInteractiveModel =
      serverConfig?.interactiveSegModel !== values.interactiveSegModel &&
      interactiveSegEnabled

    const showModelSwitching =
      shouldSwitchModel ||
      shouldSwitchRemoveBGModel ||
      shouldSwitchRealesrganModel ||
      shouldSwitchInteractiveModel

    if (showModelSwitching) {
      const newModelSwitchingTexts: string[] = []
      if (shouldSwitchModel) {
        newModelSwitchingTexts.push(
          `Switching model from ${settings.model.name} to ${model.name}`
        )
      }
      if (shouldSwitchRemoveBGModel) {
        newModelSwitchingTexts.push(
          `Switching RemoveBG model from ${serverConfig?.removeBGModel} to ${values.removeBGModel}`
        )
      }
      if (shouldSwitchRealesrganModel) {
        newModelSwitchingTexts.push(
          `Switching RealESRGAN model from ${serverConfig?.realesrganModel} to ${values.realesrganModel}`
        )
      }
      if (shouldSwitchInteractiveModel) {
        newModelSwitchingTexts.push(
          `Switching ${PluginName.InteractiveSeg} model from ${serverConfig?.interactiveSegModel} to ${values.interactiveSegModel}`
        )
      }
      setModelSwitchingTexts(newModelSwitchingTexts)

      updateAppState({ disableShortCuts: true })

      if (shouldSwitchModel) {
        try {
          const newModel = await switchModel(model.name)
          toast({
            title: `Switch to ${newModel.name} success`,
          })
          setAppModel(model)
        } catch (error: any) {
          toast({
            variant: "destructive",
            title: `Switch to ${model.name} failed: ${error}`,
          })
          setModel(settings.model)
        }
      }

      if (shouldSwitchRemoveBGModel) {
        try {
          const res = await switchPluginModel(
            PluginName.RemoveBG,
            values.removeBGModel
          )
          if (res.status !== 200) {
            throw new Error(res.statusText)
          }
        } catch (error: any) {
          toast({
            variant: "destructive",
            title: `Switch RemoveBG model to ${values.removeBGModel} failed: ${error}`,
          })
        }
      }

      if (shouldSwitchRealesrganModel) {
        try {
          const res = await switchPluginModel(
            PluginName.RealESRGAN,
            values.realesrganModel
          )
          if (res.status !== 200) {
            throw new Error(res.statusText)
          }
        } catch (error: any) {
          toast({
            variant: "destructive",
            title: `Switch RealESRGAN model to ${values.realesrganModel} failed: ${error}`,
          })
        }
      }

      if (shouldSwitchInteractiveModel) {
        try {
          const res = await switchPluginModel(
            PluginName.InteractiveSeg,
            values.interactiveSegModel
          )
          if (res.status !== 200) {
            throw new Error(res.statusText)
          }
        } catch (error: any) {
          toast({
            variant: "destructive",
            title: `Switch ${PluginName.InteractiveSeg} model to ${values.interactiveSegModel} failed: ${error}`,
          })
        }
      }

      setModelSwitchingTexts([])
      updateAppState({ disableShortCuts: false })

      refetch()
    }
  }

  useHotKey(
    "s",
    () => {
      toggleOpen()
      if (open) {
        onSubmit(form.getValues())
      }
    },
    [open, form, model, serverConfig]
  )

  if (status !== "success") {
    return <></>
  }

  const modelInfos = serverConfig.modelInfos
  const plugins = serverConfig.plugins
  const removeBGEnabled = plugins.some(
    (plugin) => plugin.name === PluginName.RemoveBG
  )
  const realesrganEnabled = plugins.some(
    (plugin) => plugin.name === PluginName.RealESRGAN
  )
  const interactiveSegEnabled = plugins.some(
    (plugin) => plugin.name === PluginName.InteractiveSeg
  )

  function onOpenChange(value: boolean) {
    toggleOpen()
    if (!value) {
      onSubmit(form.getValues())
    }
  }

  function onModelSelect(info: ModelInfo) {
    setModel(info)
  }

  function renderModelList(model_types: string[]) {
    if (!modelInfos) {
      return <div>Please download model first</div>
    }
    return modelInfos
      .filter((info) => model_types.includes(info.model_type))
      .map((info: ModelInfo) => {
        return (
          <div
            key={info.name}
            onClick={() => onModelSelect(info)}
            className="px-2"
          >
            <div
              className={cn([
                info.name === model.name ? "bg-muted" : "hover:bg-muted",
                "rounded-md px-2 py-2",
                "cursor-default",
              ])}
            >
              <div className="text-base">{info.name}</div>
            </div>
            <Separator className="my-1" />
          </div>
        )
      })
  }

  function renderModelSettings() {
    let defaultTab = MODEL_TYPE_INPAINT
    for (let info of modelInfos) {
      if (model.name === info.name) {
        defaultTab = info.model_type
        if (defaultTab === MODEL_TYPE_DIFFUSERS_SDXL) {
          defaultTab = MODEL_TYPE_DIFFUSERS_SD
        }
        if (defaultTab === MODEL_TYPE_DIFFUSERS_SDXL_INPAINT) {
          defaultTab = MODEL_TYPE_DIFFUSERS_SD_INPAINT
        }
        break
      }
    }

    return (
      <div className="flex flex-col gap-4 w-[510px]">
        <div className="flex flex-col gap-4 rounded-md">
          <div className="font-medium">Current Model</div>
          <div>{model.name}</div>
        </div>

        <Separator />

        <div className="space-y-4  rounded-md">
          <div className="flex gap-1 items-center justify-start">
            <div className="font-medium">Available models</div>
            {/* <IconButton tooltip="How to download new model">
              <Info size={20} strokeWidth={2} className="opacity-50" />
            </IconButton> */}
          </div>
          <Tabs defaultValue={defaultTab}>
            <TabsList>
              <TabsTrigger value={MODEL_TYPE_INPAINT}>Inpaint</TabsTrigger>
              <TabsTrigger value={MODEL_TYPE_DIFFUSERS_SD}>
                Stable Diffusion
              </TabsTrigger>
              <TabsTrigger value={MODEL_TYPE_DIFFUSERS_SD_INPAINT}>
                Stable Diffusion Inpaint
              </TabsTrigger>
              <TabsTrigger value={MODEL_TYPE_OTHER}>
                Other Diffusion
              </TabsTrigger>
            </TabsList>
            <ScrollArea className="h-[240px] w-full mt-2 outline-none border rounded-lg">
              <TabsContent value={MODEL_TYPE_INPAINT}>
                {renderModelList([MODEL_TYPE_INPAINT])}
              </TabsContent>
              <TabsContent value={MODEL_TYPE_DIFFUSERS_SD}>
                {renderModelList([
                  MODEL_TYPE_DIFFUSERS_SD,
                  MODEL_TYPE_DIFFUSERS_SDXL,
                ])}
              </TabsContent>
              <TabsContent value={MODEL_TYPE_DIFFUSERS_SD_INPAINT}>
                {renderModelList([
                  MODEL_TYPE_DIFFUSERS_SD_INPAINT,
                  MODEL_TYPE_DIFFUSERS_SDXL_INPAINT,
                ])}
              </TabsContent>
              <TabsContent value={MODEL_TYPE_OTHER}>
                {renderModelList([MODEL_TYPE_OTHER])}
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </div>
      </div>
    )
  }

  const isDesktopRuntime = Boolean(desktopRuntimeInfo?.isDesktop)

  async function refreshDesktopInfo() {
    if (!desktopSupported) {
      setDesktopRuntimeInfo(null)
      setDesktopDataOverview(null)
      return
    }
    setIsLoadingDesktopData(true)
    try {
      const [runtimeInfo, overviewResult] = await Promise.all([
        getDesktopRuntimeInfo(),
        getDesktopDataOverview(),
      ])
      setDesktopRuntimeInfo(runtimeInfo)
      if (overviewResult.ok && overviewResult.overview) {
        setDesktopDataOverview(overviewResult.overview)
      } else {
        setDesktopDataOverview(null)
      }
    } catch {
      setDesktopRuntimeInfo(null)
      setDesktopDataOverview(null)
    } finally {
      setIsLoadingDesktopData(false)
    }
  }

  async function handleDesktopOpen(kind: "open_output" | "open_data") {
    setDesktopBusyAction(kind)
    try {
      const result =
        kind === "open_output"
          ? await openDesktopOutputDir()
          : await openDesktopDataDir()
      if (!result.ok) {
        throw new Error(result.error || "Failed to open directory")
      }
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: t(locale, "桌面操作失败", "Desktop action failed"),
        description: error?.message ? error.message : String(error),
      })
    } finally {
      setDesktopBusyAction(null)
    }
  }

  async function handleDesktopSetOutputDir() {
    setDesktopBusyAction("set_output")
    try {
      const result = await selectDesktopOutputDir()
      if (result.canceled) {
        return
      }
      if (!result.ok) {
        throw new Error(result.error || "Failed to set output directory")
      }
      toast({
        title: t(locale, "输出目录已更新", "Output directory updated"),
        description: result.selected
          ? t(
              locale,
              `新目录：${result.selected}`,
              `New directory: ${result.selected}`
            )
          : undefined,
      })
      await refreshDesktopInfo()
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: t(locale, "设置输出目录失败", "Failed to set output directory"),
        description: error?.message ? error.message : String(error),
      })
    } finally {
      setDesktopBusyAction(null)
    }
  }

  async function handleDesktopCleanup(target: DesktopCleanupTarget) {
    const message =
      target === "logs"
        ? t(locale, "确认清理日志？", "Confirm clear logs?")
        : target === "models"
        ? t(
            locale,
            "确认清理模型缓存并重启后端？",
            "Confirm clear model cache and restart backend?"
          )
        : t(
            locale,
            "确认清理全部应用数据并重启后端？",
            "Confirm clear app data and restart backend?"
          )
    if (!window.confirm(message)) {
      return
    }

    setDesktopBusyAction(target)
    try {
      const result = await cleanupDesktopData(target)
      if (!result.ok) {
        throw new Error(result.error || "Cleanup failed")
      }
      toast({
        title:
          target === "logs"
            ? t(locale, "日志已清理", "Logs cleared")
            : target === "models"
            ? t(locale, "模型缓存已清理", "Model cache cleared")
            : t(locale, "应用数据已清理", "App data cleared"),
        description: result.restarted
          ? t(locale, "后端已重启。", "Backend restarted successfully.")
          : undefined,
      })
      await refreshDesktopInfo()
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: t(locale, "清理失败", "Cleanup failed"),
        description: error?.message ? error.message : String(error),
      })
    } finally {
      setDesktopBusyAction(null)
    }
  }

  function renderGeneralSettings() {
    return (
      <div className="space-y-4 w-[510px]">
        <div className="space-y-2">
          <FormLabel>{t(locale, "语言", "Language")}</FormLabel>
          <Select
            value={locale}
            onValueChange={(value) => {
              changeLocale(value as AppLocale)
            }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="zh-CN">简体中文</SelectItem>
              <SelectItem value="en-US">English</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <FormField
          control={form.control}
          name="enableManualInpainting"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <div className="space-y-0.5">
                <FormLabel>
                  {t(locale, "启用手动触发擦除", "Enable manual inpainting")}
                </FormLabel>
                <FormDescription>
                  {t(
                    locale,
                    "擦除模型下，绘制蒙版后点击按钮再执行生成。",
                    "For erase model, click a button to trigger inpainting after draw mask."
                  )}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />

        <Separator />

        <FormField
          control={form.control}
          name="enableDownloadMask"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <div className="space-y-0.5">
                <FormLabel>
                  {t(locale, "同时下载蒙版", "Enable download mask")}
                </FormLabel>
                <FormDescription>
                  {t(
                    locale,
                    "保存修复结果时，同时下载蒙版图。",
                    "Also download the mask after save the inpainting result."
                  )}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />

        <Separator />

        <FormField
          control={form.control}
          name="enableAutoExtractPrompt"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <div className="space-y-0.5">
                <FormLabel>
                  {t(locale, "自动提取提示词", "Enable auto extract prompt")}
                </FormLabel>
                <FormDescription>
                  {t(
                    locale,
                    "自动从图片元数据提取 prompt / negative prompt。",
                    "Automatically extract prompt/negative prompt from image metadata."
                  )}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />

        {isDesktopRuntime ? (
          <>
            <Separator />

            <div className="space-y-2">
              <div className="font-medium">{t(locale, "目录与数据操作", "Directory & Data Actions")}</div>
              <div className="text-xs text-muted-foreground">
                {t(
                  locale,
                  "1) 设置输出目录：切换保存路径，并自动重启后端以立即生效。",
                  "1) Set Output Directory: switch save path and restart backend to take effect."
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {t(
                  locale,
                  "2) 清理日志：仅删除日志文件，不影响模型或导出图片。",
                  "2) Clear Logs: remove log files only, no model/image loss."
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {t(
                  locale,
                  "3) 清理模型缓存：删除已缓存模型并重启后端，下次使用可能重新加载模型。",
                  "3) Clear Model Cache: delete cached models, backend restarts, model may reload on next use."
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {t(
                  locale,
                  "4) 清理全部应用数据：清理日志+模型缓存，并将输出路径重置默认；你已导出的图片不会删除。",
                  "4) Clear All App Data: clear logs + model cache and reset output path to default; your exported images are kept."
                )}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  disabled={desktopBusyAction !== null}
                  onClick={() => {
                    void handleDesktopSetOutputDir()
                  }}
                >
                  {t(locale, "设置输出目录", "Set Output Directory")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={desktopBusyAction !== null}
                  onClick={() => {
                    void handleDesktopOpen("open_output")
                  }}
                >
                  {t(locale, "打开输出目录", "Open Output Folder")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={desktopBusyAction !== null}
                  onClick={() => {
                    void handleDesktopOpen("open_data")
                  }}
                >
                  {t(locale, "打开数据目录", "Open Data Folder")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={desktopBusyAction !== null}
                  onClick={() => {
                    void handleDesktopCleanup("logs")
                  }}
                >
                  {t(locale, "清理日志", "Clear Logs")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={desktopBusyAction !== null}
                  onClick={() => {
                    void handleDesktopCleanup("models")
                  }}
                >
                  {t(locale, "清理模型缓存", "Clear Model Cache")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={desktopBusyAction !== null}
                  onClick={() => {
                    void handleDesktopCleanup("all")
                  }}
                >
                  {t(locale, "清理全部应用数据", "Clear All App Data")}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <></>
        )}

        {/* <FormField
          control={form.control}
          name="enableUploadMask"
          render={({ field }) => (
            <FormItem className="flex tems-center justify-between">
              <div className="space-y-0.5">
                <FormLabel>Enable upload mask</FormLabel>
                <FormDescription>
                  Enable upload custom mask to perform inpainting.
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <Separator /> */}
      </div>
    )
  }

  function renderDataSettings() {
    if (!desktopSupported || !isDesktopRuntime) {
      return (
        <div className="w-[510px] space-y-2">
          <div className="font-medium">{t(locale, "桌面数据", "Desktop Data")}</div>
          <div className="text-sm text-muted-foreground">
            {t(
              locale,
              "仅桌面版应用支持数据管理。",
              "Data management is available in desktop app only."
            )}
          </div>
        </div>
      )
    }

    const overview = desktopDataOverview

    const renderSummaryCard = (
      title: string,
      summary:
        | {
            path: string
            fileCount: number
            dirCount: number
            totalBytes: number
            recentFiles: { name: string; size: number; mtimeMs: number }[]
          }
        | undefined
    ) => {
      return (
        <div className="rounded-md border p-3 space-y-2">
          <div className="font-medium">{title}</div>
          <div className="text-xs text-muted-foreground break-all">
            {summary?.path || "-"}
          </div>
          <div className="text-xs text-muted-foreground">
            {`${t(locale, "文件", "Files")}: ${summary?.fileCount ?? 0} | ${t(
              locale,
              "目录",
              "Folders"
            )}: ${
              summary?.dirCount ?? 0
            } | ${t(locale, "大小", "Size")}: ${formatBytes(
              summary?.totalBytes ?? 0
            )}`}
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium">
              {t(locale, "最近文件", "Recent files")}
            </div>
            {summary?.recentFiles && summary.recentFiles.length > 0 ? (
              summary.recentFiles.slice(0, 5).map((file) => (
                <div
                  key={`${title}-${file.name}-${file.mtimeMs}`}
                  className="text-xs text-muted-foreground truncate"
                  title={file.name}
                >
                  {`${file.name} · ${formatBytes(file.size)} · ${formatDateTime(
                    file.mtimeMs
                  )}`}
                </div>
              ))
            ) : (
              <div className="text-xs text-muted-foreground">
                {t(locale, "暂无文件", "No files")}
              </div>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="space-y-4 w-[510px]">
        <div className="space-y-1">
          <div className="font-medium">
            {t(locale, "桌面数据中心", "Desktop Data Center")}
          </div>
          <div className="text-sm text-muted-foreground">
            {t(
              locale,
              "查看当前数据占用，并在明确后果说明下执行清理。",
              "View current data usage and perform cleanup with clear consequences."
            )}
          </div>
          <div className="text-xs text-muted-foreground break-all">
            {t(locale, "应用数据根目录", "App Data Root")}：{" "}
            {overview?.paths.dataDir || desktopRuntimeInfo?.dataDir || "-"}
          </div>
        </div>

        {isLoadingDesktopData ? (
          <div className="text-sm text-muted-foreground">
            {t(locale, "正在加载数据概览...", "Loading data overview...")}
          </div>
        ) : (
          <div className="space-y-3">
            {renderSummaryCard(
              t(locale, "输出目录", "Output Directory"),
              overview?.output
            )}
            {renderSummaryCard(
              t(locale, "模型缓存", "Model Cache"),
              overview?.models
            )}
            {renderSummaryCard(t(locale, "日志目录", "Logs"), overview?.logs)}
          </div>
        )}

        <div className="pt-1">
          <Button
            type="button"
            variant="ghost"
            disabled={desktopBusyAction !== null || isLoadingDesktopData}
            onClick={() => {
              void refreshDesktopInfo()
            }}
          >
            {t(locale, "刷新", "Refresh")}
          </Button>
        </div>
      </div>
    )
  }

  function renderPluginsSettings() {
    return (
      <div className="space-y-4 w-[510px]">
        <FormField
          control={form.control}
          name="removeBGModel"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <div className="space-y-0.5">
                <FormLabel>Remove Background</FormLabel>
                <FormDescription>Remove background model</FormDescription>
              </div>
              <Select
                onValueChange={field.onChange}
                defaultValue={field.value}
                disabled={!removeBGEnabled}
              >
                <FormControl>
                  <SelectTrigger className="w-auto">
                    <SelectValue placeholder="Select removebg model" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent align="end">
                  <SelectGroup>
                    {serverConfig?.removeBGModels.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />

        <Separator />

        <FormField
          control={form.control}
          name="realesrganModel"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <div className="space-y-0.5">
                <FormLabel>RealESRGAN</FormLabel>
                <FormDescription>RealESRGAN Model</FormDescription>
              </div>
              <Select
                onValueChange={field.onChange}
                defaultValue={field.value}
                disabled={!realesrganEnabled}
              >
                <FormControl>
                  <SelectTrigger className="w-auto">
                    <SelectValue placeholder="Select RealESRGAN model" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent align="end">
                  <SelectGroup>
                    {serverConfig?.realesrganModels.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />

        <Separator />

        <FormField
          control={form.control}
          name="interactiveSegModel"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <div className="space-y-0.5">
                <FormLabel>Interactive Segmentation</FormLabel>
                <FormDescription>
                  Interactive Segmentation Model
                </FormDescription>
              </div>
              <Select
                onValueChange={field.onChange}
                defaultValue={field.value}
                disabled={!interactiveSegEnabled}
              >
                <FormControl>
                  <SelectTrigger className="w-auto">
                    <SelectValue placeholder="Select interactive segmentation model" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent align="end">
                  <SelectGroup>
                    {serverConfig?.interactiveSegModels.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />
      </div>
    )
  }
  // function renderFileManagerSettings() {
  //   return (
  //     <div className="flex flex-col justify-between rounded-lg gap-4 w-[400px]">
  //       <FormField
  //         control={form.control}
  //         name="enableFileManager"
  //         render={({ field }) => (
  //           <FormItem className="flex items-center justify-between gap-4">
  //             <div className="space-y-0.5">
  //               <FormLabel>Enable file manger</FormLabel>
  //               <FormDescription className="max-w-sm">
  //                 Browser images
  //               </FormDescription>
  //             </div>
  //             <FormControl>
  //               <Switch
  //                 checked={field.value}
  //                 onCheckedChange={field.onChange}
  //               />
  //             </FormControl>
  //           </FormItem>
  //         )}
  //       />

  //       <Separator />

  //       <FormField
  //         control={form.control}
  //         name="inputDirectory"
  //         render={({ field }) => (
  //           <FormItem>
  //             <FormLabel>Input directory</FormLabel>
  //             <FormControl>
  //               <Input placeholder="" {...field} />
  //             </FormControl>
  //             <FormDescription>
  //               Browser images from this directory.
  //             </FormDescription>
  //             <FormMessage />
  //           </FormItem>
  //         )}
  //       />

  //       <FormField
  //         control={form.control}
  //         name="outputDirectory"
  //         render={({ field }) => (
  //           <FormItem>
  //             <FormLabel>Save directory</FormLabel>
  //             <FormControl>
  //               <Input placeholder="" {...field} />
  //             </FormControl>
  //             <FormDescription>
  //               Result images will be saved to this directory.
  //             </FormDescription>
  //             <FormMessage />
  //           </FormItem>
  //         )}
  //       />
  //     </div>
  //   )
  // }

  return (
    <>
      <AlertDialog open={openModelSwitching}>
        <AlertDialogContent>
          <AlertDialogHeader>
            {/* <AlertDialogDescription> */}
            <div className="flex flex-col justify-center items-center gap-4">
              <div role="status">
                <svg
                  aria-hidden="true"
                  className="w-8 h-8 text-gray-200 animate-spin dark:text-gray-600 fill-primary"
                  viewBox="0 0 100 101"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z"
                    fill="currentColor"
                  />
                  <path
                    d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z"
                    fill="currentFill"
                  />
                </svg>
                <span className="sr-only">Loading...</span>
              </div>

              {modelSwitchingTexts ? (
                <div className="flex flex-col">
                  {modelSwitchingTexts.map((text, index) => (
                    <div key={index}>{text}</div>
                  ))}
                </div>
              ) : (
                <></>
              )}
            </div>
            {/* </AlertDialogDescription> */}
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <IconButton tooltip={t(locale, "设置", "Settings")}>
            <Settings />
          </IconButton>
        </DialogTrigger>
        <DialogContent
          className="max-w-3xl h-[600px] flex flex-col overflow-hidden"
          // onEscapeKeyDown={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          // onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogTitle>{t(locale, "设置", "Settings")}</DialogTitle>
          <Separator />

          <div className="flex flex-1 min-h-0 flex-row space-x-8">
            <div className="flex shrink-0 flex-col space-y-1">
              {tabNames.map((item) => (
                <Button
                  key={item}
                  variant="ghost"
                  onClick={() => setTab(item)}
                  className={cn(
                    tab === item ? "bg-muted " : "hover:bg-muted",
                    "justify-start"
                  )}
                >
                  {tabLabel(item)}
                </Button>
              ))}
            </div>
            <Separator orientation="vertical" />
            <Form {...form}>
              <form
                className="flex flex-1 min-h-0 flex-col"
                onSubmit={form.handleSubmit(onSubmit)}
              >
                <div className="min-h-0 flex-1 overflow-y-auto pr-2">
                  <div className="mx-auto w-full max-w-[540px]">
                    {tab === TAB_MODEL ? renderModelSettings() : <></>}
                    {tab === TAB_GENERAL ? renderGeneralSettings() : <></>}
                    {tab === TAB_PLUGINS ? renderPluginsSettings() : <></>}
                    {tab === TAB_DATA ? renderDataSettings() : <></>}
                    {/* {tab === TAB_FILE_MANAGER ? (
                      renderFileManagerSettings()
                    ) : (
                      <></>
                    )} */}
                  </div>
                </div>

                <div className="pt-4 flex justify-end">
                  <Button onClick={() => onOpenChange(false)}>
                    {t(locale, "确定", "Ok")}
                  </Button>
                </div>
              </form>
            </Form>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default SettingsDialog
