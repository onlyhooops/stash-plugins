# Image Wall 无限滚动与懒加载插件 — 技术纲要

**目标**：通过 Stash UI 插件，为 Image 模块的 **Wall（预览墙）** 视图增加**无限滚动**、**懒加载**等类瀑布流能力，在保持现有缩放、多选、Lightbox 等行为的前提下，避免分页点击、实现随滚动自动加载更多页。

**文档版本**: 1.0  
**编写日期**: 2025-02-25  

---

## 1. 目标与范围

### 1.1 功能目标

| 能力 | 说明 |
|------|------|
| **无限滚动** | 用户滚动至墙底部附近时，自动请求并追加下一页数据，无需点击分页控件。 |
| **懒加载（分页维度）** | 首屏仅加载第 1 页；后续页按需拉取并追加到当前列表。 |
| **图片懒加载（保持）** | 保留现有 `loading="lazy"` 等行为，新追加的图片同样采用懒加载。 |
| **类瀑布流** | 延续现有 `react-photo-gallery` 的砌墙布局与 zoom 档位，不改变视觉形态，仅改变数据加载方式。 |

### 1.2 非目标（保持与主应用一致）

- 不改变 Wall 的缩放滑块、行高/列宽逻辑、margin/direction 配置。
- 不改变多选、框选、Lightbox、键盘快捷键等交互。
- 不替换 Grid/List 等其他显示模式，仅针对 **DisplayMode.Wall**。

### 1.3 约束

- 以 **Stash UI 插件** 方式实现，使用官方 **PluginApi**（patch、components、utils、hooks 等），不修改 Stash 主仓库代码。
- 插件为实验性能力，需兼容当前 Stash 版本并考虑 API 变更风险。

---

## 2. 现状与扩展点

### 2.1 当前 Wall 数据与分页

- **数据来源**：`useFindImages(filter)`，filter 含 `currentPage`、`itemsPerPage`（默认 40）。
- **渲染链**：`ImageList` → `ImageListImages`（根据 `filter.displayMode`）→ 当 Wall 时渲染 `ImageWall`，传入**当前页**的 `images`、`onChangePage`、`currentPage`、`pageCount` 等。
- **布局**：`ImageWall` 将当前页 `images` 转为 `react-photo-gallery` 的 `photos`，用 `Gallery` + 自定义 `columns`/`targetRowHeight`/`renderImage`（`ImageWallItem`）砌墙。
- **分页**：底部 `PagedList` 提供翻页；Wall 与 Grid 共用同一套分页状态。

因此，要实现「无限滚动」，必须在 **Wall 模式** 下改为：**累积多页数据 + 滚动到底时请求下一页**，而不是只展示单页并依赖分页控件。

### 2.2 可用的插件扩展方式

- **ImageList** 已在 Stash 中注册为可 patch 组件（`PatchComponent("ImageList")`），见 `pluginApi.d.ts` / UIPluginApi 文档中的 Patchable 列表。
- 可用 **PluginApi.patch.instead("ImageList", fn)** 用自定义实现**替换**整个 ImageList 的渲染；fn 签名为 `(props, next) => ReactNode`，可在内部调用 `next(props)` 得到默认渲染，或完全自行渲染。
- 若仅做 **包装** 而不重写整棵树，也可考虑 **patch.after** 对渲染结果做二次包装（但难以只替换 Wall 分支而不拿到内部 state），故推荐以 **patch.instead** 控制 Wall 分支为可维护方案。

### 2.3 需要复用的主应用能力

- **Filter / 列表状态**：与主应用一致使用 `ListFilterModel`、URL 同步、筛选条件等，需在插件内通过同一套 **ItemList / useFilteredItemList** 的用法拿到 `filter`、`setFilter`、`result`（或等价数据源）。
- **数据请求**：使用 **PluginApi.utils.StashService.queryFindImages(filter)** 做按页请求（filter 的 `currentPage` 设为 2、3… 即可请求对应页）。
- **UI 与交互**：复用 **PluginApi.components** 中的 `ImageWallItem`、`ImageCardGrid`、工具栏、分页等；**PluginApi.hooks.useLightbox**；配置来自 **useConfigurationContext**（zoom、margin、direction 等）。
- **布局库**：Wall 仍使用 **react-photo-gallery** 的 `Gallery`；若主应用未在 PluginApi.libraries 暴露，需在插件内单独依赖或通过 loadableComponents/components 使用。

---

## 3. 总体方案

### 3.1 策略选择

- **方案 A（推荐）**：**patch.instead("ImageList", …)**  
  - 在插件中实现一个 **替代用 ImageList**（下文称 **PluginImageList**），其 props 与主应用 `ImageList` 一致（如 `filterHook`、`view`、`alterQuery`、`extraOperations`、`chapters`）。
  - 内部复用主应用的 **ItemList / useFilteredItemList / useFindImages** 等（通过 PluginApi 暴露的 StashService、components、hooks），保证筛选、URL、工具栏、多选、导出等行为一致。
  - **仅当 `filter.displayMode === DisplayMode.Wall` 时**，不渲染主应用的 `ImageWall` + 分页栏，改为渲染 **InfiniteImageWall**（见 3.2）；其余模式（Grid 等）仍调用 **next(props)** 或直接使用主应用原有逻辑，避免重复实现。

