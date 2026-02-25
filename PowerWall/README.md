# PowerWall

Stash 原生风格的**砌墙视图**插件：在图片/短片列表页提供列优先递补布局、等比例缩放的墙视图，支持无限滚动与内置 Lightbox。

## 功能

- **砌墙布局**：列优先递补（最短列放置），缩略图等比例缩放、无剪裁无拉伸
- **6 档缩放**：滑块调节列宽（160～640px），仅滑块无文字
- **布局预设**：紧凑 / 标准 / 宽松（边距、行距、列距）
- **无限滚动**：触底自动加载下一页
- **内置 Lightbox**：点击图片全屏浏览，支持缩放、拖拽与左右切换；进入/退出时预留滚动条宽度，避免闪烁
- **视频悬停**：短片卡片悬停时预播预览片段
- **筛选**：关键词、路径、排序、标签/演员/工作室
- **协作**：`enhancedWallItemAdded` 事件，兼容 FavoriteHeart 等插件
- **作用范围**：仅 `/images`、`/scenes` 列表；小屏/触屏不启用

## 安装

将 `PowerWall` 目录放入 Stash 的 `plugins` 目录，在 **设置 → Plugins** 中重载插件。

## 兼容性

- **Stash**：需支持 UI 插件的版本（通常 v0.25+）
- **作用页面**：`/images` 与 `/scenes` 列表页
- **不作用**：`/tags`、`/galleries`、`/performers`、`/studios`、`/movies`、`/markers` 及详情页等

## 功能边界

1. 仅替换 `/images`、`/scenes` 根列表页的墙/网格内容，不影响其它页面
2. 使用 `PluginApi.Event` 监听 `stash:location` 实现路由感知；无 PluginApi 时使用 history API 备选
3. 使用 Stash 标准 `/graphql` 端点，不调用非公开接口
4. 样式与 DOM 均限定在 `.power-wall-*` 命名空间内
5. 离开列表页时完整卸载并清理 DOM、事件、全局状态

## URL 筛选参数

| 参数 | 说明 |
|------|------|
| `q` | 关键词搜索 |
| `path` | 路径包含过滤（支持筛选面板选择） |
| `tags` | 标签 ID，逗号分隔 |
| `performers` | 演员 ID，逗号分隔 |
| `studios` | 工作室 ID，逗号分隔 |
| `galleries` | 图库 ID（仅图片页） |
| `sortby` | 排序字段（created_at / date / title / rating100 / updated_at / random_&lt;seed&gt;） |
| `sortdir` | 排序方向，`ASC` 或 `DESC` |

## 配置

在列表页工具栏点击「⚙️ 设置」配置，保存至 `localStorage`（键：`PowerWall_config`）。

### 布局预设

紧凑 / 标准 / 宽松，分别调节边距、行距、列距。

### 功能开关

| 项 | 说明 |
|----|------|
| 图片列表启用 | 是否在 `/images` 启用砌墙 |
| 短片列表启用 | 是否在 `/scenes` 启用砌墙 |
| 内置 lightbox | 点击图片在内置 lightbox 浏览 |
| 高级 | 每页数量（12～120）、调试模式 |

### 筛选

点击「🔍 筛选」打开筛选面板，支持关键词、路径、排序、标签/演员/工作室多选，与 URL 同步。

## 性能与鲁棒性

- **无限滚动**：IntersectionObserver，无 scroll 轮询
- **布局**：ResizeObserver + debounce；DOM 批量插入、单次高度更新
- **请求**：GraphQL 支持 AbortSignal（刷新/离开时取消）、30s 超时
- **配置**：缓存、localStorage 读写异常处理、zoomIndex/itemsPerPage 范围校验
- **Lightbox**：复用 overlay 时正确更新 prev/next 索引，键盘与鼠标事件按需绑定/解绑
- **路由**：PluginApi.Event 或 history fallback，离开时完整卸载

## 技术实现

- **规范**：遵循 [Stash UI Plugin API](https://docs.stashapp.cc/in-app-manual/plugins/uipluginapi/)
- **数据**：GraphQL `findImages` / `findScenes` / `findFolders` 等
- **路由**：`PluginApi.Event` 监听 `stash:location`，无 `PluginApi.patch` 避免 React 冲突

## 版本

### 1.2.0（定稿版）

- Lightbox 复用修复：再次打开时 prev/next 与索引正确更新
- 移除 BrickWallLayout 冗余 zoomIndex，布局列宽统一从 getConfig 读取
- 4K/1080p 分辨率角标样式（resolution-4k、resolution-hd）
- 代码简化与鲁棒性增强

### 1.1.0

- 配置读写防错、布局计算优化、Lightbox/筛选/无限滚动边界检查
- 配置项校验（zoomIndex、itemsPerPage 范围）与 localStorage 写入异常处理

### 1.0.0

- 初始版本：砌墙布局（列优先递补）、6 档缩放、布局预设、无限滚动、内置 Lightbox、筛选与设置
