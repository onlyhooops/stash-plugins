# Stash 项目插件开发规范与 UI 插件可用接口调研报告

**文档版本**: 1.0  
**调研范围**: 插件开发规范、UI 类插件可用的原生方法/接口与约束  
**生成日期**: 2025-02-25  

---

## 1. 概述与状态说明

Stash 支持多种插件形态：

- **任务类插件**：在「任务」页或通过 **Hooks**（如 Scene.Create.Post）触发，可用嵌入式 JavaScript 或外部二进制。
- **UI 类插件**：通过配置中的 **ui.css** 与 **ui.javascript** 向界面注入样式与脚本，在**浏览器同一上下文中**运行，并可通过全局 **PluginApi** 使用 Stash 暴露的原生方法、组件与扩展点。

> **⚠️ 官方说明**：插件支持仍为 **实验性**，可能在不另行通知的情况下发生变更。UI Plugin API 的详细说明见手册 `UIPluginApi.md`，示例见源码 `pkg/plugin/examples/react-component`。

本报告在官方文档与源码基础上，归纳**插件开发相关规范**，并**明确 UI 类插件可直接使用的原生方法、命名空间与组件**，便于开发 UI 插件时查阅。

---

## 2. 插件配置规范（与 UI 相关部分）

### 2.1 插件配置文件

- **位置**：默认在 `config.yml` 所在目录下的 `plugins` 子目录（如 `$HOME/.stash/plugins`），每个插件一个 yml 文件（如 `pluginName.yml`）。
- **安装方式**：设置 → Plugins 中从「可用插件」安装，或手动将 yml 放入 plugins 目录后点击「Reload Plugins」。

### 2.2 UI 配置块结构

```yaml
ui:
  css:
    - <path to css file>   # 相对插件配置目录或完整 URL
  javascript:
    - <path to javascript file>
  requires:
    - <plugin ID>          # 需先加载的插件 ID
  assets:
    urlPrefix: fsLocation  # /plugin/{id}/assets/urlPrefix -> 插件目录下 fsLocation
  csp:
    script-src:
      - https://alloweddomain.com
    style-src:
      - https://alloweddomain.com
    connect-src:
      - https://alloweddomain.com
```

- **css / javascript**：路径可为相对插件配置文件的路径或完整 URL；多个文件按配置顺序加载；仅当插件 **enabled** 且路径存在时才会被加载。
- **requires**：当前插件的 JS/CSS 会在所列插件之后加载，用于依赖顺序。
- **assets**：静态资源通过 `/plugin/{pluginID}/assets/...` 暴露，映射规则见官方手册；用于图片、字体等，CSP 需允许时可在 csp 中配置。
- **csp**：用于放宽内容安全策略，允许插件脚本/样式/请求访问的域名。

### 2.3 加载顺序与执行环境

- 前端通过 **PluginsLoader** 拉取已启用插件的 `paths.javascript` 与 `paths.css`，去重、按依赖排序后：
  - CSS 通过 `useCSS` 注入页面；
  - JavaScript 通过 `useScript` 以**脚本标签**方式在**同一 window** 中执行。
- 因此 UI 插件脚本执行时，**window.PluginApi** 已存在，可直接使用下面列出的所有命名空间与方法。

---

## 3. UI 插件可直接使用的全局对象：PluginApi

所有以下内容均在 **window.PluginApi**（或脚本中的 `PluginApi`）上，UI 插件脚本可直接访问。

### 3.1 顶层属性

| 属性 | 说明 |
|------|------|
| **React** | 与主应用一致的 React 实例 |
| **ReactDOM** | ReactDOM 实例 |
| **GQL** | 生成的 GraphQL 客户端命名空间（useXxxQuery、useXxxMutation、refetchXxx 等）；低层接口，多数场景建议用 **utils.StashService** |

### 3.2 libraries（UI 库）

插件可直接使用以下库，无需自行打包：

- **ReactRouterDOM**（如 useHistory、Link、Route、NavLink 等）
- **Bootstrap**（react-bootstrap：Button、Form、Modal、Nav、Tab 等）
- **Apollo**（@apollo/client）
- **Intl**（react-intl）
- **FontAwesomeRegular** / **FontAwesomeSolid** / **FontAwesomeBrands**
- **ReactFontAwesome**（@fortawesome/react-fontawesome）
- **Mousetrap**、**MousetrapPause**（快捷键）
- **ReactSelect**（react-select）
- **ReactSlick**（@ant-design/react-slick）

