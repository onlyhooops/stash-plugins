# Image Duplicate Checker

Stash 图片重复检测插件：按 phash（感知哈希）查找重复图片，支持批量选择与删除。**仅处理 Image 实体（图片）**，不包含压缩包、PDF。

## 依赖说明

- **优先**：若 Stash 提供 **`findDuplicateImages`** GraphQL 查询，插件会使用 phash 做相似重复检测（支持匹配精度）。
- **降级**：若 Stash 尚未实现该接口，插件会**自动切换为按 checksum 精确重复检测**：用 `findImages` 拉取图片、按文件 fingerprint（如 md5）分组，仅列出「文件完全一致」的重复组，无需后端支持；**已排除压缩包内的图片**（仅统计库内独立文件），此时不提供「匹配精度」选项。

实现 phash 接口可参考 Stash 自带的 `findDuplicateScenes`，对 Image 实体按 phash 距离聚类并仅处理图片类型文件（排除 zip、PDF 等）。

## 使用方式

1. 在 Stash 中安装并启用本插件。
2. 在设置中开启「生成图片 phash」并执行生成任务（若尚未生成）。
3. 在浏览器中访问：**`/plugin/image-duplicate-checker`**（或从侧栏/设置中的插件入口进入，若 Stash 提供）。
4. 选择「匹配精度」（精确 / 高 / 中 / 低），点击「刷新」获取重复组。
5. 使用批量勾选策略（如「勾选除最大文件外的项」）后，点击「删除已勾选」执行删除（可选仅从库中删除或同时删除文件）。

## 功能概览

- **匹配精度**：对应 phash 距离（0=精确，数值越大越宽松）。
- **缺少 phash 提示**：若有图片未生成 phash，会提示先运行生成任务。
- **批量策略**：勾选除最大文件、除最高分辨率、除最旧/除最新。
- **删除**：支持仅从库中删除或同时从磁盘删除文件。

## 文件结构

```
ImageDuplicateChecker/
  ImageDuplicateChecker.yml   # 插件元数据与 UI 入口
  ImageDuplicateChecker.js   # 路由、GraphQL 调用与页面逻辑
  ImageDuplicateChecker.css  # 样式
  README.md                  # 本说明
```

## 版本

1.0.0
