# Stash 项目 Image Lightbox 技术调研报告

**文档版本**: 1.0  
**调研范围**: `ui/v2.5` 中与 Image 相关的 Lightbox 实现  
**生成日期**: 2025-02-25  

---

## 1. 概述

Stash 的 Image Lightbox 是一套**全局单例**的图片/视频预览系统：通过 React Context 提供状态与打开方法，在任意子组件中可调起全屏灯箱，支持多图轮播、分页加载、章节、缩放/平移、幻灯片放映等。本报告聚焦 **Image 模块** 中的使用方式及 Lightbox 本身的技术细节。

### 1.1 核心特性摘要

| 特性 | 说明 |
|------|------|
| 架构 | Context + Provider 单例，懒加载 Lightbox 组件 |
| 数据源 | 支持内存中的 `ILightboxImage[]` 或按 Gallery 分页拉取 |
| 显示模式 | FitXy / FitX / Original，可选 scaleUp |
| 滚动模式 | 滚轮 Zoom 或 PanY，支持 Shift 临时切换 |
| 分页 | 可选 pageCallback，与列表 currentPage/pageCount 联动 |
| 章节 | 可选 chapters，按 image_index 跳转 |
| 持久化 | 部分选项存 LocalForage（imageLightbox），与服务器配置合并 |

---

## 2. 架构与文件结构

### 2.1 目录与职责

```
ui/v2.5/src/hooks/Lightbox/
├── context.tsx      # LightboxProvider、IState、useLightboxContext
├── hooks.ts         # useLightbox、useGalleryLightbox
├── types.ts         # ILightboxImage、IChapter、IImagePaths 等
├── Lightbox.tsx     # 主 UI：轮播、导航、选项、幻灯片
├── LightboxImage.tsx # 单张图/视频：缩放、平移、滚轮、触摸、双指
├── LightboxLink.tsx # 封装「点击打开 Lightbox」的链接组件
└── lightbox.scss    # 全屏层、头部/底部、轮播、导航条样式
```

- **context**：维护全局 `lightboxState`，仅在 `isVisible === true` 时渲染 `LightboxComponent`（懒加载）。
- **hooks**：`useLightbox(state, chapters)` 同步 state 到 context 并返回 `show(props)`；`useGalleryLightbox(id, chapters)` 按 gallery 分页拉图并返回 `show(index)`。
- **Lightbox.tsx**：接收 context 注入的 props + `hide()`，负责轮播索引、左右切换、页码/章节、幻灯片定时器、选项弹层、键盘/全屏等。
- **LightboxImage.tsx**：每张图的展示与交互（显示模式、缩放、PanY、滚轮/鼠标/触摸/双指），不直接依赖路由或列表。

### 2.2 挂载与作用域

- **LightboxProvider** 在 `App.tsx` 中包裹路由内容，保证全应用唯一 Lightbox 实例：

```tsx
// App.tsx
<LightboxProvider>
  {children}  // 路由等
</LightboxProvider>
```

- 样式通过 `src/index.scss` 引入：`@import "src/hooks/Lightbox/lightbox.scss";`

---

## 3. 数据模型与类型

### 3.1 ILightboxImage（types.ts）

Lightbox 单条数据与后端 Image 结构对齐，用于列表/Wall/Grid 传入或 Gallery 查询结果：

```ts
export interface ILightboxImage {
  id?: string;
  title?: GQL.Maybe<string>;
  rating100?: GQL.Maybe<number>;
  o_counter?: GQL.Maybe<number>;
  paths: IImagePaths;      // image, thumbnail, preview
  visual_files?: IFiles[]; // path, width, height, video_codec
  galleries?: GQL.Maybe<IGallery[]>;
}
```

- **paths.image**：Lightbox 内大图地址（必用）。
- **paths.preview**：有则作为导航缩略图或预览视频。
- **paths.thumbnail**：无 preview 时用作导航缩略图。
- **visual_files[0]**：宽高用于计算默认缩放与边界。

### 3.2 IState（context.tsx）

Provider 内维护的完整状态，除 `isVisible` 外均可由调用方通过 `useLightbox(state)` 或 `show(props)` 注入/覆盖：

```ts
export interface IState {
  images: ILightboxImage[];
  isVisible: boolean;
  isLoading: boolean;
  showNavigation: boolean;
  initialIndex?: number;
  pageCallback?: (props: { direction?: number; page?: number }) => void;
  chapters?: IChapter[];
  page?: number;
  pages?: number;
  pageSize?: number;
  slideshowEnabled: boolean;
  onClose?: () => void;
}
```