使用方式示例：`const { Button, Nav, Tab } = PluginApi.libraries.Bootstrap;`

### 3.3 register（注册扩展）

| 方法 | 签名 | 说明 |
|------|------|------|
| **register.route** | `(path: string, component: React.FC) => void` | 注册一条 React Router 路由；path 建议使用 `/plugin/` 前缀，component 为函数组件 |
| **register.component** | `(name: string, component: React.FC) => void` | 将组件注册到 **PluginApi.components**，name 建议以 `plugin-` 为前缀且唯一 |

### 3.4 components（可用组件）

**PluginApi.components** 包含 Stash 内置的、可供插件直接引用的组件集合（以及通过 register.component 注册的插件组件）。以下为源码/类型定义中暴露的部分，**UI 插件可直接使用**（具体 props 需参考 UI 源码或类型）：

- **通用/布局**：Icon、LoadingIndicator、TruncatedText、HoverPopover、GridCard、RecommendationRow、DetailImage、HeaderImage、BackgroundImage、PluginSettings 等
- **表单/设置**：ModalSetting、Setting、SettingGroup、SettingModal、StringSetting、NumberSetting、BooleanSetting、SelectSetting、StringListSetting、ChangeButtonSetting、ConstantSetting、DateInput、ImageInput、CountrySelect、FolderSelect、CustomFieldInput、CustomFields 等
- **导航/列表**：FilteredSceneList、FilteredGalleryList、SceneList、GalleryList、GroupList、PerformerList、StudioList、TagList、ImageList 等
- **卡片与详情**：SceneCard、SceneCard.Details/Image/Overlays/Popovers、PerformerCard 及同名子组件、StudioCard、TagCard 及同名子组件、GalleryCard、GroupCard、ImageCard、ImageCardGrid 等
- **选择器**：PerformerSelect、PerformerIDSelect、StudioSelect、StudioIDSelect、TagSelect、TagIDSelect、GallerySelect、GalleryIDSelect、GroupSelect、GroupIDSelect、SceneSelect、SceneIDSelect 等
- **场景/播放**：ScenePlayer、ScenePage、ScenePage.Tabs/TabContent、SceneFileInfoPanel、SceneMarkersPanel、QueueViewer、ExternalPlayerButton 等
- **导航栏**：MainNavBar.MenuItems、MainNavBar.UtilityItems
- **其他**：LightboxLink、RatingSystem、RatingStars、RatingNumber、SweatDrops、TabTitleCounter、ExternalLinkButtons、ExternalLinksButton、PerformerDetailsPanel、StudioDetailsPanel、PerformerAppearsWithPanel、SceneCardGrid、SceneMarkerCard 等

完整列表以 **pluginApi.d.ts** 中 `PluginApi.components` 的类型定义为准；插件内通过 `PluginApi.components.<ComponentName>` 使用。

### 3.5 utils（工具与服务）

| 成员 | 说明 |
|------|------|
| **utils.NavUtils** | 生成各类列表/详情 URL：makePerformerScenesUrl、makeTagUrl、makeSceneMarkerUrl、makeGalleryImagesUrl、makeStudioScenesUrl 等 |
| **utils.StashService** | 数据与后端交互：queryFindScenes、queryFindImages、useFindScenes、useFindGallery、mutateSceneUpdate、useConfigureUI、useDirectory 等查询/变更与配置相关方法；多数场景应优先使用此处而非直接 GQL |
| **utils.loadComponents** | `(components: (() => Promise<unknown>)[]) => Promise<void>`，用于按需加载下面 **loadableComponents** 中的懒加载模块；一般配合 **hooks.useLoadComponents** 使用 |
| **utils.InteractiveUtils** | interactiveClientProvider、getPlayer 等，用于与 Handy/互动脚本等集成 |

### 3.6 hooks（React Hooks）

以下 Hooks 可在插件函数组件中直接使用（需在 React 组件树内调用）：

| Hook | 说明 |
|------|------|
| **hooks.useLoadComponents** | `(toLoad: (() => Promise<unknown>)[]) => boolean`，加载 loadableComponents 中的模块，返回是否仍在 loading |
| **hooks.useToast** | 返回 `{ toast, success(message), error(error) }`，用于提示 |
| **hooks.useSettings** | 返回设置上下文：general、interface、ui、plugins、saveUI、savePluginSettings 等 |
| **hooks.useSpriteInfo** | `(vttPath: string | undefined)`，返回 sprite 信息（url、start、end、x、y、w、h） |
| **hooks.useInteractive** | 返回 interactive 客户端、state、initialise、uploadScript、sync 等（Handy/互动脚本） |
| **hooks.useLightbox** | 打开 Lightbox，与主应用一致 |
| **hooks.useGalleryLightbox** | 按 gallery id 打开 Lightbox |

