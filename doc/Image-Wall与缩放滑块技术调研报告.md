# Stash 项目 Image 模块 Wall（预览墙）与缩放滑块技术调研报告

**文档版本**: 1.0  
**调研范围**: Image 列表的 Wall 视图实现、滑块控制缩放逻辑及相关配置  
**生成日期**: 2025-02-25  

---

## 1. 概述

Image 模块的 **Wall（预览墙）** 是一种以「砌墙」方式展示当前页图片的视图模式，与 Grid（网格）、List 等并列，由用户通过工具栏的显示模式切换。墙的**视觉缩放**由 **zoomIndex**（0～3）控制，通过**滑块**（及键盘 `+`/`-`）调节，实现「小图多列」与「大图少列」的连续档位。本报告说明 Wall 的组件结构、布局库、数据流，以及滑块与 zoomIndex 如何驱动墙的列宽与行高。

### 1.1 核心结论摘要

| 项目 | 说明 |
|------|------|
| 视图入口 | `filter.displayMode === DisplayMode.Wall` 时渲染 `ImageWall` |
| 布局引擎 | `react-photo-gallery` 的 `Gallery`，自定义 `columns` / `targetRowHeight` / `renderImage` |
| 单格渲染 | `ImageWallItem`，支持 row/column 两种方向、多选、点击打开 Lightbox |
| 缩放维度 | zoomIndex 同时控制「列宽」与「行高」，列宽查表、行高按断点+zoomIndex 查表 |
| 滑块与状态 | `ZoomSelect`（range 0～3）与 `filter.zoomIndex` 绑定，通过 `filter.setZoom` 更新并同步 URL |

---

## 2. 架构与文件结构

### 2.1 相关文件与职责

```
ui/v2.5/src/
├── components/Images/
│   ├── ImageList.tsx         # ImageWall 定义、zoomWidths/breakpointZoomHeights、Gallery 调用
│   └── ImageWallItem.tsx     # 单张墙格：尺寸计算、row/column 布局、多选、点击
├── components/List/
│   ├── ZoomSlider.tsx        # ZoomSelect（range）、useZoomKeybinds（+/-）
│   ├── ListViewOptions.tsx   # 显示模式下拉/按钮组，内嵌 ZoomSelect 显示条件
│   ├── FilteredListToolbar.tsx # 工具栏，传 zoomable/zoomIndex/onSetZoom
│   ├── ItemList.tsx          # zoomable 判定、useZoomKeybinds、传 setZoom
│   ├── util.ts               # useFilterOperations → setZoom(filter.setZoom)
│   └── styles.scss           # .zoom-slider-container / .zoom-slider 样式、xs 隐藏
├── models/list-filter/
│   ├── filter.ts             # ListFilterModel：zoomIndex、setZoom、URL z 参数
│   └── images.ts             # ImageListFilterOptions：displayModeOptions = [Grid, Wall]
└── utils/
    └── imageWall.ts          # ImageWallDirection、ImageWallOptions、默认 margin/direction
```

- **ImageList.tsx**：根据 `filter.displayMode` 在 Grid / Wall 间分支；Wall 时渲染 `ImageWall`，并传入 `filter.zoomIndex`、当前页 `images`、分页与 Lightbox 回调等。
- **ImageWall**：将 `images` 转成 `react-photo-gallery` 所需的 `photos`，实现 `columns(containerWidth)`、`targetRowHeight(containerWidth)` 和 `renderImage`，再交给 `Gallery`。
- **ImageWallItem**：接收 Gallery 传入的 `RenderImageProps` 与 Stash 扩展的 `maxHeight`、选中相关 props，计算显示宽高，支持 `direction === "row"` 与 `"column"` 两种布局。
- **ZoomSlider / ListViewOptions / FilteredListToolbar / ItemList**：共同完成「滑块 UI → filter.zoomIndex → 持久化与 URL」的闭环。

### 2.2 显示模式与 zoom 的显示条件