- **pageCallback**：翻到当前页首/末时由 Lightbox 调用，用于分页列表（如 Image 列表）加载上一页/下一页。
- **chapters**：`IChapter[]`，含 `id, title, image_index`，用于章节菜单跳转。

---

## 4. Image 模块中的 Lightbox 使用方式

### 4.1 ImageList / ImageListImages（核心入口）

- **位置**: `ui/v2.5/src/components/Images/ImageList.tsx`
- **触发场景**: Grid 或 Wall 下点击单张图，或通过 `onPreview` 打开。
- **数据**: 当前页的 `result.data.findImages.images` 作为 `images`，与列表分页一致。

**状态构造**（与分页、幻灯片开关、关闭回调绑定）：

```tsx
const lightboxState = useMemo(() => ({
  images,
  showNavigation: false,
  pageCallback: pageCount > 1 ? handleLightBoxPage : undefined,
  page: filter.currentPage,
  pages: pageCount,
  pageSize: filter.itemsPerPage,
  slideshowEnabled: slideshowRunning,
  onClose: handleClose,
}), [images, pageCount, filter.currentPage, filter.itemsPerPage, ...]);

const showLightbox = useLightbox(
  lightboxState,
  filter.sortBy === "path" && filter.sortDirection === GQL.SortDirectionEnum.Asc
    ? chapters
    : []
);

const handleImageOpen = useCallback((index) => {
  setSlideshowRunning(true);
  showLightbox({ initialIndex: index, slideshowEnabled: true });
}, [showLightbox, setSlideshowRunning]);
```

- **handleLightBoxPage**：在 Lightbox 内翻到第一张再向左或最后一张再向右时，调用 `onChangePage` 切换列表的 `currentPage`，并可能清空/重设 `images`，Lightbox 通过 `pageCallback` 与 `isSwitchingPage` 配合完成跨页。
- **chapters**：仅当排序为 `path` 且升序时传入，用于图库章节导航。
- Grid 的 `onPreview`、Wall 的 `onClick` 最终都调用 `handleImageOpen(index)`，从而 `showLightbox({ initialIndex, slideshowEnabled: true })`。

### 4.2 其他使用 Image Lightbox 的入口

- **GalleryViewer**：`useLightbox(lightboxState)`，无分页，直接传当前 gallery 下全部 images。
- **Gallery 详情页**：`useGalleryLightbox(gallery.id, gallery.chapters)`，按需分页拉取该 gallery 的 images，`show(index)` 可带起始索引并触发请求。
- **GalleryWallCard**：同一 `useGalleryLightbox`，点击封面或某张时 `showLightbox(0)` / `showLightbox(i)`。
- **LightboxLink**：通用「链接式」打开，接收 `images` 与可选 `index`，子组件点击即 `showLightbox({ images, initialIndex: index })`，在 Performers、Groups 等详情中用于「打开该组图片」。
- **Tagger**：`useLightbox` 传入单张 sprite 等，用于预览当前场景图。

---

## 5. 打开与显示流程

### 5.1 useLightbox(state, chapters) 流程

1. **useEffect**：将 `state` 中 `images, showNavigation, pageCallback, page, pages, pageSize, slideshowEnabled, onClose` 同步到 context（不包含 `isVisible`）。
2. **返回值**：`show(props: Partial<IState>)`。
3. 调用方执行 `show({ initialIndex, slideshowEnabled, ... })` 时，context 的 `setLightboxState` 被调用，合并 `isVisible: true` 以及 `page/pages/pageSize/chapters`（未传则用 state 中已有值）。
4. Provider 中 `lightboxState.isVisible` 为 true，渲染懒加载的 `LightboxComponent`，并传入 `...lightboxState` 与 `hide`。

### 5.2 useGalleryLightbox(id, chapters) 流程

1. 内部维护 `page`、用 `useFindImagesLazyQuery` 按 `galleries: [id]`、`page`、`per_page` 请求。
2. **show(index)**：
   - 若 `index > pageSize`，先算页号并 `setPage`，再 `index = index % pageSize`。
   - 若已有 `data`：直接 `setLightboxState` 当前页 images + 分页信息 + `initialIndex`。
   - 若无 `data`：先 `setLightboxState({ isLoading: true, isVisible: true, ... })`，再 `fetchGallery()`，等请求完成后在 useEffect 里再次 `setLightboxState` 填入 images。
3. 翻到边界时通过 `pageCallback` 与内部 `page` 联动，实现跨页。

### 5.3 关闭与 onClose

- 用户点击关闭或按 Escape 时，Lightbox 内调用 `hide()`。
- Provider 的 `onHide` 中：`setLightboxState({ ...lightboxState, isVisible: false })`，并执行 `lightboxState.onClose()`。
- ImageList 的 `handleClose` 即 `setSlideshowRunning(false)`，用于关闭时停止「幻灯片」状态。

