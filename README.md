# Stash 插件仓库

个人维护的 Stash UI 插件，包含 EnhancedWallView 与 FavoriteHeart。

## 插件列表

| 插件 | 说明 |
|------|------|
| **EnhancedWallView** | 瀑布流布局、无限滚动、内置 lightbox、筛选器、随览、视频悬停预览，兼容 FavoriteHeart |
| **FavoriteHeart** | 在卡片右上角添加红心收藏按钮，点击后自动添加指定标签 |

## 安装方式

### 方式一：通过 Stash 插件源安装（推荐）

1. 打开 Stash **设置** → **插件**
2. 在 **可用插件** 区域点击 **添加源**
3. 输入本仓库的插件源 URL：
   ```
   https://onlyhooops.github.io/stash-plugins/main/index.yml
   ```
   例如：`https://onlyhooops.github.io/stash-plugins/main/index.yml`
4. 保存后即可在列表中看到并安装插件

### 方式二：手动安装

将 `plugins` 目录下对应插件文件夹（如 `EnhancedWallView`）复制到 Stash 的 `plugins` 目录。

## 首次发布步骤

1. **创建 GitHub 仓库**
   - 点击 [Use this template](https://github.com/stashapp/plugins-repo-template) 创建新仓库
   - 或将本目录内容推送到你的新仓库

2. **配置 GitHub Pages**
   - 仓库 **Settings** → **Pages**
   - 在 **Build and deployment** 中选择 **Source: GitHub Actions**

3. **推送到 main 分支**
   - 推送后 GitHub Actions 会自动构建并发布

4. **分享插件源**
   - 在 [Stash 社区论坛](https://discourse.stashapp.cc/t/list-of-plugin-sources/122) 添加你的插件源
   - 在 [Discourse 插件区](https://discourse.stashapp.cc/c/plugins/18) 发帖介绍你的插件

## 目录结构

```
.
├── plugins/
│   ├── EnhancedWallView/
│   │   ├── EnhancedWallView.yml
│   │   ├── EnhancedWallView.js
│   │   ├── EnhancedWallView.css
│   │   └── README.md
│   └── FavoriteHeart/
│       ├── FavoriteHeart.yml
│       ├── FavoriteHeart.js
│       └── FavoriteHeart.css
├── build_site.sh
├── .github/workflows/deploy.yml
└── README.md
```

## 许可证

AGPL-3.0
