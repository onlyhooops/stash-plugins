/**
 * SpaceCleaner — Stash UI control panel
 *
 * - Registers the top-level /space-cleaner route and adds an entry to the
 *   main navigation.
 * - Calls the external Python plugin synchronously through the GraphQL
 *   `runPluginOperation` mutation, so preview/apply results come back directly
 *   to the page.
 * - Uses only documented PluginApi / GraphQL interfaces.
 *
 * API reference: https://docs.stashapp.cc/in-app-manual/plugins/uipluginapi/
 */

(function () {
  'use strict';

  const PLUGIN_ID = 'SpaceCleaner';
  // Synology system entries. Kept in sync with IGNORED_NAMES in
  // space_cleaner.py so the directory browser never offers a path the backend
  // will refuse.
  const IGNORED_BASENAMES = {
    '@eadir': true,
    '@synoeastream': true,
    '#recycle': true,
  };
  // Characters that are never allowed at the end of a name. Kept in sync with
  // TRAILING_NOISE_CATEGORIES in space_cleaner.py: separators, control/format
  // characters, lone surrogates and private-use characters.
  const TRAILING_NOISE_RE = /[\p{Zs}\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;
  const SPACE_RE = /\p{Zs}/u;
  // A top-level route is used instead of /plugin/... because Stash's server
  // reserves /plugin/{pluginId}/* for plugin assets and returns 404 for page
  // routes, which would break a hard refresh/bookmark.
  const ROUTE = '/space-cleaner';
  const INIT_FLAG = '__SpaceCleanerInitialized';

  const RUN_OPERATION = `
    mutation SpaceCleanerRun($plugin_id: ID!, $args: Map) {
      runPluginOperation(plugin_id: $plugin_id, args: $args)
    }
  `;

  const DIRECTORY_QUERY = `
    query SpaceCleanerDirectory($path: String) {
      directory(path: $path) {
        path
        parent
        directories
      }
    }
  `;

  const CONFIG_QUERY = `
    query SpaceCleanerConfig {
      configuration {
        general {
          stashes {
            path
          }
        }
      }
    }
  `;

  // Stash versions before the StashConfig object used [String!].
  const LEGACY_CONFIG_QUERY = `
    query SpaceCleanerConfigLegacy {
      configuration {
        general {
          stashes
        }
      }
    }
  `;

  function stashPathsFromConfig(data) {
    const stashes =
      (data && data.configuration && data.configuration.general &&
        data.configuration.general.stashes) || [];
    if (!Array.isArray(stashes)) return [];
    return stashes
      .map(function (item) {
        if (typeof item === 'string') return item;
        return item && item.path ? item.path : null;
      })
      .filter(function (item, index, list) {
        return item && list.indexOf(item) === index;
      });
  }

  function graphqlEndpoint() {
    const base = document.querySelector('base');
    const href = base ? base.getAttribute('href') || '/' : '/';
    return href.replace(/\/+$/, '') + '/graphql';
  }

  async function graphqlRequest(query, variables) {
    const response = await fetch(graphqlEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    if (!response.ok) {
      throw new Error('GraphQL 请求失败（HTTP ' + response.status + '）');
    }
    let body;
    try {
      body = await response.json();
    } catch (err) {
      throw new Error('服务器返回了无法解析的响应');
    }
    if (body.errors && body.errors.length) {
      const message = body.errors
        .map(function (item) { return item && item.message; })
        .filter(Boolean)
        .join('；');
      throw new Error(message || 'GraphQL 请求失败');
    }
    return body.data;
  }

  function parentPath(path) {
    if (!path) return '';
    const index = path.lastIndexOf('/');
    if (index <= 0) return '/';
    return path.slice(0, index);
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || isNaN(ms)) return '';
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(1) + ' 秒';
  }

  function targetsLabel(targets) {
    if (targets === 'files') return '仅文件';
    if (targets === 'folders') return '仅文件夹';
    return '文件与文件夹';
  }

  function isIgnoredPath(path) {
    const name = String(path || '').split('/').pop().toLowerCase();
    return IGNORED_BASENAMES[name] === true;
  }

  function statusMeta(status) {
    switch (status) {
      case 'renamed':
        return { variant: 'success', label: '已重命名' };
      case 'skipped':
        return { variant: 'secondary', label: '已跳过' };
      case 'error':
        return { variant: 'danger', label: '错误' };
      default:
        return { variant: 'warning', label: '待处理' };
    }
  }

  // Cleaning only ever removes characters, so align the old name with the new
  // one as a subsequence. Every unmatched old character is a removed space or
  // tab. This keeps the highlight correct when spaces are stripped from both
  // before the extension and the end of the name.
  function splitRemoved(oldName, newName) {
    oldName = String(oldName || '');
    newName = String(newName || '');
    const segments = [];
    let removed = '';
    let i = 0;
    let j = 0;

    function flushRemoved() {
      if (!removed) return;
      segments.push({ text: removed, removed: true });
      removed = '';
    }

    while (i < oldName.length) {
      if (j < newName.length && oldName[i] === newName[j]) {
        flushRemoved();
        const start = i;
        while (
          i < oldName.length &&
          j < newName.length &&
          oldName[i] === newName[j]
        ) {
          i += 1;
          j += 1;
        }
        segments.push({ text: oldName.slice(start, i), removed: false });
      } else {
        removed += oldName[i];
        i += 1;
      }
    }
    flushRemoved();
    return segments;
  }

  function init(pluginApi) {
    const React = pluginApi.React;
    const h = React.createElement;
    const libraries = pluginApi.libraries;
    const Bootstrap = libraries.Bootstrap;
    const ReactRouterDOM = libraries.ReactRouterDOM;
    const Alert = Bootstrap.Alert;
    const Badge = Bootstrap.Badge;
    const Button = Bootstrap.Button;
    const Card = Bootstrap.Card;
    const Form = Bootstrap.Form;
    const InputGroup = Bootstrap.InputGroup;
    const Modal = Bootstrap.Modal;
    const NavLink = ReactRouterDOM.NavLink;

    function isTrailingNoise(ch) {
      return TRAILING_NOISE_RE.test(ch);
    }

    function splitTrailingNoise(value) {
      const text = String(value == null ? '' : value);
      let index = text.length;
      while (index > 0 && isTrailingNoise(text.charAt(index - 1))) {
        index -= 1;
      }
      return [text.slice(0, index), text.slice(index)];
    }

    function noiseLabel(ch) {
      if (ch === ' ') return '空格';
      if (ch === '\t') return 'Tab';
      const code = ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
      if (SPACE_RE.test(ch)) return '空白字符 U+' + code;
      if (/\p{Co}/u.test(ch)) return '私用区字符 U+' + code;
      if (/\p{Cf}/u.test(ch)) return '格式字符 U+' + code;
      if (/\p{Cs}/u.test(ch)) return '代理字符 U+' + code;
      if (/\p{Cc}/u.test(ch)) return '控制字符 U+' + code;
      return '分隔字符 U+' + code;
    }

    function noiseSymbol(ch) {
      if (ch === '\t') return '⇥';
      if (SPACE_RE.test(ch)) return '␣';
      return '▯';
    }

    function renderNoise(text) {
      return String(text || '')
        .split('')
        .map(function (ch, index) {
          if (!isTrailingNoise(ch)) {
            return h('span', { key: index }, ch);
          }
          return h(
            'span',
            { key: index, className: 'sc-ws', title: noiseLabel(ch) },
            noiseSymbol(ch)
          );
        });
    }

    function visibleTrailing(value) {
      const parts = splitTrailingNoise(value);
      if (!parts[1]) return parts[0];
      return (
        parts[0] +
        parts[1]
          .split('')
          .map(noiseSymbol)
          .join('')
      );
    }

    function renderPlainName(name) {
      const parts = splitTrailingNoise(name);
      if (!parts[1]) return parts[0];
      return [
        parts[0],
        h(
          'span',
          { className: 'sc-removed', key: 'ws' },
          renderNoise(parts[1])
        ),
      ];
    }

    function renderNameDiff(entry) {
      const oldName = entry.old_name;
      const newName = entry.new_name;
      if (!newName) {
        return h('code', { className: 'sc-name' }, renderPlainName(oldName || entry.old_path || ''));
      }
      const segments = splitRemoved(oldName, newName);
      return h(
        'div',
        { className: 'sc-name-line' },
        h(
          'code',
          { className: 'sc-name', title: '原名称（高亮部分将被删除）' },
          segments.map(function (segment, index) {
            if (!segment.removed) {
              return h('span', { key: 'n' + index }, segment.text);
            }
            return h(
              'span',
              {
                className: 'sc-removed',
                key: 'r' + index,
                title: '将被删除的不可见字符',
              },
              renderNoise(segment.text)
            );
          })
        ),
        oldName !== newName
          ? h('span', { className: 'sc-arrow', 'aria-hidden': 'true' }, '→')
          : null,
        oldName !== newName
          ? h('code', { className: 'sc-name sc-name-new', title: '清理后的名称' }, newName)
          : null
      );
    }

    function renderEntry(entry, index) {
      const status = statusMeta(entry.status);
      const kindLabel = entry.kind === 'folder' ? '文件夹' : '文件';
      const note = entry.reason_text || entry.message;
      const path = entry.old_path || '';
      return h(
        'div',
        { className: 'sc-entry', key: path + '-' + index },
        h(
          'div',
          { className: 'sc-entry-top' },
          h(Badge, { variant: 'secondary', className: 'sc-badge' }, kindLabel),
          h(Badge, { variant: status.variant, className: 'sc-badge' }, status.label),
          entry.is_root
            ? h(Badge, { variant: 'info', className: 'sc-badge' }, '根目录')
            : null,
          h(
            'span',
            { className: 'sc-entry-parent', title: path },
            visibleTrailing(parentPath(path)) || '/'
          )
        ),
        renderNameDiff(entry),
        note ? h('div', { className: 'sc-entry-note' }, note) : null
      );
    }

    function renderStats(report) {
      const counts = report.counts || {};
      const isApply = report.mode === 'apply';
      const items = [
        { label: '扫描项', value: report.scanned },
        { label: '命中', value: counts.matched },
        {
          label: isApply ? '已重命名' : '待清理',
          value: isApply ? counts.renamed : counts.pending,
        },
        { label: '跳过', value: counts.skipped },
        { label: '已屏蔽', value: counts.ignored },
        { label: '错误', value: counts.errors },
      ];
      return h(
        'div',
        { className: 'sc-stats' },
        items.map(function (item) {
          return h(
            'div',
            { className: 'sc-stat', key: item.label },
            h('div', { className: 'sc-stat-value' }, String(item.value == null ? 0 : item.value)),
            h('div', { className: 'sc-stat-label' }, item.label)
          );
        })
      );
    }

    function renderReportCard(report, isResult) {
      const counts = report.counts || {};
      const entries = report.entries || [];
      const rootChanged = report.effective_root && report.effective_root !== report.root;
      const nothingRenamed = isResult && counts.renamed === 0 && counts.errors === 0;
      const noMatches =
        !isResult && (counts.matched || 0) === 0 && (counts.errors || 0) === 0;
      const noActionable =
        !isResult && !noMatches && (counts.pending || 0) === 0;

      return h(
        Card,
        { className: 'sc-card mb-4' },
        h(
          Card.Body,
          null,
          h(
            'div',
            { className: 'sc-card-heading' },
            h(Card.Title, null, isResult ? '清理结果' : '预览结果'),
            h(
              'span',
              { className: 'text-muted' },
              formatDuration(report.duration_ms)
            )
          ),
          h(
            'div',
            { className: 'sc-meta' },
            h(
              'div',
              null,
              h('span', { className: 'text-muted' }, '目录：'),
              h('code', null, visibleTrailing(report.root))
            ),
            rootChanged
              ? h(
                  'div',
                  { className: 'sc-root-changed' },
                  h('span', { className: 'text-muted' }, '根目录已重命名为：'),
                  h('code', null, report.effective_root)
                )
              : null,
            h(
              'div',
              { className: 'text-muted' },
              (report.recursive ? '递归处理子目录' : '仅处理当前目录') +
                ' · ' +
                targetsLabel(report.targets) +
                ' · 文件 ' +
                (counts.files || 0) +
                ' / 文件夹 ' +
                (counts.folders || 0)
            )
          ),
          renderStats(report),
          noMatches
            ? h(
                Alert,
                { variant: 'success', className: 'mt-3 mb-0' },
                '未发现需要清理的名称。'
              )
            : null,
          noActionable
            ? h(
                Alert,
                { variant: 'info', className: 'mt-3 mb-0' },
                '没有可执行的清理项，请查看下方跳过或错误详情。'
              )
            : null,
          nothingRenamed && entries.length === 0
            ? h(
                Alert,
                { variant: 'info', className: 'mt-3 mb-0' },
                '没有发生重命名。'
              )
            : null,
          entries.length
            ? h(
                'div',
                { className: 'sc-entries' },
                entries.map(function (entry, index) {
                  return renderEntry(entry, index);
                })
              )
            : null,
          report.truncated
            ? h(
                'div',
                { className: 'sc-truncated text-muted' },
                '列表仅显示前 ' + entries.length + ' 项，统计数字包含全部结果。'
              )
            : null,
          isResult && counts.renamed > 0
            ? h(
                Alert,
                { variant: 'warning', className: 'mt-3 mb-0' },
                '文件系统名称已更新，但 Stash 数据库中的路径不会自动同步。请到 Stash「任务」页运行一次元数据扫描，让数据库识别新路径。'
              )
            : null
        )
      );
    }

    function SpaceCleanerPage() {
      const [path, setPath] = React.useState('');
      const [recursive, setRecursive] = React.useState(true);
      const [targets, setTargets] = React.useState('both');
      const [libraryPaths, setLibraryPaths] = React.useState([]);
      const [browserOpen, setBrowserOpen] = React.useState(true);
      const [browser, setBrowser] = React.useState({
        path: '',
        parent: null,
        directories: [],
        loading: false,
        error: null,
      });
      const [preview, setPreview] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [confirmOpen, setConfirmOpen] = React.useState(false);
      const [elapsed, setElapsed] = React.useState(0);
      const keepResultRef = React.useRef(false);

      React.useEffect(function () {
        if (keepResultRef.current) {
          keepResultRef.current = false;
          return;
        }
        setPreview(null);
        setResult(null);
      }, [path, recursive, targets]);

      React.useEffect(function () {
        let alive = true;
        graphqlRequest(CONFIG_QUERY)
          .then(function (data) {
            if (alive) setLibraryPaths(stashPathsFromConfig(data));
          })
          .catch(function () {
            return graphqlRequest(LEGACY_CONFIG_QUERY)
              .then(function (data) {
                if (alive) setLibraryPaths(stashPathsFromConfig(data));
              })
              .catch(function () {
                if (alive) setLibraryPaths([]);
              });
          });
        return function () {
          alive = false;
        };
      }, []);

      React.useEffect(
        function () {
          if (!browserOpen || !path) {
            setBrowser(function (previous) {
              return {
                path: path,
                parent: previous.parent,
                directories: [],
                loading: false,
                error: null,
              };
            });
            return undefined;
          }
          let alive = true;
          const timer = setTimeout(function () {
            setBrowser(function (previous) {
              return Object.assign({}, previous, { loading: true, error: null });
            });
            graphqlRequest(DIRECTORY_QUERY, { path: path })
              .then(function (data) {
                if (!alive) return;
                const directory = data && data.directory;
                setBrowser({
                  path: (directory && directory.path) || path,
                  parent: (directory && directory.parent) || null,
                  directories: (directory && directory.directories) || [],
                  loading: false,
                  error: null,
                });
              })
              .catch(function (err) {
                if (!alive) return;
                setBrowser({
                  path: path,
                  parent: null,
                  directories: [],
                  loading: false,
                  error: err && err.message ? err.message : String(err),
                });
              });
          }, 250);
          return function () {
            alive = false;
            clearTimeout(timer);
          };
        },
        [path, browserOpen]
      );

      React.useEffect(
        function () {
          if (!busy) return undefined;
          setElapsed(0);
          const timer = setInterval(function () {
            setElapsed(function (value) {
              return value + 1;
            });
          }, 1000);
          return function () {
            clearInterval(timer);
          };
        },
        [busy]
      );

      async function execute(mode) {
        if (!path || !path.trim()) {
          setError('请输入要清理的目录路径');
          return;
        }
        setError(null);
        setPreview(null);
        setResult(null);
        setBusy(mode);
        try {
          const data = await graphqlRequest(RUN_OPERATION, {
            plugin_id: PLUGIN_ID,
            args: {
              mode: mode,
              path: path,
              recursive: recursive,
              targets: targets,
              limit: 500,
            },
          });
          const report = data && data.runPluginOperation;
          if (!report || typeof report !== 'object') {
            throw new Error('插件未返回结果，请确认 SpaceCleaner 已启用并重载插件');
          }
          if (report.ok === false) {
            throw new Error(report.error || '操作失败');
          }
          if (mode === 'preview') {
            setPreview(report);
          } else {
            setResult(report);
            if (report.effective_root && report.effective_root !== path) {
              keepResultRef.current = true;
              setPath(report.effective_root);
            }
          }
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setBusy(null);
        }
      }

      function choosePath(value) {
        setPath(value);
        setBrowserOpen(true);
      }

      function renderBrowser() {
        if (!browserOpen) return null;
        const startFromLibrary = !path;
        const rawDirectories = startFromLibrary
          ? libraryPaths
          : browser.directories || [];
        const directories = rawDirectories.filter(function (directory) {
          return !isIgnoredPath(directory);
        });
        const hiddenCount = rawDirectories.length - directories.length;
        const visible = directories.slice(0, 300);
        const hasMore = directories.length > visible.length;

        return h(
          'div',
          { className: 'sc-browser' },
          h(
            'div',
            { className: 'sc-browser-head' },
            h(
              'span',
              { className: 'sc-browser-title', title: startFromLibrary ? '库目录' : browser.path || path },
              startFromLibrary ? '库目录' : visibleTrailing(browser.path || path)
            ),
            browser.loading
              ? h('span', { className: 'text-muted' }, '加载中…')
              : null
          ),
          browser.error
            ? h('div', { className: 'sc-browser-error' }, browser.error)
            : null,
          !startFromLibrary && browser.parent
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sc-dir-item sc-dir-parent',
                  onClick: function () {
                    choosePath(browser.parent);
                  },
                },
                '↑ 上一级'
              )
            : null,
          visible.map(function (directory) {
            return h(
              'button',
              {
                type: 'button',
                className: 'sc-dir-item',
                key: directory,
                title: directory,
                onClick: function () {
                  choosePath(directory);
                },
              },
              visibleTrailing(directory)
            );
          }),
          !startFromLibrary && !browser.loading && !browser.error && !visible.length
            ? h(
                'div',
                { className: 'sc-browser-empty text-muted' },
                hiddenCount
                  ? '子文件夹均属于已屏蔽的 Synology 系统项'
                  : '此目录下没有子文件夹'
              )
            : null,
          startFromLibrary && !visible.length
            ? h(
                'div',
                { className: 'sc-browser-empty text-muted' },
                '没有可用的库目录，请直接输入绝对路径'
              )
            : null,
          hasMore
            ? h(
                'div',
                { className: 'sc-browser-empty text-muted' },
                '仅显示前 ' + visible.length + ' 个子文件夹'
              )
            : null,
          hiddenCount
            ? h(
                'div',
                { className: 'sc-browser-empty text-muted' },
                '已屏蔽 ' + hiddenCount + ' 项 Synology 系统项（@eaDir / @SynoEAStream / #recycle）'
              )
            : null
        );
      }

      const pendingCount =
        preview && preview.counts ? preview.counts.pending || 0 : 0;
      const canApply = !!preview && pendingCount > 0 && !busy;

      return h(
        'div',
        { className: 'space-cleaner-page mt-5 pt-3 pb-5' },
        h(
          'div',
          { className: 'sc-header' },
          h('h2', null, '空格清理'),
          h(
            'p',
            { className: 'text-muted mb-0' },
            '检查文件与文件夹名称末尾的多余空格，先预览、再清理。'
          )
        ),
        error
          ? h(
              Alert,
              {
                variant: 'danger',
                dismissible: true,
                onClose: function () {
                  setError(null);
                },
                className: 'mt-3',
              },
              error
            )
          : null,
        h(
          Card,
          { className: 'sc-card mt-3 mb-4' },
          h(
            Card.Body,
            null,
            h(Card.Title, null, '1. 选择目录'),
            h(
              'p',
              { className: 'sc-hint text-muted' },
              '选择 Stash 库目录或任意服务器上的绝对路径。所选目录本身若以空格结尾，也会一并清理。'
            ),
            h(
              InputGroup,
              { className: 'sc-path-input' },
              h(Form.Control, {
                value: path,
                onChange: function (event) {
                  setPath(event.target.value);
                },
                placeholder: '例如 /media/library',
                spellCheck: false,
                disabled: !!busy,
                'aria-label': '要清理的目录路径',
              }),
              h(
                InputGroup.Append,
                null,
                h(
                  Button,
                  {
                    variant: 'secondary',
                    onClick: function () {
                      setBrowserOpen(function (value) {
                        return !value;
                      });
                    },
                    disabled: !!busy,
                  },
                  browserOpen ? '收起浏览' : '浏览目录'
                )
              )
            ),
            /[ \t]$/.test(path)
              ? h(
                  'div',
                  { className: 'sc-path-warning' },
                  '路径末尾包含空格，该空格会被视为目录名的一部分并一并清理。'
                )
              : null,
            libraryPaths.length
              ? h(
                  'div',
                  { className: 'sc-quick-roots' },
                  h('span', { className: 'text-muted mr-2' }, '库目录：'),
                  libraryPaths.map(function (libraryPath) {
                    return h(
                      Button,
                      {
                        key: libraryPath,
                        size: 'sm',
                        variant: 'outline-secondary',
                        className: 'mr-2 mb-2',
                        title: libraryPath,
                        onClick: function () {
                          choosePath(libraryPath);
                        },
                        disabled: !!busy,
                      },
                      visibleTrailing(libraryPath)
                    );
                  })
                )
              : null,
            renderBrowser(),
            h(
              'div',
              { className: 'sc-options' },
              h(Form.Check, {
                type: 'switch',
                id: 'sc-recursive',
                label: '递归处理子目录',
                checked: recursive,
                onChange: function (event) {
                  setRecursive(event.target.checked);
                },
                disabled: !!busy,
              }),
              h(
                Form.Group,
                { className: 'sc-targets' },
                h(Form.Label, { className: 'sc-label' }, '清理对象'),
                h(Form.Check, {
                  inline: true,
                  type: 'radio',
                  id: 'sc-target-both',
                  name: 'sc-targets',
                  label: '文件与文件夹',
                  checked: targets === 'both',
                  onChange: function () {
                    setTargets('both');
                  },
                  disabled: !!busy,
                }),
                h(Form.Check, {
                  inline: true,
                  type: 'radio',
                  id: 'sc-target-files',
                  name: 'sc-targets',
                  label: '仅文件',
                  checked: targets === 'files',
                  onChange: function () {
                    setTargets('files');
                  },
                  disabled: !!busy,
                }),
                h(Form.Check, {
                  inline: true,
                  type: 'radio',
                  id: 'sc-target-folders',
                  name: 'sc-targets',
                  label: '仅文件夹',
                  checked: targets === 'folders',
                  onChange: function () {
                    setTargets('folders');
                  },
                  disabled: !!busy,
                })
              )
            ),
            h(
              'div',
              { className: 'sc-actions' },
              h(
                Button,
                {
                  variant: 'primary',
                  onClick: function () {
                    execute('preview');
                  },
                  disabled: !!busy || !path,
                },
                '预览待清理项'
              ),
              h(
                Button,
                {
                  variant: 'danger',
                  onClick: function () {
                    setConfirmOpen(true);
                  },
                  disabled: !canApply,
                  title: busy
                    ? '正在处理中'
                    : !preview
                      ? '请先预览'
                      : pendingCount === 0
                        ? '没有待清理项'
                        : '',
                },
                '执行清理'
              ),
              busy
                ? h(
                    'div',
                    { className: 'sc-busy' },
                    h('span', { className: 'sc-spinner', 'aria-hidden': 'true' }),
                    h(
                      'span',
                      null,
                      busy === 'preview' ? '正在扫描目录…' : '正在执行清理…'
                    ),
                    h('span', { className: 'text-muted' }, '已用时 ' + elapsed + ' 秒')
                  )
                : null,
              preview && !busy
                ? h(
                    'span',
                    { className: 'text-muted' },
                    '预览基于当前目录与选项；执行时会重新检查。'
                  )
                : null
            )
          )
        ),
        preview ? renderReportCard(preview, false) : null,
        result ? renderReportCard(result, true) : null,
        h(
          Card,
          { className: 'sc-card mb-4' },
          h(
            Card.Body,
            null,
            h(Card.Title, null, '处理规则'),
            h(
              'ul',
              { className: 'sc-rules' },
              h('li', null, '文件夹：删除名称末尾的空格或 Tab，例如 ', h('code', null, '测试路径 '), ' → ', h('code', null, '测试路径'), '。'),
              h('li', null, '文件：删除扩展名前与名称末尾的空格，例如 ', h('code', null, '测试文件 .png'), ' → ', h('code', null, '测试文件.png'), '。'),
              h('li', null, '除常规空格/Tab 外，也会清理不换行空格、全角空格、零宽空格等 Unicode 空白字符。'),
              h('li', null, '名称末尾的私用区字符（如 U+F028）、控制/格式字符等不可见字符同样会被清理；仅处理末尾，名称中间的同名字符保留。'),
              h('li', null, '自动跳过 Synology 系统项：@eaDir、@SynoEAStream、#recycle。'),
              h('li', null, '默认递归处理子目录，可关闭为仅处理当前目录。'),
              h('li', null, '目标名称已存在时自动跳过，不会主动覆盖。'),
              h('li', null, '只修改文件系统名称，不修改 Stash 数据库；清理后建议重新扫描相关目录。')
            )
          )
        ),
        h(
          Modal,
          {
            show: confirmOpen,
            onHide: function () {
              setConfirmOpen(false);
            },
            centered: true,
          },
          h(
            Modal.Header,
            { closeButton: true },
            h(Modal.Title, null, '确认执行清理')
          ),
          h(
            Modal.Body,
            null,
            h('p', null, '将处理目录：'),
            h(
              'pre',
              { className: 'sc-modal-path' },
              visibleTrailing((preview && preview.root) || path)
            ),
            h(
              'p',
              null,
              '预览命中 ',
              h('strong', null, String(pendingCount)),
              ' 项。执行时会重新检查目录，若目标名称已存在则跳过，不会主动覆盖。'
            ),
            h(
              'p',
              { className: 'text-danger mb-0' },
              '此操作会直接重命名磁盘上的文件与文件夹，无法自动撤销。'
            )
          ),
          h(
            Modal.Footer,
            null,
            h(
              Button,
              {
                variant: 'secondary',
                onClick: function () {
                  setConfirmOpen(false);
                },
              },
              '取消'
            ),
            h(
              Button,
              {
                variant: 'danger',
                onClick: function () {
                  setConfirmOpen(false);
                  execute('apply');
                },
              },
              '确认清理'
            )
          )
        )
      );
    }

    class SpaceCleanerErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error, info) {
        console.error('[SpaceCleaner] 页面渲染失败', error, info);
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'space-cleaner-page mt-5 pt-3 pb-5' },
            h(
              Alert,
              { variant: 'danger' },
              'SpaceCleaner 页面加载失败：' +
                (this.state.error.message || String(this.state.error))
            )
          );
        }
        return this.props.children;
      }
    }

    function SpaceCleanerRoute() {
      return h(SpaceCleanerErrorBoundary, null, h(SpaceCleanerPage));
    }

    pluginApi.register.route(ROUTE, SpaceCleanerRoute);

    if (pluginApi.patch && pluginApi.patch.after) {
      // React calls function components with (props, legacyContext), so the
      // rendered node is the last argument, not necessarily the second one.
      pluginApi.patch.after('MainNavBar.UtilityItems', function () {
        const args = Array.prototype.slice.call(arguments);
        const rendered = args[args.length - 1];
        try {
          return h(
            React.Fragment,
            null,
            rendered,
            h(
              NavLink,
              {
                className: 'nav-utility',
                exact: true,
                to: ROUTE,
                title: '空格清理',
                'aria-label': '空格清理',
              },
              h(
                Button,
                { className: 'minimal d-flex align-items-center h-100' },
                h(
                  'svg',
                  {
                    width: 16,
                    height: 16,
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 2,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                    'aria-hidden': 'true',
                  },
                  h('path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z' }),
                  h('path', { d: 'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z' })
                )
              )
            )
          );
        } catch (err) {
          console.error('[SpaceCleaner] 导航入口渲染失败', err);
          return rendered;
        }
      });
    }

    console.log('[SpaceCleaner] UI 控制面板已加载');
  }

  function bootstrap() {
    if (!window.PluginApi) {
      setTimeout(bootstrap, 50);
      return;
    }
    if (window[INIT_FLAG]) return;
    window[INIT_FLAG] = true;
    try {
      init(window.PluginApi);
    } catch (err) {
      console.error('[SpaceCleaner] 初始化失败', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