---

## 6. Lightbox 主组件（Lightbox.tsx）技术要点

### 6.1 Props 与状态

- **入参**：来自 context 的 `images, isVisible, isLoading, initialIndex, showNavigation, slideshowEnabled, page, pages, pageSize, pageCallback, chapters, hide`。
- **内部重要状态**：
  - `index`：当前展示的图片下标（0-based），`null` 表示尚未从 `initialIndex` 初始化。
  - `zoom`：全局缩放倍数，切换图或选项变化时可按配置 `resetZoomOnNav` 重置为 1。
  - `resetPosition`：布尔翻转，用于通知 LightboxImage 重新居中/复位。
  - `slideshowInterval`：幻灯片间隔（ms），`null` 表示未开启。
  - `instantTransition`：禁用动画（如配置 `disableAnimation` 或键盘连按方向键）。
  - `isSwitchingPage`：跨页加载中，避免重复触发 pageCallback。

### 6.2 轮播与分页

- 轮播区为水平 100vw 一格的横向列表，`style={{ left: currentIndex * -100 }}vw`，仅渲染 `currentIndex ± 1` 的 `LightboxImage` 以节省 DOM。
- **handleLeft / handleRight**：
  - 若在当前页首/末且存在 `pageCallback`，则调用 `pageCallback({ direction: -1|1 })`，并设 `isSwitchingPage=true`、`oldImages.current=images`，索引置 -1 或 0 等待新数据。
  - 否则仅在当前 `images` 内增减 `index`，支持首尾循环（无 pageCallback 时）。
- 新 `images` 到达后由 useEffect 检测 `isSwitchingPage` 与 `index`，结束切换状态。

### 6.3 键盘与全屏

- **handleKey**：左/右箭头切图（连按时 `setInstant()` 去动画），Escape 关闭。
- 打开时 `document.body.style.overflow = "hidden"`，`Mousetrap.pause()`；关闭时恢复并 `Mousetrap.unpause()`。
- 全屏通过 `containerRef.current?.requestFullscreen()` / `document.exitFullscreen()`，监听 `fullscreenchange` 同步 `isFullscreen` 并清理定时器。

### 6.4 幻灯片

- `useInterval(callback, slideshowEnabled ? slideshowInterval : null)`，到点调用 `handleRight(false)`。
- 用户手动左右切换时通过 `resetIntervalCallback.current()` 重置计时。
- 页面不可见时（`usePageVisibility`）会停止幻灯片，避免后台翻页。

### 6.5 配置与持久化

- **配置来源**（合并顺序）：
  - 服务端：`useConfigurationContext().configuration?.interface?.imageLightbox`（如 slideshowDelay、scrollAttemptsBeforeChange、disableAnimation）。
  - 本地：`useInterfaceLocalForage().data?.imageLightbox`（Lightbox 内修改的项会写回 LocalForage）。
- **Lightbox 内可改项**（会调用 `setLightboxSettings` 写入 LocalForage）：
  - displayMode、scaleUp、resetZoomOnNav、scrollMode、slideshowDelay、scrollAttemptsBeforeChange、disableAnimation（后两项若仅服务端有则只读）。
- 默认 displayMode：`FitXy`；默认 scrollMode：`Zoom`。

### 6.6 底部导航条

- 展示当前页所有图片的缩略图（preview 或 thumbnail），当前项高亮，点击 `selectIndex(e, i)` 跳转。
- 多页时显示页码与章节信息，章节下拉可 `gotoPage(image_index)`，内部会算页号并调用 `pageCallback({ page })` 再设 `index`。

---

## 7. LightboxImage 组件技术要点

### 7.1 显示模式（DisplayMode）

- **FitXy**：适应容器宽高，取 min(宽比, 高比) 作为默认 zoom；可选不放大（scaleUp=false）。
- **FitX**：按宽度适应，高度可滚动/平移。
- **Original**：以 1:1 显示，不自动缩放。

默认 zoom 在 `calculateDefaultZoom()` 中按 displayMode、scaleUp、容器与图片尺寸计算；切换 displayMode 时通过 `resetPosition` 触发重新居中。

### 7.2 滚动模式（ScrollMode）与滚轮行为

- **Zoom**：滚轮改变缩放（`setZoom(zoom * percent)`），percent 由 deltaY 与 ZOOM_FACTOR / ZOOM_STEP 推导；支持「无限滚」（触控板小步）与「离散步进」。
- **PanY**：滚轮上下平移 positionY，边界处可与切换图片联动（见下）。
- **Shift + 滚轮**：临时切换当前 scrollMode（Zoom ↔ PanY）。

