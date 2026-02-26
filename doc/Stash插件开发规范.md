# Stash 插件开发规范

本文档基于 [Stash 官方文档](https://docs.stashapp.cc/plugins/) 与仓库内应用手册（`ui/v2.5/src/docs/en/Manual/`）整理，供插件开发与集成时参考。

---

## 1. 概述与免责声明

- **插件能力**：Stash 插件可
  - 向 UI 注入自定义 **JavaScript** 与 **CSS**
  - 在**任务页**由用户触发执行自定义任务
  - 在特定**事件**（如场景创建/更新后）通过 **Hook** 触发执行

- **任务实现方式**：任务可由 **嵌入式 JavaScript**（Goja）或 **外部二进制** 实现。

- **免责声明**（[Plugins - Stash-Docs](https://docs.stashapp.cc/plugins/)）：  
  插件由社区创建与维护，与 stashapp 团队无隶属关系；插件为 Stash 提供默认未包含的功能。

- **实验性说明**（应用内手册）：  
  **插件支持仍为实验性**，可能在不另行通知的情况下发生变更。

---

## 2. 插件管理

### 2.1 管理入口

- 在 **设置 → Plugins** 页面进行插件的安装、更新与卸载。
- **Available Plugins**：从配置的“插件源”安装；**Community (stable)** 为默认源。
- **Installed Plugins**：查看已安装插件并执行更新/卸载。
- 添加新源：**Available Plugins** 区域点击 **Add Source**。

### 2.2 手动安装

- 默认从 **config.yml 所在目录** 下的 `plugins` 子目录读取插件配置。
- 常见路径：
  - Windows: `%USERPROFILE%\.stash\plugins`
  - Unix: `$HOME/.stash/plugins` 或 `/root/.stash/plugins`
  - 或当前工作目录 (cwd) 下的 `plugins`
- 将 **YAML 配置文件**（格式：`pluginName.yml`）放入该目录即完成添加。
- 运行中增删改配置后，在设置 → Plugins 页点击 **Reload Plugins** 重新加载。

### 2.3 插件源

- Stash 预置 [stashapp/CommunityScripts](https://github.com/stashapp/CommunityScripts) 源。
- 源 URL 需返回一个 YAML 文件，列出可用包。示例结构：

```yaml
- id: <package id>
  name: <package name>
  version: <version>
  date: <date>
  requires: []   # 可选，依赖的其他 package id
  path: <path or URL to zip>
  sha256: <sha256 of zip>
  metadata: {}   # 可选
```

- 官方维护的源示例：

| 名称               | Source URL                                                                 | 推荐本地路径 | 说明           |
|--------------------|-----------------------------------------------------------------------------|--------------|----------------|
| Community (stable) | `https://stashapp.github.io/CommunityScripts/stable/index.yml`             | `stable`     | 当前稳定版     |
| Community (develop) | `https://stashapp.github.io/CommunityScripts/develop/index.yml`           | `develop`    | 开发版         |

- 社区索引与源列表见论坛：[Community plugin index](https://discourse.stashapp.cc/c/plugins/18)、[List of known plugin sources](https://discourse.stashapp.cc/t/list-of-plugin-sources/122)。

---

## 3. 插件配置文件格式

### 3.1 基本结构

```yaml
name: <插件名称>
# requires: <plugin ID>   # 可选，依赖插件 ID；"#" 为配置一部分勿删
description: <可选描述>
version: <可选版本>
url: <可选链接>

ui:
  css: []
  javascript: []
  requires: []
  assets: {}
  csp: {}

settings: {}    # 插件设置，用于在设置页展示

# 以下仅用于带任务的插件
exec: []
interface: <类型>
errLog: <日志级别>
tasks: []
hooks: []       # 可选，事件触发
```

- **name / description / version / url**：在设置 → Plugins 页面展示。
- **# requires**：使插件管理器自动安装指定 ID 的依赖（仅限同一 index 内）。
- **settings**：在插件设置页显示；也可通过 GraphQL 的 `configurePlugin` 写入，未在 `settings` 中声明的项不会出现在默认设置 UI 中。

### 3.2 UI 配置（ui）

| 字段 | 说明 |
|------|------|
| **css** | 可选，CSS 文件路径列表；路径可为相对插件配置目录或完整 URL。 |
| **javascript** | 可选，JS 文件路径列表；同上。 |
| **requires** | 可选，必须先加载的插件 ID 列表；本插件的 JS/CSS 在其后加载。 |
| **assets** | 可选，URL 前缀到本地路径的映射；挂载到 `/plugin/{pluginID}/assets`。 |
| **csp** | 可选，内容安全策略放宽：`script-src`、`style-src`、`connect-src` 等列表。 |

**assets 示例**（插件 id 为 `foo`）：

```yaml
assets:
  foo: bar
  /: .
```

- `/plugin/foo/assets/foo/file.txt` → `{pluginDir}/bar/file.txt`
- `/plugin/foo/assets/file.txt` → `{pluginDir}/file.txt`
- `/plugin/foo/assets/bar/file.txt` → `{pluginDir}/bar/file.txt`（通过 `/` 映射）

试图映射到插件配置目录之外的路径会被忽略。

**csp**：将所列 URL 加入对应 CSP 指令，用于允许外部脚本、样式或请求。

### 3.3 任务相关配置（仅带任务的插件）

- **exec**：执行入口。嵌入式插件为 JS 文件路径列表（首项）；外部插件为可执行文件与参数列表。
- **interface**：通信接口。嵌入式为 `js`；外部为 `rpc` 或 `raw`（默认 raw）。
- **errLog**：外部插件 stderr 的默认日志级别：`none`、`trace`、`debug`、`info`、`warning`、`error`。
- **tasks**：任务列表，见下文。
- **hooks**：Hook 列表，见下文。

---

## 4. 任务与 Hook

### 4.1 任务输入（Plugin task input）

任务从 Stash 接收的输入（按 interface 编码）结构示例（JSON 表示）：

```json
{
  "server_connection": {
    "Scheme": "http",
    "Port": 9999,
    "SessionCookie": { ... },
    "Dir": "<stash 配置目录>",
    "PluginDir": "<插件配置目录>"
  },
  "args": {
    "argKey": "argValue"
  }
}
```

- **server_connection**：用于访问 Stash 服务（含会话、目录等）。
- **args**：任务参数；由 Hook 触发时还会包含 `hookContext`。

### 4.2 任务输出（Plugin task output）

期望结构（JSON）：

```json
{
  "error": "<可选错误信息>",
  "output": "<任意内容>"
}
```

- **error**：若存在，以 error 级别记入 Stash 日志。
- **output**：以 debug 级别写入。

### 4.3 任务配置（tasks）

```yaml
tasks:
  - name: <操作名称>
    description: <可选描述>
    defaultArgs:
      argKey: argValue
```

- 可配置多个任务。
- **defaultArgs**：合并到发送给插件的 `args` 中。

### 4.4 Hook 配置（hooks）

```yaml
hooks:
  - name: <操作名称>
    description: <可选描述>
    triggeredBy:
      - <触发类型>...
    defaultArgs:
      argKey: argValue
```

- **触发类型格式**：`<对象类型>.<操作>.<Hook 类型>`，例如 `Scene.Create.Post`。
- **对象类型**：Scene、SceneMarker、Image、Gallery、Group、Performer、Studio、Tag。
- **操作**：Create、Update、Destroy、Merge（仅 Tag）。
- **Hook 类型**：当前仅支持 **Post**（操作完成且事务提交后执行）。

注意：若插件执行变更，可能再次触发 Hook 或链式触发；同一操作上下文中同一 Hook 不会重复触发（由 Stash 用 cookie 跟踪）。插件请求 Stash 时需携带 cookie。

### 4.5 Hook 输入中的 hookContext

Hook 触发的任务在 `args` 中会多一个 **hookContext**：

```json
{
  "id": <对象 id>,
  "type": "<触发类型>",
  "input": <GraphQL 操作输入>,
  "inputFields": [ "<本次更新涉及的字段>" ]
}
```

- **input**：原始 GraphQL 操作的 JSON 输入；扫描/清理等场景可能为 nil。
- **inputFields**：Update 时表示本次传入的字段，用于区分“未传”与“传空”。

---

## 5. 嵌入式插件（Embedded Plugins）

- 在 Stash 进程内通过 **Goja** 执行 JavaScript。
- **exec**：列表首项为**相对插件配置目录**的 JS 文件路径。
- **interface**：必须为 **js**。

### 5.1 输入与输出

- **输入**：通过全局 **input** 对象提供，结构与上文「Plugin task input」一致（嵌入式场景下通常不需要 `server_connection`）。
- **输出**：脚本求值结果需符合「Plugin task output」结构。示例：

```javascript
(function() {
    return { output: "ok" };
})();
```

或：

```javascript
var output = { output: "ok" };
output;
```

### 5.2 JavaScript API

**日志**（全局 `log`）：

| 方法 | 说明 |
|------|------|
| `log.Trace(str)` | trace 级别 |
| `log.Debug(str)` | debug 级别 |
| `log.Info(str)` | info 级别 |
| `log.Warn(str)` | warn 级别 |
| `log.Error(str)` | error 级别 |
| `log.Progress(0–1)` | 任务进度，0=0%，1=100% |

**GQL**（全局 `gql`）：

| 方法 | 说明 |
|------|------|
| `gql.Do(queryOrMutationString, variables)` | 执行 GraphQL 请求，返回与查询一致的对象 |

**工具**（全局 `util`）：

| 方法 | 说明 |
|------|------|
| `util.Sleep(ms)` | 挂起指定毫秒数 |

---

## 6. 外部插件（External Plugins）

- 通过运行**外部二进制**执行任务。
- **exec**：首项为可执行文件名（在 PATH 或插件配置目录查找），后续为参数；Windows 下可省略 `.exe`。可用 **{pluginDir}** 占位符表示插件目录，例如：`python`、`{pluginDir}/foo.py`。
- **interface**：**rpc**（JSON-RPC）或 **raw**（默认）。
- **errLog**：未带日志级别编码的 stderr 默认级别，缺省为 error。

### 6.1 RPC 接口

- 使用 JSON-RPC 与插件进程通信。
- 需实现 `pkg/plugin/common` 中的 **RPCRunner** 接口。
- 以异步方式处理请求；停止时 Stash 发送 stop 请求，由插件自行退出。

### 6.2 Raw 接口

- 无强制协议。Stash 将插件输入以 JSON 写入进程 **stdin**（插件可不读取）。
- Stash 从 **stdout** 读取输出：若可解析为「Plugin task output」JSON 则使用；否则整段 stdout 作为 output。
- 停止时 Stash 直接终止进程（无信号通知）。

### 6.3 日志

- 外部插件通过 **stderr** 输出日志；可用前缀控制级别与进度，格式见 `pkg/plugin/common/log`（Go）。

### 6.4 任务额外参数（execArgs）

```yaml
tasks:
  - name: <操作名>
    execArgs:
      - <追加到 exec 的参数>
```

---

## 7. UI 插件与 PluginApi

向 UI 注入 **ui.javascript** 的插件在**浏览器同一 window** 中执行，可使用全局 **PluginApi** 扩展界面、注册路由、使用内置组件与工具。

### 7.1 文档与示例

- 应用内手册：**UI Plugin API**（仓库路径：`ui/v2.5/src/docs/en/Manual/UIPluginApi.md`）。
- 示例代码：`pkg/plugin/examples/react-component`。

### 7.2 PluginApi 要点摘要

- **React / ReactDOM / GQL**：与主应用一致的 React 与 GraphQL 客户端（GQL 为底层，多数场景建议用 StashService）。
- **libraries**：ReactRouterDOM、Bootstrap、Apollo、Intl、FontAwesome*、Mousetrap、ReactSelect 等。
- **register.route(path, component)**：注册前端路由，path 建议使用 `/plugin/` 前缀。
- **register.component(name, component)**：将组件注册到 `PluginApi.components`，name 建议以 `plugin-` 为前缀且唯一。
- **components**：内置与已注册组件集合，供插件直接使用。
- **utils**：NavUtils、StashService、loadComponents、InteractiveUtils 等。
- **hooks**：useLoadComponents、useToast、useSettings、useSpriteInfo、useInteractive、useLightbox、useGalleryLightbox 等。
- **loadableComponents**：需通过 loadComponents / useLoadComponents 预加载的懒加载组件入口。
- **patch**：patch.before / instead / after，用于修改指定组件行为；组件名需与文档中「Patchable components」一致。
- **Event**：例如 `PluginApi.Event.addEventListener("stash:location", handler)` 监听路由等事件。

完整属性、方法及可 patch 组件列表见 **UIPluginApi.md** 与仓库内《插件开发规范与UI插件可用接口调研报告.md》。

---

## 8. 参考链接与文件

- 官方插件总览：[https://docs.stashapp.cc/plugins/](https://docs.stashapp.cc/plugins/)
- 应用内手册（本仓库）：`ui/v2.5/src/docs/en/Manual/Plugins.md`、`EmbeddedPlugins.md`、`ExternalPlugins.md`、`UIPluginApi.md`
- 社区脚本与论坛：[CommunityScripts](https://github.com/stashapp/CommunityScripts)、[Forum - Plugins](https://discourse.stashapp.cc/c/plugins/18)

---

**文档结束。**
