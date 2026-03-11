import {
  PointerEvent as ReactPointerEvent,
  SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { CursorArrowRaysIcon } from "@heroicons/react/24/outline"
import { useToast } from "@/components/ui/use-toast"
import {
  ReactZoomPanPinchContentRef,
  TransformComponent,
  TransformWrapper,
} from "react-zoom-pan-pinch"
import { useKeyPressEvent } from "react-use"
import { downloadToOutput, runPlugin } from "@/lib/api"
import { IconButton } from "@/components/ui/button"
import {
  askWritePermission,
  cn,
  copyCanvasImage,
  downloadImage,
  drawLines,
  generateMask,
  isMidClick,
  isRightClick,
  mouseXY,
  srcToFile,
} from "@/lib/utils"
import {
  ChevronsLeftRight,
  Eraser,
  Eye,
  Redo,
  Undo,
  Expand,
  Download,
} from "lucide-react"
import { useImage } from "@/hooks/useImage"
import { Slider } from "./ui/slider"
import { PluginName } from "@/lib/types"
import { useStore } from "@/lib/states"
import Cropper from "./Cropper"
import { InteractiveSegPoints } from "./InteractiveSeg"
import useHotKey from "@/hooks/useHotkey"
import Extender from "./Extender"
import {
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  SHORTCUT_KEY_CHANGE_BRUSH_SIZE,
} from "@/lib/const"

const TOOLBAR_HEIGHT = 200
interface EditorProps {
  file: File
}

export default function Editor(props: EditorProps) {
  const { file } = props
  const { toast } = useToast()

  const [
    disableShortCuts,
    windowSize,
    isInpainting,
    imageWidth,
    imageHeight,
    settings,
    enableAutoSaving,
    setImageSize,
    setBaseBrushSize,
    interactiveSegState,
    updateInteractiveSegState,
    handleCanvasMouseDown,
    handleCanvasMouseMove,
    undo,
    redo,
    undoDisabled,
    redoDisabled,
    isProcessing,
    updateAppState,
    runMannually,
    runInpainting,
    isCropperExtenderResizing,
    decreaseBaseBrushSize,
    increaseBaseBrushSize,
  ] = useStore((state) => [
    state.disableShortCuts,
    state.windowSize,
    state.isInpainting,
    state.imageWidth,
    state.imageHeight,
    state.settings,
    state.serverConfig.enableAutoSaving,
    state.setImageSize,
    state.setBaseBrushSize,
    state.interactiveSegState,
    state.updateInteractiveSegState,
    state.handleCanvasMouseDown,
    state.handleCanvasMouseMove,
    state.undo,
    state.redo,
    state.undoDisabled(),
    state.redoDisabled(),
    state.getIsProcessing(),
    state.updateAppState,
    state.runMannually(),
    state.runInpainting,
    state.isCropperExtenderResizing,
    state.decreaseBaseBrushSize,
    state.increaseBaseBrushSize,
  ])
  const baseBrushSize = useStore((state) => state.editorState.baseBrushSize)
  const brushSize = useStore((state) => state.getBrushSize())
  const renders = useStore((state) => state.editorState.renders)
  const extraMasks = useStore((state) => state.editorState.extraMasks)
  const temporaryMasks = useStore((state) => state.editorState.temporaryMasks)
  const lineGroups = useStore((state) => state.editorState.lineGroups)
  const curLineGroup = useStore((state) => state.editorState.curLineGroup)

  // Local State
  const [original, isOriginalLoaded] = useImage(file)
  const [context, setContext] = useState<CanvasRenderingContext2D>()
  const [imageContext, setImageContext] = useState<CanvasRenderingContext2D>()
  const [{ x, y }, setCoords] = useState({ x: -1, y: -1 })
  const [showBrush, setShowBrush] = useState(false)
  const [showRefBrush, setShowRefBrush] = useState(false)
  const [isPanning, setIsPanning] = useState<boolean>(false)

  const [scale, setScale] = useState<number>(1)
  const [panned, setPanned] = useState<boolean>(false)
  const [minScale, setMinScale] = useState<number>(1.0)
  const windowCenterX = windowSize.width / 2
  const windowCenterY = windowSize.height / 2
  const viewportRef = useRef<ReactZoomPanPinchContentRef | null>(null)
  // Indicates that the image has been loaded and is centered on first load
  const [initialCentered, setInitialCentered] = useState(false)

  const [isDraging, setIsDraging] = useState(false)

  const [isCompareMode, setIsCompareMode] = useState(false)
  const [comparePos, setComparePos] = useState<number>(50)
  const [isDraggingCompare, setIsDraggingCompare] = useState(false)
  const compareContainerRef = useRef<HTMLDivElement | null>(null)
  const [isChangingBrushSizeByWheel, setIsChangingBrushSizeByWheel] =
    useState<boolean>(false)

  const clampComparePos = useCallback((value: number) => {
    if (Number.isNaN(value)) {
      return 50
    }
    return Math.min(100, Math.max(0, value))
  }, [])

  const updateComparePosFromClientX = useCallback(
    (clientX: number) => {
      const rect = compareContainerRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) {
        return
      }
      const nextPos = ((clientX - rect.left) / rect.width) * 100
      setComparePos(clampComparePos(nextPos))
    },
    [clampComparePos]
  )

  const handleCompareHandlePointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      ev.preventDefault()
      ev.stopPropagation()
      setIsDraggingCompare(true)
      updateComparePosFromClientX(ev.clientX)
    },
    [updateComparePosFromClientX]
  )

  const hadDrawSomething = useCallback(() => {
    return curLineGroup.length !== 0
  }, [curLineGroup])

  useEffect(() => {
    if (
      !imageContext ||
      !isOriginalLoaded ||
      imageWidth === 0 ||
      imageHeight === 0
    ) {
      return
    }
    const render = renders.length === 0 ? original : renders[renders.length - 1]
    imageContext.canvas.width = imageWidth
    imageContext.canvas.height = imageHeight

    imageContext.clearRect(
      0,
      0,
      imageContext.canvas.width,
      imageContext.canvas.height
    )
    imageContext.drawImage(render, 0, 0, imageWidth, imageHeight)
  }, [
    renders,
    original,
    isOriginalLoaded,
    imageContext,
    imageHeight,
    imageWidth,
  ])

  useEffect(() => {
    if (
      !context ||
      !isOriginalLoaded ||
      imageWidth === 0 ||
      imageHeight === 0
    ) {
      return
    }
    context.canvas.width = imageWidth
    context.canvas.height = imageHeight
    context.clearRect(0, 0, context.canvas.width, context.canvas.height)
    temporaryMasks.forEach((maskImage) => {
      context.drawImage(maskImage, 0, 0, imageWidth, imageHeight)
    })
    extraMasks.forEach((maskImage) => {
      context.drawImage(maskImage, 0, 0, imageWidth, imageHeight)
    })

    if (
      interactiveSegState.isInteractiveSeg &&
      interactiveSegState.tmpInteractiveSegMask
    ) {
      context.drawImage(
        interactiveSegState.tmpInteractiveSegMask,
        0,
        0,
        imageWidth,
        imageHeight
      )
    }
    drawLines(context, curLineGroup)
  }, [
    temporaryMasks,
    extraMasks,
    isOriginalLoaded,
    interactiveSegState,
    context,
    curLineGroup,
    imageHeight,
    imageWidth,
  ])

  const getCurrentRender = useCallback(async () => {
    let targetFile = file
    if (renders.length > 0) {
      const lastRender = renders[renders.length - 1]
      targetFile = await srcToFile(lastRender.currentSrc, file.name, file.type)
    }
    return targetFile
  }, [file, renders])

  const hadRunInpainting = () => {
    return renders.length !== 0
  }

  const getCurrentWidthHeight = useCallback(() => {
    let width = 512
    let height = 512
    if (!isOriginalLoaded) {
      return [width, height]
    }
    if (renders.length === 0) {
      width = original.naturalWidth
      height = original.naturalHeight
    } else if (renders.length !== 0) {
      width = renders[renders.length - 1].width
      height = renders[renders.length - 1].height
    }

    return [width, height]
  }, [original, isOriginalLoaded, renders])

  // Draw once the original image is loaded
  useEffect(() => {
    if (!isOriginalLoaded) {
      return
    }

    const [width, height] = getCurrentWidthHeight()
    if (width !== imageWidth || height !== imageHeight) {
      setImageSize(width, height)
    }

    const rW = windowSize.width / width
    const rH = (windowSize.height - TOOLBAR_HEIGHT) / height

    let s = 1.0
    if (rW < 1 || rH < 1) {
      s = Math.min(rW, rH)
    }
    setMinScale(s)
    setScale(s)

    console.log(
      `[on file load] image size: ${width}x${height}, scale: ${s}, initialCentered: ${initialCentered}`
    )

    if (context?.canvas) {
      console.log("[on file load] set canvas size")
      if (width != context.canvas.width) {
        context.canvas.width = width
      }
      if (height != context.canvas.height) {
        context.canvas.height = height
      }
    }

    if (!initialCentered) {
      // 防止每次擦除以后图片 zoom 还原
      viewportRef.current?.centerView(s, 1)
      console.log("[on file load] centerView")
      setInitialCentered(true)
    }
  }, [
    viewportRef,
    imageHeight,
    imageWidth,
    original,
    isOriginalLoaded,
    windowSize,
    initialCentered,
    getCurrentWidthHeight,
  ])

  useEffect(() => {
    console.log("[useEffect] centerView")
    // render 改变尺寸以后，undo/redo 重新 center
    viewportRef?.current?.centerView(minScale, 1)
  }, [imageHeight, imageWidth, viewportRef, minScale])

  // Zoom reset
  const resetZoom = useCallback(() => {
    if (!minScale || !windowSize) {
      return
    }
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const offsetX = (windowSize.width - imageWidth * minScale) / 2
    const offsetY = (windowSize.height - imageHeight * minScale) / 2
    viewport.setTransform(offsetX, offsetY, minScale, 200, "easeOutQuad")
    if (viewport.instance.transformState.scale) {
      viewport.instance.transformState.scale = minScale
    }

    setScale(minScale)
    setPanned(false)
  }, [
    viewportRef,
    windowSize,
    imageHeight,
    imageWidth,
    windowSize.height,
    minScale,
  ])

  useEffect(() => {
    window.addEventListener("resize", () => {
      resetZoom()
    })
    return () => {
      window.removeEventListener("resize", () => {
        resetZoom()
      })
    }
  }, [windowSize, resetZoom])

  const handleEscPressed = () => {
    if (isProcessing) {
      return
    }

    if (isDraging) {
      setIsDraging(false)
    } else {
      resetZoom()
    }
  }

  useHotKey("Escape", handleEscPressed, [
    isDraging,
    isInpainting,
    resetZoom,
    // drawOnCurrentRender,
  ])

  const onMouseMove = (ev: SyntheticEvent) => {
    const mouseEvent = ev.nativeEvent as MouseEvent
    setCoords({ x: mouseEvent.pageX, y: mouseEvent.pageY })
  }

  const onMouseDrag = (ev: SyntheticEvent) => {
    if (isProcessing) {
      return
    }
    if (isCompareMode) {
      return
    }

    if (interactiveSegState.isInteractiveSeg) {
      return
    }
    if (isPanning) {
      return
    }
    if (!isDraging) {
      return
    }
    if (curLineGroup.length === 0) {
      return
    }

    handleCanvasMouseMove(mouseXY(ev))
  }

  const runInteractiveSeg = async (newClicks: number[][]) => {
    updateAppState({ isPluginRunning: true })
    const targetFile = await getCurrentRender()
    try {
      const res = await runPlugin(
        true,
        PluginName.InteractiveSeg,
        targetFile,
        undefined,
        newClicks
      )
      const { blob } = res
      const img = new Image()
      img.onload = () => {
        updateInteractiveSegState({ tmpInteractiveSegMask: img })
      }
      img.src = blob
    } catch (e: any) {
      toast({
        variant: "destructive",
        description: e.message ? e.message : e.toString(),
      })
    }
    updateAppState({ isPluginRunning: false })
  }

  const onPointerUp = (ev: SyntheticEvent) => {
    if (isCompareMode) {
      return
    }
    if (isMidClick(ev)) {
      setIsPanning(false)
      return
    }
    if (!hadDrawSomething()) {
      return
    }
    if (interactiveSegState.isInteractiveSeg) {
      return
    }
    if (isPanning) {
      return
    }
    if (!original.src) {
      return
    }
    const canvas = context?.canvas
    if (!canvas) {
      return
    }
    if (isInpainting) {
      return
    }
    if (!isDraging) {
      return
    }

    if (runMannually) {
      setIsDraging(false)
    } else {
      runInpainting()
    }
  }

  const onCanvasMouseUp = (ev: SyntheticEvent) => {
    if (isCompareMode) {
      return
    }
    if (interactiveSegState.isInteractiveSeg) {
      const xy = mouseXY(ev)
      const newClicks: number[][] = [...interactiveSegState.clicks]
      if (isRightClick(ev)) {
        newClicks.push([xy.x, xy.y, 0, newClicks.length])
      } else {
        newClicks.push([xy.x, xy.y, 1, newClicks.length])
      }
      runInteractiveSeg(newClicks)
      updateInteractiveSegState({ clicks: newClicks })
    }
  }

  const onMouseDown = (ev: SyntheticEvent) => {
    if (isProcessing) {
      return
    }
    if (isCompareMode) {
      return
    }
    if (interactiveSegState.isInteractiveSeg) {
      return
    }
    if (isPanning) {
      return
    }
    if (!isOriginalLoaded) {
      return
    }
    const canvas = context?.canvas
    if (!canvas) {
      return
    }

    if (isRightClick(ev)) {
      return
    }

    if (isMidClick(ev)) {
      setIsPanning(true)
      return
    }

    setIsDraging(true)
    handleCanvasMouseDown(mouseXY(ev))
  }

  const handleUndo = (keyboardEvent: KeyboardEvent | SyntheticEvent) => {
    keyboardEvent.preventDefault()
    undo()
  }
  useHotKey("meta+z,ctrl+z", handleUndo)

  const handleRedo = (keyboardEvent: KeyboardEvent | SyntheticEvent) => {
    keyboardEvent.preventDefault()
    redo()
  }
  useHotKey("shift+ctrl+z,shift+meta+z", handleRedo)

  useKeyPressEvent(
    "Tab",
    (ev) => {
      ev?.preventDefault()
      ev?.stopPropagation()
      if (hadRunInpainting()) {
        setIsCompareMode(true)
      }
    },
    (ev) => {
      ev?.preventDefault()
      ev?.stopPropagation()
      if (hadRunInpainting()) {
        setIsCompareMode(false)
      }
    }
  )

  const download = useCallback(async () => {
    if (file === undefined) {
      return
    }
    if (enableAutoSaving && renders.length > 0) {
      try {
        await downloadToOutput(
          renders[renders.length - 1],
          file.name,
          file.type
        )
        toast({
          description: "Save image success",
        })
      } catch (e: any) {
        toast({
          variant: "destructive",
          title: "Uh oh! Something went wrong.",
          description: e.message ? e.message : e.toString(),
        })
      }
      return
    }

    // TODO: download to output directory
    const name = file.name.replace(/(\.[\w\d_-]+)$/i, "_cleanup$1")
    const curRender = renders[renders.length - 1]
    downloadImage(curRender.currentSrc, name)
    if (settings.enableDownloadMask) {
      let maskFileName = file.name.replace(/(\.[\w\d_-]+)$/i, "_mask$1")
      maskFileName = maskFileName.replace(/\.[^/.]+$/, ".jpg")

      const maskCanvas = generateMask(imageWidth, imageHeight, lineGroups)
      // Create a link
      const aDownloadLink = document.createElement("a")
      // Add the name of the file to the link
      aDownloadLink.download = maskFileName
      // Attach the data to the link
      aDownloadLink.href = maskCanvas.toDataURL("image/jpeg")
      // Get the code to click the download link
      aDownloadLink.click()
    }
  }, [
    file,
    enableAutoSaving,
    renders,
    settings,
    imageHeight,
    imageWidth,
    lineGroups,
  ])

  useHotKey("meta+s,ctrl+s", download)

  const toggleShowBrush = (newState: boolean) => {
    if (
      newState !== showBrush &&
      !isPanning &&
      !isCropperExtenderResizing &&
      !isCompareMode
    ) {
      setShowBrush(newState)
    }
  }

  const getCursor = useCallback(() => {
    if (isProcessing) {
      return "default"
    }
    if (isCompareMode) {
      return "default"
    }
    if (isPanning) {
      return "grab"
    }
    if (showBrush) {
      return "none"
    }
    return undefined
  }, [showBrush, isPanning, isProcessing, isCompareMode])

  useEffect(() => {
    if (!isCompareMode) {
      return
    }
    setShowBrush(false)
    setShowRefBrush(false)
    setIsDraging(false)
  }, [isCompareMode])

  useHotKey(
    "[",
    () => {
      decreaseBaseBrushSize()
    },
    [decreaseBaseBrushSize]
  )

  useHotKey(
    "]",
    () => {
      increaseBaseBrushSize()
    },
    [increaseBaseBrushSize]
  )

  // Manual Inpainting Hotkey
  useHotKey(
    "shift+r",
    () => {
      if (runMannually && hadDrawSomething()) {
        runInpainting()
      }
    },
    [runMannually, runInpainting, hadDrawSomething]
  )

  useHotKey(
    "ctrl+c,meta+c",
    async () => {
      const hasPermission = await askWritePermission()
      if (hasPermission && renders.length > 0) {
        if (context?.canvas) {
          await copyCanvasImage(context?.canvas)
          toast({
            title: "Copy inpainting result to clipboard",
          })
        }
      }
    },
    [renders, context]
  )

  // Toggle clean/zoom tool on spacebar.
  useKeyPressEvent(
    " ",
    (ev) => {
      if (!disableShortCuts) {
        ev?.preventDefault()
        ev?.stopPropagation()
        setShowBrush(false)
        setIsPanning(true)
      }
    },
    (ev) => {
      if (!disableShortCuts) {
        ev?.preventDefault()
        ev?.stopPropagation()
        setShowBrush(true)
        setIsPanning(false)
      }
    }
  )

  useEffect(() => {
    const handleKeyUp = (ev: KeyboardEvent) => {
      if (ev.key === SHORTCUT_KEY_CHANGE_BRUSH_SIZE) {
        setIsChangingBrushSizeByWheel(false)
      }
    }

    const handleBlur = () => {
      setIsChangingBrushSizeByWheel(false)
    }

    window.addEventListener("keyup", handleKeyUp)
    window.addEventListener("blur", handleBlur)

    return () => {
      window.removeEventListener("keyup", handleKeyUp)
      window.removeEventListener("blur", handleBlur)
    }
  }, [])

  useEffect(() => {
    if (!isDraggingCompare) {
      return
    }

    const handlePointerMove = (ev: PointerEvent) => {
      updateComparePosFromClientX(ev.clientX)
    }

    const handlePointerUp = () => {
      setIsDraggingCompare(false)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }
  }, [isDraggingCompare, updateComparePosFromClientX])

  useKeyPressEvent(
    SHORTCUT_KEY_CHANGE_BRUSH_SIZE,
    (ev) => {
      if (!disableShortCuts) {
        ev?.preventDefault()
        ev?.stopPropagation()
        setIsChangingBrushSizeByWheel(true)
      }
    },
    (ev) => {
      if (!disableShortCuts) {
        ev?.preventDefault()
        ev?.stopPropagation()
        setIsChangingBrushSizeByWheel(false)
      }
    }
  )

  const getCurScale = (): number => {
    let s = minScale
    if (viewportRef.current?.instance?.transformState.scale !== undefined) {
      s = viewportRef.current?.instance?.transformState.scale
    }
    return s!
  }

  const getBrushStyle = (_x: number, _y: number) => {
    const curScale = getCurScale()
    return {
      width: `${brushSize * curScale}px`,
      height: `${brushSize * curScale}px`,
      left: `${_x}px`,
      top: `${_y}px`,
      transform: "translate(-50%, -50%)",
    }
  }

  const renderBrush = (style: any) => {
    return (
      <div
        className="absolute rounded-[50%] border-[1px] border-[solid] border-[#ffcc00] pointer-events-none bg-[#ffcc00bb]"
        style={style}
      />
    )
  }

  const handleSliderChange = (value: number) => {
    setBaseBrushSize(value)

    if (!showRefBrush) {
      setShowRefBrush(true)
      window.setTimeout(() => {
        setShowRefBrush(false)
      }, 10000)
    }
  }

  const renderInteractiveSegCursor = () => {
    return (
      <div
        className="absolute h-[20px] w-[20px] pointer-events-none rounded-[50%] bg-[rgba(21,_215,_121,_0.936)] [box-shadow:0_0_0_0_rgba(21,_215,_121,_0.936)] animate-pulse"
        style={{
          left: `${x}px`,
          top: `${y}px`,
          transform: "translate(-50%, -50%)",
        }}
      >
        <CursorArrowRaysIcon />
      </div>
    )
  }

  const renderCanvas = () => {
    const editedClipPath = isCompareMode
      ? `inset(0 0 0 ${comparePos}%)`
      : undefined
    const originalClipPath = `inset(0 ${100 - comparePos}% 0 0)`

    return (
      <TransformWrapper
        ref={(r) => {
          if (r) {
            viewportRef.current = r
          }
        }}
        panning={{ disabled: !isPanning, velocityDisabled: true }}
        wheel={{ step: 0.05, wheelDisabled: isChangingBrushSizeByWheel }}
        centerZoomedOut
        alignmentAnimation={{ disabled: true }}
        centerOnInit
        limitToBounds={false}
        doubleClick={{ disabled: true }}
        initialScale={minScale}
        minScale={minScale * 0.3}
        onPanning={() => {
          if (!panned) {
            setPanned(true)
          }
        }}
        onZoom={(ref) => {
          setScale(ref.state.scale)
        }}
      >
        <TransformComponent
          contentStyle={{
            visibility: initialCentered ? "visible" : "hidden",
          }}
        >
          <div
            ref={compareContainerRef}
            className="grid [grid-template-areas:'editor-content'] gap-y-4"
          >
            <canvas
              className="[grid-area:editor-content]"
              style={{
                clipPath: editedClipPath,
              }}
              ref={(r) => {
                if (r && !imageContext) {
                  const ctx = r.getContext("2d")
                  if (ctx) {
                    setImageContext(ctx)
                  }
                }
              }}
            />
            <canvas
              className={cn(
                "[grid-area:editor-content]",
                isProcessing
                  ? "pointer-events-none animate-pulse duration-600"
                  : ""
              )}
              style={{
                cursor: getCursor(),
                clipPath: editedClipPath,
              }}
              onContextMenu={(e) => {
                e.preventDefault()
              }}
              onMouseOver={() => {
                toggleShowBrush(true)
                setShowRefBrush(false)
              }}
              onFocus={() => toggleShowBrush(true)}
              onMouseLeave={() => toggleShowBrush(false)}
              onMouseDown={onMouseDown}
              onMouseUp={onCanvasMouseUp}
              onMouseMove={onMouseDrag}
              onTouchStart={onMouseDown}
              onTouchEnd={onCanvasMouseUp}
              onTouchMove={onMouseDrag}
              ref={(r) => {
                if (r && !context) {
                  const ctx = r.getContext("2d")
                  if (ctx) {
                    setContext(ctx)
                  }
                }
              }}
            />
            <div
              className="[grid-area:editor-content] pointer-events-none grid [grid-template-areas:'original-image-content'] relative"
              style={{
                width: `${imageWidth}px`,
                height: `${imageHeight}px`,
              }}
            >
              {isCompareMode && (
                <>
                  <div
                    className="[grid-area:original-image-content] z-20 h-full w-10 pointer-events-auto absolute top-0 cursor-col-resize group"
                    style={{
                      left: `${comparePos}%`,
                      transform: "translateX(-50%)",
                    }}
                    onPointerDown={handleCompareHandlePointerDown}
                  >
                    <div className="absolute left-1/2 top-0 h-full w-[3px] -translate-x-1/2 bg-primary/90 shadow-[0_0_14px_rgba(59,130,246,0.5)] group-hover:shadow-[0_0_20px_rgba(59,130,246,0.7)] transition-shadow" />
                    <div className="absolute left-1/2 top-1/2 h-[30px] w-[30px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background/95 shadow-[0_0_10px_rgba(59,130,246,0.35)] group-hover:scale-110 group-hover:shadow-[0_0_16px_rgba(59,130,246,0.65)] transition-all flex items-center justify-center">
                      <ChevronsLeftRight className="h-4 w-4 text-primary" />
                    </div>
                  </div>
                  <img
                    className="[grid-area:original-image-content]"
                    src={original.src}
                    alt="original"
                    style={{
                      width: `${imageWidth}px`,
                      height: `${imageHeight}px`,
                      clipPath: originalClipPath,
                    }}
                  />
                </>
              )}
            </div>
          </div>

          <Cropper
            maxHeight={imageHeight}
            maxWidth={imageWidth}
            minHeight={Math.min(512, imageHeight)}
            minWidth={Math.min(512, imageWidth)}
            scale={getCurScale()}
            show={settings.showCropper}
          />

          <Extender
            minHeight={Math.min(512, imageHeight)}
            minWidth={Math.min(512, imageWidth)}
            scale={getCurScale()}
            show={settings.showExtender}
          />

          {interactiveSegState.isInteractiveSeg ? (
            <InteractiveSegPoints />
          ) : (
            <></>
          )}
        </TransformComponent>
      </TransformWrapper>
    )
  }

  const handleScroll = (event: React.WheelEvent<HTMLDivElement>) => {
    // deltaY 是垂直滚动增量，正值表示向下滚动，负值表示向上滚动
    // deltaX 是水平滚动增量，正值表示向右滚动，负值表示向左滚动
    if (!isChangingBrushSizeByWheel) {
      return
    }

    const { deltaY } = event
    // console.log(`水平滚动增量: ${deltaX}, 垂直滚动增量: ${deltaY}`)
    if (deltaY > 0) {
      increaseBaseBrushSize()
    } else if (deltaY < 0) {
      decreaseBaseBrushSize()
    }
  }

  return (
    <div
      className="flex w-screen h-screen justify-center items-center"
      aria-hidden="true"
      onMouseMove={onMouseMove}
      onMouseUp={onPointerUp}
      onWheel={handleScroll}
    >
      {renderCanvas()}
      {showBrush &&
        !isInpainting &&
        !isPanning &&
        !isCompareMode &&
        (interactiveSegState.isInteractiveSeg
          ? renderInteractiveSegCursor()
          : renderBrush(getBrushStyle(x, y)))}

      {showRefBrush && renderBrush(getBrushStyle(windowCenterX, windowCenterY))}

      <div className="fixed flex bottom-5 border px-4 py-2 rounded-[3rem] gap-8 items-center justify-center backdrop-filter backdrop-blur-md bg-background/70">
        <Slider
          className="w-48"
          defaultValue={[50]}
          min={MIN_BRUSH_SIZE}
          max={MAX_BRUSH_SIZE}
          step={1}
          tabIndex={-1}
          value={[baseBrushSize]}
          onValueChange={(vals) => handleSliderChange(vals[0])}
          onClick={() => setShowRefBrush(false)}
        />
        <div className="flex gap-2">
          <IconButton
            tooltip="Reset zoom & pan"
            disabled={scale === minScale && panned === false}
            onClick={resetZoom}
          >
            <Expand />
          </IconButton>
          <IconButton
            tooltip="Undo"
            onClick={handleUndo}
            disabled={undoDisabled}
          >
            <Undo />
          </IconButton>
          <IconButton
            tooltip="Redo"
            onClick={handleRedo}
            disabled={redoDisabled}
          >
            <Redo />
          </IconButton>
          <IconButton
            tooltip={
              isCompareMode
                ? "Exit before/after compare"
                : "Enter before/after compare"
            }
            onClick={() => {
              setIsCompareMode((prev) => !prev)
            }}
            aria-pressed={isCompareMode}
            className={cn(
              isCompareMode &&
                "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
            disabled={renders.length === 0}
          >
            <Eye />
          </IconButton>
          <IconButton
            tooltip="Save Image"
            disabled={!renders.length}
            onClick={download}
          >
            <Download />
          </IconButton>

          {settings.enableManualInpainting &&
          settings.model.model_type === "inpaint" ? (
            <IconButton
              tooltip="Run Inpainting"
              disabled={
                isProcessing || (!hadDrawSomething() && extraMasks.length === 0)
              }
              onClick={() => {
                runInpainting()
              }}
            >
              <Eraser />
            </IconButton>
          ) : (
            <></>
          )}
        </div>
      </div>
    </div>
  )
}