### 3.7 loadableComponents（懒加载入口）

由于主应用做了代码分割，部分页面/组件在插件路由首次渲染时可能尚未加载。插件应通过 **loadableComponents** 传入 **utils.loadComponents** 或 **hooks.useLoadComponents** 进行预加载，再从 **components** 使用对应组件。

**loadableComponents** 中包括（部分列举）：

- 页面级：Performers、FrontPage、Scenes、Settings、Stats、Studios、Galleries、Groups、Tags、Images、Scene、SceneCreate、SceneList、SceneMarkerList 等
- 组件级：SceneCard、PerformerCard、PerformerSelect、TagLink、ScenePlayer、LightboxComponent、GalleryViewer、DeleteScenesDialog、GenerateDialog、各 Scene 详情面板、ExternalPlayerButton、QueueViewer 等

使用示例：`PluginApi.hooks.useLoadComponents([PluginApi.loadableComponents.SceneCard, PluginApi.loadableComponents.PerformerSelect]);` 加载完成后再从 `PluginApi.components` 取 SceneCard、PerformerSelect 使用。

### 3.8 patch（扩展/替换组件行为）

插件可对 Stash 内置组件的「渲染」进行拦截或替换，无需改主应用代码：

| 方法 | 说明 |
|------|------|
| **patch.before** | `(componentName, fn)`：在组件渲染前执行，fn 接收与组件相同的 props，返回新的 props 数组，将作为后续渲染的入参 |
| **patch.instead** | `(componentName, fn)`：用自定义实现替代渲染；fn 接收 (props, ..., originalFn)，可调用 originalFn 再包装或完全替换；同一组件仅会有一个 instead 生效（后注册覆盖前） |
| **patch.after** | `(componentName, fn)`：在组件渲染后执行，fn 接收 (props, ..., result)，返回新的 React 节点（可包装或替换 result） |

**componentName** 为字符串，需与 **Patchable 组件名** 一致（见下节）。示例：`PluginApi.patch.before("MainNavBar.UtilityItems", function(props) { ... });`

### 3.9 Patchable 组件名（可 patch 的组件）

以下名称可用于 **PluginApi.patch.before / instead / after**（完整列表见 UIPluginApi.md 与 patch 注册处）：

- 通用：AlertModal、App、BackgroundImage、BooleanSetting、ChangeButtonSetting、ConstantSetting、CountrySelect、CustomFieldInput、CustomFields、DateInput、DetailImage、ExternalLinkButtons、ExternalLinksButton、FilteredGalleryList、FilteredSceneList、FolderSelect、FrontPage、HeaderImage、HoverPopover、Icon、LoadingIndicator、ModalSetting、NumberSetting、PerformerAppearsWithPanel、PluginRoutes、PluginSettings、RatingNumber、RatingStars、RatingSystem、RecommendationRow、SelectSetting、Setting、SettingGroup、SettingModal、StringListSetting、StringSetting、TruncatedText 等
- 卡片与列表：SceneCard、SceneCard.Details/Image/Overlays/Popovers、PerformerCard 及子组件、StudioCard、TagCard 及子组件、GalleryCard 及子组件、GroupCard、ImageCard、SceneCardGrid、SceneList、GalleryList、GroupList、PerformerList、StudioList、TagList、ImageCard 等
- 选择器：PerformerSelect、PerformerIDSelect、StudioSelect、TagSelect、GallerySelect、GroupSelect、SceneSelect、SceneIDSelect、GalleryIDSelect、GroupIDSelect、TagIDSelect、StudioIDSelect 等
- 场景/页面：ScenePage、ScenePage.Tabs、ScenePage.TabContent、ScenePlayer、SceneFileInfoPanel、SceneMarkerCard 等
- 导航：MainNavBar.MenuItems、MainNavBar.UtilityItems

具体以 **patch 系统实际注册的名称** 为准（见 `patch.tsx` 与文档）。

### 3.10 Event（事件）

- **PluginApi.Event.addEventListener(type, listener)**：监听 Stash 派发的事件。
- 已知类型示例：**stash:location**（路由/页面变化），payload 在 `e.detail.data`（如 `location.pathname`、`location.search`）。