- **方案 B**：仅 patch **ImageListImages** 或更底层组件。  
  - 当前 Stash 未将 `ImageListImages` 列入 Patchable，若不对主仓库提 PR 增加 patch 点，则不可行；故不采用。

### 3.2 核心组件：InfiniteImageWall

- **职责**：在 Wall 模式下，替代原先「单页 ImageWall + PagedList」的组合，实现「累积多页 + 触底加载」。
- **输入**（与现有 ImageWall 对齐并扩展）：
  - `filter`、`setFilter`（用于构造请求用 filter 及可选的状态更新）；
  - 首页数据可来自父组件已有的 `result.data.findImages`（第 1 页），或由本组件自行请求第 1 页；
  - `zoomIndex`、`handleImageOpen`、`selectedIds`、`onSelectChange`、`selecting` 等与现有 ImageWall 一致；
  - 配置：`margin`、`direction` 等从 `useConfigurationContext().configuration?.ui?.imageWallOptions` 读取。
- **内部状态**：
  - `accumulatedImages: SlimImageDataFragment[]`：已加载的图片列表（按页顺序拼接）。
  - `page: number`：下一待加载页（1-based）；首屏后为 2、3…
  - `hasMore: boolean`：是否还有更多页（根据 `totalCount` 与 `itemsPerPage` 计算）。
  - `loading: boolean`：是否正在请求下一页（避免重复请求）。
- **行为**：
  1. 挂载时若有首页数据则使用，否则用 `queryFindImages(filter)` 请求第 1 页，初始化 `accumulatedImages`、`page`、`hasMore`。
  2. 将 `accumulatedImages` 转为 `photos` 并交给 **Gallery** + **ImageWallItem**（与现有 ImageWall 相同的 columns/targetRowHeight/renderImage 逻辑），保持 zoom、margin、direction 一致。
  3. 在墙底部放置一个 **哨兵元素**（sentinel），使用 **IntersectionObserver** 监听其进入视口；当 sentinel 可见且 `hasMore && !loading` 时，以 `filter.currentPage = page` 调用 **StashService.queryFindImages**，将返回的 `images` 追加到 `accumulatedImages`，`page += 1`，并根据 `count` 更新 `hasMore`。
  4. 图片节点继续使用 `loading="lazy"`（或由 ImageWallItem 保持现有行为），实现图片维度的懒加载。
- **Lightbox 索引**：当前主应用 `handleImageOpen(index)` 的 index 为当前页内索引；在累积多页后应改为**全局索引**（在 `accumulatedImages` 中的下标），以便 Lightbox 与无限列表一致。

### 3.3 与主应用结构的衔接

- **PluginImageList** 需与主应用 **ImageList** 使用相同的 **ItemList**（或等价布局）：同一 toolbar、同一 filter 状态、同一 `renderContent(result, filter, ...)` 签名；仅在 `renderContent` 内部对 Wall 分支做替换：
  - 原逻辑：`displayMode === Wall` 时渲染 `<ImageWall images={result.data.findImages.images} ... />` 及下方 PagedList。
  - 新逻辑：`displayMode === Wall` 时渲染 `<InfiniteImageWall filter={filter} setFilter={setFilter} firstPageResult={result} ... />`，不再渲染 PagedList（或仅在「兼容模式」下保留分页栏由用户选择）。
- 这样 **filter**、**result**（第 1 页）、**onChangePage**、**selectedIds**、**onSelectChange** 等均可从 ItemList 的 renderContent 参数中获得，无需重复请求第一页（也可选择由 InfiniteImageWall 自行请求第一页以统一逻辑）。

---

## 4. 技术要点

### 4.1 数据请求

- **按页请求**：  
  `filter` 为 `ListFilterModel`，克隆后设置 `currentPage: page`、保持 `itemsPerPage`（如 40），调用  
  `PluginApi.utils.StashService.queryFindImages(filterClone)`  
  得到 `FindImagesQuery` 结果，取 `result.data.findImages.images` 与 `result.data.findImages.count`。
- **totalCount**：用于计算 `hasMore = (page - 1) * itemsPerPage < totalCount`；首页可从 `result.data.findImages.count` 取得，后续页可沿用或从每次请求的 count 字段更新。

### 4.2 滚动与触底

- 使用 **IntersectionObserver** 观察墙底部的 sentinel（如 `<div ref={sentinelRef} style={{ height: 1 }} />`），root 为 Wall 的滚动容器（或 document viewport），threshold 可设为 0 或较小值（如 0.1）。
- 当 sentinel 进入视口且 `hasMore && !loading` 时触发「加载下一页」：`queryFindImages` → 追加 `accumulatedImages` → `page++`，并更新 `hasMore`。
- 注意：若 Wall 放在可滚动容器内，observer 的 **root** 应为该容器，避免与主布局滚动混淆。

