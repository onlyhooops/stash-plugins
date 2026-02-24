# Enhanced Wall View

Stash 图片/短片列表瀑布流插件：无限滚动、内置 lightbox、筛选与视频悬停预览。

## 功能

- **瀑布流**：Masonry 紧凑布局，自适应宽度
- **无限滚动**：IntersectionObserver 懒加载
- **筛选**：关键词、路径、标签/演员/工作室、排序；随览（随机）
- **Lightbox**：全屏看图，缩放与拖拽
- **视频悬停**：短片卡片悬停预览
- **协作**：`enhancedWallItemAdded` 事件，兼容 FavoriteHeart

## 安装

将 `EnhancedWallView` 目录放入 Stash 的 `plugins` 目录，或通过 Stash 插件管理页面的社区源安装。

## 兼容性

- **Stash**：需支持 UI 插件的版本（通常 v0.25+）
- **作用页面**：`/images` 与 `/scenes` 列表页
- **不作用**：`/tags`、`/galleries`、详情页等其它页面

## 功能边界

1. **严格限定**：仅替换 `/images`、`/scenes` 根列表页的墙/网格内容，**不影响** tags、图库、演员、工作室等其它页面
2. 使用 `PluginApi.Event` 监听 `stash:location` 实现路由感知；无 PluginApi 时使用 history API 监听作为备选
3. 使用 Stash 标准 `/graphql` 端点，不调用非公开接口
4. 样式与 DOM 均限定在 `.enhanced-wall-*` 命名空间内
5. 离开列表页时完整卸载并清理 DOM、事件、全局状态

## URL 筛选参数

| 参数 | 说明 |
|------|------|
| `q` | 关键词搜索 |
| `path` | 路径包含过滤（支持筛选面板交互选择） |
| `tags` | 标签 ID，逗号分隔 |
| `performers` | 演员 ID，逗号分隔 |
| `studios` | 工作室 ID，逗号分隔 |
| `galleries` | 图库 ID（仅图片页） |
| `sortby` | 排序字段（created_at / date / title / rating100 / updated_at / random_&lt;seed&gt;） |
| `sortdir` | 排序方向，`ASC` 或 `DESC` |

## 性能与鲁棒性

- 无限滚动：IntersectionObserver，无 scroll 轮询
- 布局：ResizeObserver + debounce；DOM 批量插入、单次高度更新
- 请求：GraphQL 支持 AbortSignal（刷新/离开时取消）、30s 超时
- 配置缓存、Lightbox 文档级监听按需绑定/解绑；路由 fallback 防抖

## 配置

在列表页工具栏点击「⚙️ 设置」配置，保存至 `localStorage`。

### 布局

当前仅支持紧凑视图（小卡片、最小间距）。

### 功能开关

| 项 | 说明 |
|----|------|
| 图片/短片启用 | 是否在对应列表启用瀑布流 |
| 内置 lightbox | 点击图片在内置 lightbox 浏览 |
| 高级选项 | 每页加载数量、调试模式等 |

## 技术实现

- **规范**：遵循 [Stash UI Plugin API](https://docs.stashapp.cc/in-app-manual/plugins/uipluginapi/)
- **数据**：GraphQL `findImages` / `findScenes` / `findFolders` 等
- **路由**：`PluginApi.Event` 监听 `stash:location`，无 `PluginApi.patch` 避免 React 冲突

## 版本

v1.4.0