- **Image 列表**的 `displayModeOptions` 仅为 `[DisplayMode.Grid, DisplayMode.Wall]]`（见 `images.ts`），因此只有网格与墙两种视图。
- **zoomable** 在 `ItemList` 中定义为：当前为 Grid 或 Wall 时为 true，此时工具栏会显示缩放滑块并绑定 `filter.zoomIndex` 与 `setZoom`。
- 滑块在 **ListViewOptions**（下拉）与 **ListViewButtonGroup**（按钮组）中均存在：仅当 `onSetZoom` 存在、`zoomIndex !== undefined` 且 `displayMode` 为 Grid 或 Wall 时渲染 `ZoomSelect`。
- 小屏（xs breakpoint）下通过 CSS 隐藏 `.zoom-slider-container`，避免移动端误触。

---

## 3. Wall 视图实现细节

### 3.1 数据转换：images → photos

`ImageWall` 将当前页的 `GQL.SlimImageDataFragment[]` 转为 `react-photo-gallery` 的 `photos` 数组：

```ts
photos.push({
  src: image.paths.preview != "" ? image.paths.preview! : image.paths.thumbnail!,
  width: image.visual_files?.[0]?.width ?? 0,
  height: image.visual_files?.[0]?.height ?? 0,
  tabIndex: index,
  key: image.id,
  loading: "lazy",
  className: "gallery-image",
  alt: objectTitle(image),
});
```

- **src**：优先 preview（动图/视频预览），否则 thumbnail。
- **width/height**：来自 `visual_files[0]`，用于 Gallery 的布局计算；缺省为 0 时由库或自定义 render 处理。
- **key**：image.id，用于 React 与选中状态（selectedIds.has(imageId)）。

### 3.2 布局引擎：react-photo-gallery 的 Gallery

- **依赖**：`react-photo-gallery@^8.0.0`，组件为 `Gallery`，类型 `RenderImageProps` 来自同库。
- **传入 props**：
  - **photos**：上述数组。
  - **renderImage**：自定义渲染函数，返回 `ImageWallItem`，并注入 `maxHeight`、`selectedIds`、`onSelectChange`、`selecting`。
  - **onClick**：`showLightboxOnClick`，参数 `(event, { index })`，调用 `handleImageOpen(index)` 打开 Lightbox。
  - **margin**：来自 `uiConfig?.imageWallOptions?.margin`，默认在 `imageWall.ts` 为 3。
  - **direction**：来自 `uiConfig?.imageWallOptions?.direction`，`ImageWallDirection.Row` 或 `Column`，默认 Row。
  - **columns**：函数 `(containerWidth: number) => number`，见下节。
  - **targetRowHeight**：函数 `(containerWidth: number) => number`，见下节。

Gallery 根据 `columns` 与 `targetRowHeight`（以及 direction）计算每张图在墙上的位置与尺寸，再对每格调用 `renderImage`。

### 3.3 列数与行高：zoomIndex 的作用

**列数（横向缩放）**：

```ts
const zoomWidths = [280, 340, 480, 640];  // 对应 zoomIndex 0,1,2,3

function columns(containerWidth: number) {
  let preferredSize = zoomWidths[zoomIndex];
  let columnCount = containerWidth / preferredSize;
  return Math.round(columnCount);
}
```

- **zoomIndex 越大** → preferredSize 越大 → 列数越少 → 单列越宽，视觉上「放大」。
- **zoomIndex 越小** → 列数越多 → 单列越窄，视觉上「缩小」。

**行高（纵向缩放）**：

```ts
const breakpointZoomHeights = [
  { minWidth: 576,  heights: [100, 120, 240, 360] },
  { minWidth: 768,  heights: [120, 160, 240, 480] },
  { minWidth: 1200, heights: [120, 160, 240, 300] },
  { minWidth: 1400, heights: [160, 240, 300, 480] },
];

const targetRowHeight = useCallback((containerWidth: number) => {
  let zoomHeight = 280;
  breakpointZoomHeights.forEach((e) => {
    if (containerWidth >= e.minWidth) zoomHeight = e.heights[zoomIndex];
  });
  return zoomHeight;
}, [zoomIndex]);
```

- 按**容器宽度**选择断点，再取该断点下 **heights[zoomIndex]** 作为目标行高。
- **zoomIndex 越大** → 行高越大 → 单张图在垂直方向显示得越大。
- 不同断点下同一 zoomIndex 对应不同行高，以适配不同屏幕（如大屏更大行高）。

### 3.4 单格最大高度与 ImageWallItem 尺寸

