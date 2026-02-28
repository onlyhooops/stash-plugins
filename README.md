# Stash 插件仓库

个人维护的 Stash UI 插件。

## 插件列表

| 插件 | 说明 |
|------|------|
| **FavoriteHeart** | 红心/心碎收藏，like/dislike 互斥；带 dislike 的照片/视频去色显示 |
| **PowerWall** | 砌墙视图（Stash 原生风格）— 边距/行距/列距可调、无限滚动、内置 lightbox、返回顶部、图片/短片列表 |
| **GalleryWallCoverFill** | Galleries 墙视图封面填充 — 当图库首图比例与固定区域(3:2/3:4)不一致时，自适应填满区域，消除视觉空缺 |

## 安装方式

### 方式一：通过 Stash 插件源安装（推荐）

1. 打开 Stash **设置** → **插件**
2. 在 **可用插件** 区域点击 **添加源**
3. 输入本仓库的插件源 URL：
   ```
   https://onlyhooops.github.io/stash-plugins/index.yml
   ```
   例如：`https://onlyhooops.github.io/stash-plugins/index.yml`
4. 保存后即可在列表中看到并安装插件

### 方式二：手动安装

将对应插件文件夹（如 `FavoriteHeart`）复制到 Stash 的 `plugins` 目录。

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
├── FavoriteHeart/
│   ├── FavoriteHeart.yml
│   ├── FavoriteHeart.js
│   └── FavoriteHeart.css
├── PowerWall/
│   ├── PowerWall.yml
│   ├── PowerWall.js
│   └── PowerWall.css
├── GalleryWallCoverFill/
│   ├── GalleryWallCoverFill.yml
│   ├── GalleryWallCoverFill.js
│   └── GalleryWallCoverFill.css
├── build_site.sh
├── .github/workflows/deploy.yml
└── README.md
```

## 许可证

AGPL-3.0