---

## 4. 数据与配置：StashService 与 GQL

- **PluginApi.utils.StashService** 提供：
  - 各类 **queryXxx**、**useFindXxx**、**useXxxMutation** 等（与主应用 StashService 一致），用于查询/变更 Scenes、Images、Galleries、Performers、Studios、Tags、Groups、Configuration、Plugins、Jobs、Scrapers 等；
  - **useConfigurePlugin**、**useConfigureUI**、**useDirectory** 等配置与工具方法。
- **PluginApi.GQL** 提供生成的 GraphQL 文档与 useXxx/refetchXxx 等，适合需要细粒度或未在 StashService 封装的场景；一般推荐优先用 **StashService**。

插件可通过 **hooks.useSettings()** 读/写 UI 配置（含 saveUI、savePluginSettings），通过 **useConfigurePlugin** 读写插件自身 settings（与配置文件中 settings 块对应）。

---

## 5. 约束与注意事项

1. **实验性**：插件 API 可能随版本变更，升级 Stash 后需验证插件行为。
2. **单页上下文**：UI 插件脚本与主应用共享同一 window、React 树和路由，避免覆盖全局变量或与主应用冲突。
3. **CSP**：若插件加载外部脚本、样式或请求外部域名，须在插件配置的 **ui.csp** 中声明相应 script-src、style-src、connect-src 等，否则可能被浏览器拦截。
4. **路由**：自定义页面建议使用 **register.route** 注册 `/plugin/` 前缀路径，避免与内置路由冲突。
5. **组件名**：**register.component** 的 name 建议带 `plugin-` 前缀且唯一；**patch** 的 componentName 必须与 Stash 已注册的 Patchable 名称完全一致。
6. **懒加载**：使用 SceneCard、PerformerSelect 等通过 loadableComponents 暴露的组件前，应先 **useLoadComponents** 或 **loadComponents**，再从 **PluginApi.components** 引用。
7. **类型**：TypeScript 类型见 **pluginApi.d.ts**；若插件用 TypeScript 开发，可参考该文件与 `pkg/plugin/examples/react-component` 示例。

---

## 6. 参考与示例

- **手册**：`ui/v2.5/src/docs/en/Manual/Plugins.md`、`UIPluginApi.md`、`EmbeddedPlugins.md`、`ExternalPlugins.md`。
- **API 实现**：`ui/v2.5/src/pluginApi.tsx`（挂载到 window）、`pluginApi.d.ts`（类型声明）。
- **插件加载**：`ui/v2.5/src/plugins.tsx`（PluginsLoader、依赖排序、useScript/useCSS）。
- **示例**：`pkg/plugin/examples/react-component`（React 组件、路由注册、patch、useLoadComponents、Lightbox、Event 等）。

---

## 7. 小结表：UI 插件可用的原生方法/接口速查

| 分类 | 内容 |
|------|------|
| 全局 | `PluginApi.React`、`PluginApi.ReactDOM`、`PluginApi.GQL` |
| 库 | `PluginApi.libraries.*`（Bootstrap、ReactRouterDOM、Apollo、Intl、FontAwesome*、Mousetrap、ReactSelect、ReactSlick 等） |
| 注册 | `PluginApi.register.route(path, component)`、`PluginApi.register.component(name, component)` |
| 组件 | `PluginApi.components.<Name>`（见 3.4 与 pluginApi.d.ts） |
| 工具 | `PluginApi.utils.NavUtils`、`PluginApi.utils.StashService`、`PluginApi.utils.loadComponents`、`PluginApi.utils.InteractiveUtils` |
| Hooks | `PluginApi.hooks.useLoadComponents`、`useToast`、`useSettings`、`useSpriteInfo`、`useInteractive`、`useLightbox`、`useGalleryLightbox` |
| 懒加载 | `PluginApi.loadableComponents.<Name>` + `loadComponents` / `useLoadComponents` |
| 扩展 UI | `PluginApi.patch.before`、`patch.instead`、`patch.after`（参数：Patchable 组件名 + 函数） |
| 事件 | `PluginApi.Event.addEventListener(type, listener)`（如 stash:location） |

以上均为 **UI 类插件在浏览器环境中可直接使用的原生方法、命名空间与组件**；具体函数签名、返回值及 Patchable 完整列表以源码与 `pluginApi.d.ts`、UIPluginApi.md 为准。

---

**报告结束。**