- **maxHeight** 在 `renderImage` 中计算：
  - **direction === "column"**：使用 `props.photo.height`（不限制）。
  - **direction === "row"**：`targetRowHeight(containerRef.current?.offsetWidth ?? 0) * maxHeightFactor`，其中 **maxHeightFactor = 1.3**，允许单格略高于目标行高，避免数量少时单图过高。

**ImageWallItem 内尺寸**：

```ts
const height = Math.min(props.maxHeight, props.photo.height);
const zoomFactor = height / props.photo.height;
const width = props.photo.width * zoomFactor;
```

- 先按 maxHeight 和原图高度取较小值作为显示高度，再按比例算出 width，保持纵横比。
- 布局方式：
  - **row**：`position: relative`，流式排列，由 Gallery 控制整体行高。
  - **column**：`position: absolute`，使用 `props.left` / `props.top` 做绝对定位（由 Gallery 计算）。

### 3.5 交互与多选

- **点击**：未在多选状态下点击 → 调用 `onClick(event, { index })`，即打开 Lightbox；多选状态下点击 → 切换当前项选中并支持 shift 多选。
- **多选**：通过 `useDragMoveSelect` 支持框选；勾选框与 `selectedIds`、`onSelectChange` 联动。
- **媒体类型**：若 `photo.src` 含 "preview" 则用 `<video>` 渲染（loop/muted/playsInline/autoPlay），否则 `<img>`。

---

## 4. 滑块控制缩放的技术细节

### 4.1 zoomIndex 的存储与来源

- **模型**：`ListFilterModel`（`filter.ts`）上有 `zoomIndex: number`，默认 1；构造时可传 `defaultZoomIndex`。
- **更新**：`filter.setZoom(zoomIndex)` 返回新 clone 的 filter，并设 `ret.zoomIndex = zoomIndex`。
- **持久化**：
  - **URL**：`getEncodedParams()` 中若 `zoomIndex !== defaultZoomIndex` 则输出 `z: String(zoomIndex)`，`makeQueryParameters()` 会拼成 `z=...`；`configureFromDecodedParams` / `decodeParams` 从 `params.z` 读回。
  - **保存的 UI 选项**：`makeSavedUIOptions()` 包含 `zoom_index: this.zoomIndex`，用于保存筛选器或恢复界面。

### 4.2 ZoomSelect 组件（ZoomSlider.tsx）

```tsx
const minZoom = 0;
const maxZoom = 3;

<Form.Control
  className="zoom-slider"
  type="range"
  min={minZoom}
  max={maxZoom}
  value={zoomIndex}
  onChange={(e) => onChangeZoom(Number.parseInt(e.currentTarget.value, 10))}
/>
```

- **范围**：0～3 整数，与 `zoomWidths`、`breakpointZoomHeights[*].heights` 的 4 档一致。
- **受控**：`value={zoomIndex}` 来自 `filter.zoomIndex`，`onChangeZoom` 在 ItemList 中为 `(zoom) => updateFilter(filter.setZoom(zoom))`，即更新 filter 并触发列表与 URL 更新。

### 4.3 键盘快捷键 useZoomKeybinds

- **绑定**：`+` 增加 zoomIndex（若未达 maxZoom），`-` 减少（若未达 minZoom）。
- **使用处**：`ItemList` 在 `zoomable` 为 true 时传入 `zoomIndex` 与 `onChangeZoom`；仅在 Grid/Wall 下生效，与滑块一致。
- **实现**：Mousetrap 在 useEffect 中 bind/unbind，避免影响其他页面。

### 4.4 从工具栏到 filter 的完整链路

1. **FilteredListToolbar** 通过 `useFilterOperations({ filter, setFilter })` 得到 `setZoom`，并将 `zoomable ? filter.zoomIndex : undefined`、`zoomable ? setZoom : undefined` 传给 **ListViewButtonGroup**。
2. **ListViewButtonGroup** 在 Grid 或 Wall 时渲染 **ZoomSelect**，`zoomIndex={zoomIndex}`，`onChangeZoom={onSetZoom}`。
3. **ItemList** 中 `zoomable = filter.displayMode === DisplayMode.Grid || filter.displayMode === DisplayMode.Wall`，并传入 `zoomable` 给 FilteredListToolbar；同时 **useZoomKeybinds** 使用 `filter.zoomIndex` 与 `(zoom) => updateFilter(filter.setZoom(zoom))`。
4. 用户拖动滑块或按 `+`/`-` → `setZoom(newZoom)` → `setFilter(cv => cv.setZoom(newZoom))` → filter 更新 → ImageList 的 `renderContent` 用新 `filter` 渲染，`ImageWall` 收到新 `filter.zoomIndex` → `columns` / `targetRowHeight` 依赖 zoomIndex，墙的布局重新计算并渲染。