### 7.3 切换图片的滚轮逻辑（scrollAttemptsBeforeChange）

- 在 PanY 下，当已到顶/底继续滚轮时，会进入「尝试切换图」逻辑：
  - **有限滚动**：需连续同向滚动次数达到 `scrollAttemptsBeforeChange` 才真正 `onLeft()`/`onRight()`，否则只增加/减少 `scrollAttempts.current`。
  - **无限滚动**：按 `SCROLL_GROUP_THRESHOLD` 的 deltaY 累计判断，避免一次小滚动就换图。
- 常量：`SCROLL_GROUP_THRESHOLD=8`，`SCROLL_GROUP_EXIT_THRESHOLD=4`，`SCROLL_INFINITE_THRESHOLD=10`。

### 7.4 鼠标与触摸

- **鼠标**：mousedown 记录起点，mousemove 时若 buttons 按下则平移 positionX/Y；mouseup 时若为短时、同点则视为点击，按左右半区调用 onLeft/onRight。
- **单指触摸**：touchstart 记起点，touchmove 更新 positionX/Y。
- **双指**：PointerEvent 缓存，根据两指距离变化计算缩放并 `setZoom`，同时可平移。

### 7.5 视频

- 若 `visual_files[0]` 含 video_codec 或路径为视频，则用 `<video>` 渲染；否则 `<img>`。
- 仅当该张为当前显示且位于视口内时自动播放，否则暂停（通过 getBoundingClientRect 与 clientWidth 判断）。

---

## 8. 配置项与 GraphQL 枚举

### 8.1 服务端 / 接口配置（config.graphql）

- **ImageLightboxDisplayMode**：ORIGINAL | FIT_XY | FIT_X  
- **ImageLightboxScrollMode**：ZOOM | PAN_Y  
- **ConfigImageLightboxInput/Result**：slideshowDelay, displayMode, scaleUp, resetZoomOnNav, scrollMode, scrollAttemptsBeforeChange, disableAnimation  

这些会通过 `ConfigDataFragment` 的 `interface.imageLightbox` 下发给前端，并与 LocalForage 中的 `imageLightbox` 合并使用。

### 8.2 设置界面

- **SettingsInterfacePanel**：提供 Image Lightbox 区块，可配置显示模式、scaleUp、resetZoomOnNav、滚动模式、幻灯片延迟、scrollAttemptsBeforeChange、disableAnimation 等，并写入接口配置（同步到服务端或本地，依项目逻辑）。

---

## 9. 依赖与扩展点

### 9.1 主要依赖

- **react**：useState、useEffect、useCallback、useRef、Context、Suspense
- **react-bootstrap**：Button、Form、Overlay、Popover、Dropdown 等
- **Mousetrap**：全局快捷键 pause/unpause
- **localforage**：通过 `useInterfaceLocalForage` 持久化 imageLightbox
- **Stash 内部**：GQL 生成类型、useConfigurationContext、useToast、RatingSystem、OCounterButton、useImageUpdate、useFindImagesLazyQuery 等

### 9.2 插件 API（pluginApi）

- 对外暴露 `useLightbox`、`useGalleryLightbox`、`LightboxLink`、`LightboxComponent` 等，便于插件在自定义页面中打开同一套 Lightbox。

---

## 10. 小结与注意事项

1. **单例性**：全应用共用一个 Lightbox 实例，任何一次 `show()` 都会替换 context 中的 images 与分页/章节状态，因此多列表/多入口共享时需注意 state 来源与 pageCallback 对应关系。
2. **Image 列表分页**：ImageList 的 `pageCallback` 与 `filter.currentPage/pageCount/itemsPerPage` 严格绑定，保证翻到边界时加载上一页/下一页并更新 `images`，Lightbox 用 `isSwitchingPage` 与索引 -1/0 处理过渡。
3. **章节**：仅当 Image 列表按 path 升序排序时传入 chapters，其他场景（如 Gallery）由调用方自行传入 chapters。
4. **性能**：轮播只渲染 currentIndex±1 的 LightboxImage；导航条使用 thumbnail/preview 且 loading="lazy"；大图使用 paths.image。
5. **无障碍与键鼠**：Escape 关闭、左右键切换、全屏 API、点击背景关闭（className 包含 Lightbox-image 的容器）等，需与产品需求一致以免误关。

---

**报告结束。** 若需对某一块（如 LightboxImage 的精确坐标计算、双指手势或与 Scene/Gallery 的差异）做更细的代码级说明，可在此基础上按文件/函数补充。