### 4.3 布局与样式

- **Gallery**：继续使用 `react-photo-gallery` 的 `Gallery`，传入与现有 ImageWall 相同的 `columns(containerWidth)`、`targetRowHeight(containerWidth)`、`margin`、`direction`、`renderImage`（委托给 **PluginApi.components.ImageWallItem** 或插件内同构实现）。
- **zoomWidths / breakpointZoomHeights**：与主应用保持一致（见《Image-Wall与缩放滑块技术调研报告》），以保证缩放档位一致。
- 样式：插件可通过 **ui.css** 注入类名，避免与主应用冲突（如 `.infinite-image-wall-sentinel`）；必要时用 CSS 保证 sentinel 在墙底部且不占高视觉空间。

### 4.4 依赖与加载

- 使用 **PluginApi.hooks.useLoadComponents** 预加载：  
  `[PluginApi.loadableComponents.ImageList, PluginApi.loadableComponents.ImageWallItem, ...]`  
  若 loadableComponents 中有更细粒度入口（如 Scenes、Images 等），按需加入，确保 Gallery、ImageWallItem、StashService 可用。
- **react-photo-gallery**：若未通过 PluginApi.libraries 暴露，需在插件包内单独依赖并打包进 **ui.javascript**，或确认主应用是否通过某 namespace 暴露。

### 4.5 可选：保留分页栏的「兼容模式」

- 可在插件设置中增加选项，例如「Wall 无限滚动：开/关」。
- 当「关」时，Wall 仍使用主应用默认行为（单页 + 分页栏）；当「开」时，使用 InfiniteImageWall 并隐藏或弱化分页栏。  
  实现方式：在 PluginImageList 的 renderContent 中根据插件配置或 filter 的 customCriteria 决定走哪条分支。

---

## 5. 实现步骤建议

1. **插件脚手架**  
   - 新建插件目录，配置 **pluginName.yml**，填写 `name`、`ui.javascript`、`ui.css`（可选）；确认 **PluginApi** 在脚本加载后可用。

2. **预加载与 patch 注册**  
   - 在插件入口脚本中调用 **useLoadComponents**（或在挂载的组件内调用）加载 ImageList、ImageWallItem 等；  
   - 使用 **PluginApi.patch.instead("ImageList", YourImageList)** 注册替换实现。

3. **实现 PluginImageList**  
   - 与主应用 ImageList 相同的 props 类型与默认值；  
   - 内部使用 **ItemList** + **useFindImages**（或等价）拿到 `filter`、`result`、`setFilter`、分页等；  
   - `renderContent` 中：若 `displayMode !== Wall`，直接调用原 **ImageList** 的渲染逻辑（可通过保存的 next 引用），若为 Wall 则渲染 **InfiniteImageWall**。

4. **实现 InfiniteImageWall**  
   - 状态：`accumulatedImages`、`page`、`hasMore`、`loading`；  
   - 首屏：用 `firstPageResult` 或 `queryFindImages(filter)` 初始化；  
   - 底部 sentinel + IntersectionObserver，触底时 `queryFindImages` 追加；  
   - 使用 **Gallery** + **ImageWallItem** 渲染墙，保持 zoom/margin/direction 与主应用一致；  
   - 处理 **handleImageOpen** 的 index 为全局索引。

5. **样式与体验**  
   - 为 sentinel、加载中状态（如底部 loading 条）添加 **ui.css** 样式；  
   - 可选：在加载下一页时显示小型 loading 指示器（如 **PluginApi.components.LoadingIndicator**）。

6. **测试与兼容**  
   - 在 Images 列表页切换到 Wall，验证无限滚动、懒加载、Lightbox、多选、zoom 滑块、URL 与筛选条件；  
   - 验证 Grid 等其他模式未被破坏；  
   - 在不同 itemsPerPage、不同筛选条件下检查 totalCount 与 hasMore 是否正确。

---

## 6. 风险与注意点

- **API 稳定性**：PluginApi 与 patch 行为为实验性，Stash 升级后可能需适配。
- **ListFilterModel / 请求接口**：filter 结构或 FindImages 查询字段变更会导致插件需同步修改。
- **性能**：累积页数过多时（如数百页），可考虑虚拟列表或「窗口化」只渲染可见区域，本纲要先采用「全量追加」以简化实现，后续可再优化。
- **路由与 filter 同步**：无限滚动下若用户修改筛选条件，应重置 `accumulatedImages` 与 `page`（如监听 filter 的 criteria/itemsPerPage 等变化）。

---

## 7. 参考文档

- 《Image-Wall与缩放滑块技术调研报告》— 本仓库  
- 《插件开发规范与UI插件可用接口调研报告》— 本仓库  
- Stash 应用内手册：UIPluginApi.md、Plugins.md  
- 源码：`ui/v2.5/src/components/Images/ImageList.tsx`、`ImageWallItem.tsx`，`List/util.ts`，`core/StashService.ts`  

---

**文档结束。**