---

## 5. Image Wall 专属配置（设置页）

- **位置**：设置 → Interface → Image Wall 区块（SettingsInterfacePanel）。
- **项**：
  - **margin**：数字，对应 `ui.imageWallOptions.margin`，默认 `defaultImageWallMargin = 3`（来自 `imageWall.ts`）。
  - **direction**：下拉，`ImageWallDirection.Row` | `Column`，对应 `ui.imageWallOptions.direction`，默认 `defaultImageWallDirection = ImageWallDirection.Row`。
- **存储**：通过 `saveImageWallMargin` / `saveImageWallDirection` 更新 `ui.imageWallOptions`，并持久化到后端或本地配置；ImageWall 通过 `useConfigurationContext().configuration?.ui` 读取。

---

## 6. Image Wall 边距控制技术（补充）

本节专门说明 Wall 视图中 **margin（边距）** 从配置、持久化到渲染的完整技术链。

### 6.1 数据定义与默认值

- **类型**：`src/utils/imageWall.ts` 中定义 `ImageWallOptions` 含 `margin: number` 与 `direction: ImageWallDirection`。
- **默认边距**：`defaultImageWallMargin = 3`（数值，无单位时在 CSS 中按 **像素 px** 使用）。
- **默认选项**：`defaultImageWallOptions = { margin: defaultImageWallMargin, direction: defaultImageWallDirection }`。

前端配置类型 `IUIConfig`（`src/core/config.ts`）中有 `imageWallOptions?: ImageWallOptions`，与上述一致。

### 6.2 设置页 UI 与保存

- **位置**：设置 → Interface → **Image Wall** 区块（`SettingsInterfacePanel.tsx`，headingID `config.ui.image_wall.heading`）。
- **边距控件**：使用 `NumberSetting`，无单独 min/max/step，通过 `NumberField` 的 `parseInt(..., 10)` 得到整数。
  - `value={ui.imageWallOptions?.margin ?? defaultImageWallMargin}`
  - `onChange={(v) => saveImageWallMargin(v)}`
- **保存函数**（同文件内）：
  ```ts
  function saveImageWallMargin(m: number) {
    saveUI({
      imageWallOptions: {
        ...(ui.imageWallOptions ?? defaultImageWallOptions),
        margin: m,
      },
    });
  }
  ```
  即只更新 `imageWallOptions.margin`，保留现有 `direction`；若 `imageWallOptions` 为空则用默认对象再覆盖 margin。

### 6.3 持久化链路（后端与配置合并）

- **saveUI**：Settings 上下文中 `saveUI(input: Partial<IUIConfig>)` 将 `input` 合并进本地 state 的 `ui`，并放入 `pendingUI`，经防抖后调用 `updateUIConfig({ variables: { partial: input } })`。
- **ConfigureUI 变更**：GraphQL 为 `configureUI(input: Map, partial: Map)`，前端只传 `partial`。后端在 `resolver_mutation_configure.go` 中：
  - 若 `partial != nil`，则 `existing := c.GetUIConfiguration()`，`utils.MergeMaps(existing, partial)`，再 `c.SetUIConfiguration(existing)` 并 `c.Write()`。
  - 即 **margin 被合并进全局 UI 配置对象并写入配置文件**，键为 `imageWallOptions.margin`（或后端等价的嵌套结构）。
- **配置读取**：应用侧通过 `configuration.ui` 拿到整份 UI 配置（ConfigResult 的 `ui` 字段为 UIConfig 标量/Map），其中包含 `imageWallOptions`；Settings 页初次加载时 `setUI(data.configuration.ui)`，故设置页与 Wall 视图读的是同一份数据源。

### 6.4 从配置到 Gallery 与单格

