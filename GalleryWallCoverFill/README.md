# GalleryWallCoverFill

Galleries（图库）墙视图**封面填充**插件：当图库首张图片比例与 Stash 预设的固定区域（横向 3:2、纵向 3:4）不一致时，让封面图**自适应填满**该区域，消除视觉上的空缺，不改变 Galleries 墙的其它布局与特性。

## 版本

当前版本：**1.1.0**

## 原理

- 仅在 **`/galleries`** 页面注入样式（通过 `body.gallery-wall-coverfill-active` 类名控制）
- 对图库墙卡片的封面图设置 `object-fit: cover`、`object-position: center`，覆盖 Stash 默认的 `contain` 模式，使图片铺满固定比例格子，超出部分居中裁剪

## 兼容 DOM 结构

| Stash 版本 | 目标选择器 |
|-----------|------------|
| 当前版本  | `section.GalleryWallCard > img.GalleryWallCard-img.GalleryWallCard-img-contain` |
| 兼容回退  | `.gallery-card`、`.wall`、`.flexbin`、`.wall-item` 等可能存在的旧结构 |

## 安装

将 `GalleryWallCoverFill` 目录放入 Stash 的 `plugins` 目录，在 **设置 → Plugins** 中重载插件。

## 性能与鲁棒性

- **延迟初始化**：在下一 tick 执行，避免与主应用 `setupReplaceUnsafeHeader` 等只可调用一次的代码冲突
- **单次注册**：history 与事件监听只注册一次，避免重复调用
- **最小 DOM 写入**：使用 `classList.toggle` 按需更新，无冗余 add/remove
- **轮询上限**：PluginApi 未就绪时最多轮询约 2 秒，防止无限重试
- **空引用保护**：路径检测与 `document.body` 访问均有防护

## 说明

- 不修改 PowerWall、不作用于 `/images`、`/scenes`
- 若 Stash 升级后选择器失效，可在浏览器开发者工具中查看图库墙卡片的类名，并相应调整 `GalleryWallCoverFill.css` 中的选择器
- 确认生效：访问 `/galleries`，检查 `body` 是否带有 `gallery-wall-coverfill-active` 类

## 更新日志

### 1.1.0

- 性能：`updateBodyClass` 使用 `classList.toggle` 避免冗余 DOM 写入
- 鲁棒性：PluginApi 轮询增加最大重试次数，防止无限循环
- 鲁棒性：`isGalleriesPath` 增强对 `null`、`undefined` 等边界处理
- 鲁棒性：`updateBodyClass` 检查 `document.body` 存在性
- CSS：合并选择器，减少规则数量

### 1.0.0

- 初版发布
- 支持 Stash Galleries 墙视图封面 `object-fit: cover`
- 路径限定 `/galleries`，不干扰其他页面