- **ImageWall** 内通过 `useConfigurationContext().configuration?.ui` 得到 `uiConfig`，再传：
  ```tsx
  <Gallery
    margin={uiConfig?.imageWallOptions?.margin!}
    direction={uiConfig?.imageWallOptions?.direction!}
    ...
  />
  ```
  即 **margin 数值直接传给 `react-photo-gallery` 的 `Gallery`**。
- **Gallery 行为**：库根据 `margin` 在布局计算中为相邻照片之间（及可能的外缘）预留间距，并在调用 `renderImage` 时把该间距通过 **RenderImageProps** 传给每一格（常见为 `props.margin`）。
- **ImageWallItem** 使用方式：
  ```ts
  var divStyle: style = {
    margin: props.margin,
    display: "block",
    position: "relative",
  };
  ```
  即 **每个墙格根节点 div 的 CSS `margin` 设为 `props.margin`**。在 CSS 中未指定单位时，数字会当作 **px**，因此 **边距单位为像素**。

### 6.5 小结（边距）

| 环节 | 说明 |
|------|------|
| 默认值 | 3（px） |
| 设置入口 | 设置 → Interface → Image Wall → margin（NumberSetting） |
| 存储 | `ui.imageWallOptions.margin`，经 saveUI → ConfigureUI(partial) 合并写入后端配置 |
| 读取 | `configuration.ui.imageWallOptions.margin`，由 ImageWall 传给 Gallery |
| 应用 | Gallery 布局使用该值；ImageWallItem 根 div 的 `style.margin` 为同一数值（px） |

若需限制范围（如 0～20）或步长，需在设置页或 NumberField 层增加校验与约束；当前实现未在 UI 层做 min/max 校验。

---

## 7. 样式与响应式

### 7.1 滑块样式（List/styles.scss）

- **.zoom-slider-container**：flex 居中、上下边距、最小高度，用于包裹滑块。
- **.zoom-slider**：`input[type="range"]`，主题色 thumb/track，max-width 约 60px。
- **xs 断点**：`@include media-breakpoint-down(xs)` 时 `.display-mode-menu .zoom-slider-container` 与 `.zoom-slider-container` 设为 `display: none`，即小屏隐藏缩放滑块。

### 7.2 Wall 容器与墙格

- **ImageWall** 根节点为 `<div className="gallery" ref={containerRef}>`，Gallery 与 flexbin 相关样式可能来自 `flexbin.css`（ImageList 顶部 import）。
- **ImageWallItem** 根节点为 `<div className="wall-item" style={divStyle}>`，具体样式可能分布在 components 或全局 scss 中，本报告未逐一列举。

---

## 8. 与 Grid 的对比及复用

- **同一 filter**：Grid 与 Wall 共用 `filter.zoomIndex`；Grid 下卡片尺寸通过 `zoomWidths` 与 `useCardWidth(containerWidth, zoomIndex, zoomWidths)` 等逻辑计算，与 Wall 的 zoomWidths 含义一致（均为「偏好宽度」档位）。
- **显示模式**：Image 仅支持 Grid 与 Wall，故 zoom 滑块仅在两种模式间保持同一状态；切换 displayMode 不会重置 zoomIndex。
- **数据与分页**：Wall 与 Grid 使用同一套 `findImages` 结果与分页（currentPage、pageCount、itemsPerPage），仅展示形态不同。

---

## 9. 小结与注意点

1. **Wall 实现**：依赖 `react-photo-gallery` 的 Gallery，通过自定义 `columns`、`targetRowHeight` 和 `renderImage`（ImageWallItem）实现砌墙布局；row/column 方向与间距由 `imageWallOptions` 控制。
2. **缩放本质**：zoomIndex 不直接缩放 DOM，而是改变「列数」与「行高」的查表结果，从而间接控制每张图的显示尺寸；列数 = round(containerWidth / zoomWidths[zoomIndex])，行高 = 断点表[zoomIndex]。
3. **滑块与状态**：滑块和键盘 `+`/`-` 统一更新 `filter.zoomIndex`，经 setFilter 驱动重渲染与 URL 持久化；滑块仅在 Grid/Wall 且非 xs 时显示。
4. **扩展**：若需新增 zoom 档位，需同时修改 `zoomWidths`、`breakpointZoomHeights` 各断点的 `heights` 数组长度，以及 ZoomSlider 的 `maxZoom`（和可能的默认 defaultZoomIndex）。

---

**报告结束。**
