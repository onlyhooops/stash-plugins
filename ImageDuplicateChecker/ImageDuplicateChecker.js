/**
 * Image Duplicate Checker - Stash 图片重复检测插件
 * 依赖 Stash 提供 findDuplicateImages(distance: Int) GraphQL 查询；若未提供则按 checksum 降级。
 * 仅处理 Image 实体（图片），不包含压缩包、PDF；检测时已排除压缩包内的图片，仅统计库内独立文件。
 */
(function() {
  'use strict';

  const ROUTE_PATH = '/plugin/image-duplicate-checker';
  const GRAPHQL_ENDPOINT = '/graphql';
  const ROOT_ID = 'image-duplicate-checker-root';
  const SCAN_STATE_KEY = 'idc_scan_state';
  const SCAN_STALE_MS = 10 * 60 * 1000;

  function getScanState() {
    try {
      var raw = sessionStorage.getItem(SCAN_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function setScanState(update) {
    try {
      var cur = getScanState() || {};
      var next = { ...cur, ...update };
      sessionStorage.setItem(SCAN_STATE_KEY, JSON.stringify(next));
    } catch (e) {}
  }

  async function graphqlRequest(query, variables) {
    try {
      const res = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ query: query, variables: variables || {} })
      });
      const data = await res.json();
      if (data.errors && data.errors.length) return { errors: data.errors };
      return { data: data.data };
    } catch (e) {
      return { errors: [{ message: String(e.message || e) }] };
    }
  }

  function withTimeout(promise, ms) {
    return new Promise(function(resolve, reject) {
      var t = setTimeout(function() { reject(new Error('Request timeout')); }, ms);
      promise.then(function(r) { clearTimeout(t); resolve(r); }, function(e) { clearTimeout(t); reject(e); });
    });
  }

  /** 请求重复图片组（需 Stash 支持 findDuplicateImages） */
  async function fetchDuplicateGroups(distance) {
    const query = `
      query FindDuplicateImages($distance: Int) {
        findDuplicateImages(distance: $distance) {
          id
          title
          paths { thumbnail preview image }
          visual_files {
            ... on ImageFile {
              width
              height
              size
              mod_time
            }
          }
          galleries { id title }
          tags { id name }
        }
      }
    `;
    return graphqlRequest(query, { distance: distance ?? 0 });
  }

  /** 仅考虑「非压缩包内」的图片：Stash ImageFilterType.files_filter.zip_file IS_NULL */
  var EXCLUDE_ZIP_IMAGE_FILTER = { files_filter: { zip_file: { modifier: 'IS_NULL', value: [] } } };

  /** 用 findImages 拉取图片并按 checksum（fingerprint）分组，仅包含非压缩包内图片；pathFilter 可选；onProgress 每页后回调 */
  async function fetchDuplicateGroupsByChecksum(pathFilter, onProgress) {
    var perPage = 200;
    var maxPages = 100;
    var imageFragment = [
      'id', 'title', 'paths { thumbnail preview image }',
      'visual_files { ... on ImageFile { width height size mod_time fingerprints { type value } } }',
      'galleries { id title }', 'tags { id name }'
    ].join(' ');
    var imageFilter = pathFilter && pathFilter.trim()
      ? { AND: [ EXCLUDE_ZIP_IMAGE_FILTER, { path: { value: pathFilter.trim(), modifier: 'INCLUDES' } } ] }
      : EXCLUDE_ZIP_IMAGE_FILTER;
    var all = [];
    var page = 1;
    var totalCount = null;
    while (page <= maxPages) {
      var query = [
        'query FindImagesPage($filter: FindFilterType, $image_filter: ImageFilterType) {',
        '  findImages(filter: $filter, image_filter: $image_filter) { count images { ' + imageFragment + ' } }',
        '}'
      ].join('');
      var res = await graphqlRequest(query, {
        filter: { per_page: perPage, page: page },
        image_filter: imageFilter
      });
      if (res.errors || !res.data || !res.data.findImages) return { errors: res.errors || [{ message: 'findImages failed' }] };
      var list = res.data.findImages.images || [];
      all = all.concat(list);
      totalCount = res.data.findImages.count || 0;
      if (typeof onProgress === 'function') onProgress(page, all.length, totalCount);
      if (all.length >= totalCount || list.length < perPage) break;
      page++;
    }
    function getFileFingerprint(img) {
      const vf = img.visual_files;
      const file = (Array.isArray(vf) && vf[0]) ? vf[0] : null;
      if (!file || !file.fingerprints || !file.fingerprints.length) return null;
      const fp = file.fingerprints.find(function(f) { return f.type === 'md5' || f.type === 'checksum'; }) || file.fingerprints[0];
      return fp && fp.value ? fp.value : null;
    }
    const byHash = {};
    all.forEach(function(img) {
      const key = getFileFingerprint(img);
      if (!key) return;
      if (!byHash[key]) byHash[key] = [];
      byHash[key].push(img);
    });
    const groups = Object.keys(byHash).filter(function(k) { return byHash[k].length > 1; }).map(function(k) { return byHash[k]; });
    return { data: { findDuplicateImages: groups } };
  }

  /** 拉取库内文件夹列表，用于路径交互式选择 */
  async function fetchFolders() {
    var perPage = 1000;
    var query = [
      'query FindFolders($filter: FindFilterType, $folder_filter: FolderFilterType) {',
      '  findFolders(filter: $filter, folder_filter: $folder_filter) { count folders { id path } }',
      '}'
    ].join('');
    var res = await graphqlRequest(query, {
      filter: { per_page: perPage, page: 1 },
      folder_filter: {}
    });
    if (res.errors || !res.data || !res.data.findFolders) return [];
    return (res.data.findFolders.folders || []).map(function(f) { return { id: f.id, path: f.path || '' }; }).filter(function(f) { return f.path; });
  }

  /** 请求缺少 phash 的图片数量（仅非压缩包内图片） */
  async function fetchMissingPhashCount() {
    const query = `
      query FindImagesMissingPhash($filter: FindFilterType, $image_filter: ImageFilterType) {
        findImages(filter: $filter, image_filter: $image_filter) {
          count
        }
      }
    `;
    const res = await graphqlRequest(query, {
      filter: { per_page: 0 },
      image_filter: { AND: [ EXCLUDE_ZIP_IMAGE_FILTER, { is_missing: 'phash', file_count: { value: 0, modifier: 'GREATER_THAN' } } ] }
    });
    if (res.errors) return 0;
    return res.data?.findImages?.count ?? 0;
  }

  /** 批量删除图片 */
  async function destroyImages(ids, deleteFile) {
    const query = `
      mutation ImagesDestroy($input: ImagesDestroyInput!) {
        imagesDestroy(input: $input)
      }
    `;
    return graphqlRequest(query, {
      input: { ids: ids, delete_file: !!deleteFile }
    });
  }

  function getImageFile(img) {
    const vf = img.visual_files;
    return (Array.isArray(vf) && vf[0]) ? vf[0] : null;
  }

  function getImageSize(img) {
    const f = getImageFile(img);
    return f && typeof f.size === 'number' ? f.size : 0;
  }

  function getImageResolution(img) {
    const f = getImageFile(img);
    if (!f || f.width == null || f.height == null) return 0;
    return f.width * f.height;
  }

  function getImageModTime(img) {
    const f = getImageFile(img);
    if (!f || !f.mod_time) return 0;
    return new Date(f.mod_time).getTime();
  }

  function findLargestInGroup(group) {
    return group.reduce((a, b) => getImageSize(a) >= getImageSize(b) ? a : b);
  }

  function findLargestResolutionInGroup(group) {
    return group.reduce((a, b) => getImageResolution(a) >= getImageResolution(b) ? a : b);
  }

  function findByAgeInGroup(group, oldest) {
    return group.reduce((a, b) => {
      const ta = getImageModTime(a);
      const tb = getImageModTime(b);
      return oldest ? (ta <= tb ? a : b) : (ta >= tb ? a : b);
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function formatResolution(img) {
    const f = getImageFile(img);
    if (!f) return '—';
    return (f.width || 0) + '×' + (f.height || 0);
  }

  let mountInstance = null;

  function unmount() {
    if (mountInstance && mountInstance.unmount) mountInstance.unmount();
    mountInstance = null;
  }

  function mount(rootEl) {
    if (!rootEl) return;
    unmount();

    let state = {
      distance: 0,
      groups: [],
      loading: false,
      apiMissing: false,
      useChecksumFallback: false,
      errorMessage: null,
      missingPhashCount: 0,
      checked: {},
      page: 1,
      pageSize: 20,
      deleting: false,
      deleteConfirm: null,
      pathFilter: '',
      folders: [],
      foldersLoaded: false,
      hasScanned: false,
      scanProgress: null,
      scanStatus: 'idle',
      lastScanResult: null,
      scanPollTimer: null
    };

    function setState(update) {
      state = { ...state, ...update };
      render();
    }

    function loadMissingPhash() {
      fetchMissingPhashCount().then(count => setState({ missingPhashCount: count }));
    }

    function runChecksumFallback() {
      setScanState({ phase: 'checksum', page: 0, totalFetched: 0, totalCount: null });
      function onProgress(page, totalFetched, totalCount) {
        setScanState({ page: page, totalFetched: totalFetched, totalCount: totalCount });
        setState({ scanProgress: { phase: 'checksum', page: page, totalFetched: totalFetched, totalCount: totalCount } });
      }
      fetchDuplicateGroupsByChecksum(state.pathFilter, onProgress).then(function(fallbackRes) {
        if (fallbackRes.errors) {
          setScanState({ inProgress: false, completedAt: Date.now(), error: (fallbackRes.errors[0] && fallbackRes.errors[0].message) || '按 checksum 扫码失败' });
          setState({
            loading: false,
            groups: [],
            apiMissing: false,
            useChecksumFallback: false,
            hasScanned: true,
            scanProgress: null,
            errorMessage: (fallbackRes.errors[0] && fallbackRes.errors[0].message) || '按 checksum 扫码失败，请检查路径筛选或 GraphQL 接口'
          });
          return;
        }
        var raw = fallbackRes.data && fallbackRes.data.findDuplicateImages;
        var groups = Array.isArray(raw) ? raw : [];
        setScanState({ inProgress: false, completedAt: Date.now(), groupCount: groups.length, error: null });
        setState({ loading: false, groups: groups, checked: {}, useChecksumFallback: true, hasScanned: true, scanProgress: null });
        loadMissingPhash();
      }).catch(function(e) {
        var errMsg = (e && e.message) || '扫码异常';
        setScanState({ inProgress: false, completedAt: Date.now(), error: errMsg });
        setState({ loading: false, groups: [], hasScanned: true, scanProgress: null, errorMessage: errMsg });
      });
    }

    function load() {
      setScanState({ inProgress: true, phase: 'api', startedAt: Date.now(), page: 0, totalFetched: 0, totalCount: null, error: null });
      setState({ loading: true, apiMissing: false, useChecksumFallback: false, errorMessage: null, lastScanResult: null, scanProgress: null });
      var apiPromise = withTimeout(fetchDuplicateGroups(state.distance), 8000);
      apiPromise.then(function(res) {
        if (res.errors) {
          var msg = (res.errors[0] && res.errors[0].message) || '';
          var apiMissing = /findDuplicateImages|Unknown field|Cannot query field|Request timeout/i.test(msg);
          if (apiMissing) {
            runChecksumFallback();
            return;
          }
          setScanState({ inProgress: false, completedAt: Date.now(), error: msg });
          setState({ loading: false, groups: [], hasScanned: true, scanProgress: null, errorMessage: msg });
          loadMissingPhash();
          return;
        }
        var raw = res.data && res.data.findDuplicateImages;
        var groups = Array.isArray(raw) ? raw : [];
        setScanState({ inProgress: false, completedAt: Date.now(), groupCount: groups.length, error: null });
        setState({ loading: false, groups: groups, checked: {}, hasScanned: true, scanProgress: null });
        loadMissingPhash();
      }).catch(function(e) {
        runChecksumFallback();
      });
    }

    function getFilteredGroups() {
      const start = (state.page - 1) * state.pageSize;
      return state.groups.slice(start, start + state.pageSize);
    }

    function checkedCount() {
      return Object.keys(state.checked).filter(id => state.checked[id]).length;
    }

    function resetChecked() {
      const next = {};
      Object.keys(state.checked).forEach(id => { next[id] = false; });
      setState({ checked: next });
    }

    function selectAllButLargest() {
      const next = {};
      getFilteredGroups().forEach(group => {
        const keep = findLargestInGroup(group);
        group.forEach(img => { if (img.id !== keep.id) next[img.id] = true; });
      });
      setState({ checked: next });
    }

    function selectAllButLargestResolution() {
      const next = {};
      getFilteredGroups().forEach(group => {
        const keep = findLargestResolutionInGroup(group);
        group.forEach(img => { if (img.id !== keep.id) next[img.id] = true; });
      });
      setState({ checked: next });
    }

    function selectByAge(oldest) {
      const next = {};
      getFilteredGroups().forEach(group => {
        const keep = findByAgeInGroup(group, oldest);
        group.forEach(img => { if (img.id !== keep.id) next[img.id] = true; });
      });
      setState({ checked: next });
    }

    function selectNone() {
      setState({ checked: {} });
    }

    function toggleCheck(id, checked) {
      setState({ checked: { ...state.checked, [id]: checked } });
    }

    function deleteChecked() {
      const ids = Object.keys(state.checked).filter(id => state.checked[id]);
      if (!ids.length) return;
      setState({ deleteConfirm: { ids, deleteFile: false } });
    }

    function cancelDelete() {
      setState({ deleteConfirm: null });
    }

    function confirmDelete(deleteFile) {
      const { ids } = state.deleteConfirm || {};
      if (!ids || !ids.length) { setState({ deleteConfirm: null }); return; }
      setState({ deleting: true });
      destroyImages(ids, deleteFile).then(res => {
        setState({ deleting: false, deleteConfirm: null });
        if (res.errors) {
          setState({ errorMessage: (res.errors[0] && res.errors[0].message) || 'Delete failed' });
        } else {
          resetChecked();
          load();
        }
      });
    }

    function render() {
      rootEl.innerHTML = '';
      const container = document.createElement('div');
      container.className = 'idc-container';

      const title = document.createElement('h2');
      title.className = 'idc-title';
      title.textContent = '图片重复检测 (Image Duplicate Checker)';
      container.appendChild(title);

      if (state.apiMissing && !state.useChecksumFallback) {
        const box = document.createElement('div');
        box.className = 'idc-alert idc-alert-warning';
        box.innerHTML = '<strong>当前 Stash 未提供 findDuplicateImages 接口。</strong> 请先为 Stash 添加 <code>findDuplicateImages(distance: Int): [[Image!]!]!</code> GraphQL 查询（或等待上游支持），再使用本插件。';
        container.appendChild(box);
        rootEl.appendChild(container);
        return;
      }

      if (state.useChecksumFallback) {
        const info = document.createElement('div');
        info.className = 'idc-alert idc-alert-info';
        info.textContent = '当前为按 checksum 精确重复检测（降级模式）：仅识别文件完全相同的重复，不支持视觉相似；已排除压缩包内图片，仅统计库内独立文件。若 Stash 支持 findDuplicateImages 后将自动使用 phash 检测。';
        container.appendChild(info);
      }

      const toolbar = document.createElement('div');
      toolbar.className = 'idc-toolbar';
      if (!state.useChecksumFallback) {
        const distanceLabel = document.createElement('label');
        distanceLabel.textContent = '匹配精度：';
        const distanceSelect = document.createElement('select');
        distanceSelect.className = 'idc-select';
        [['0', '精确'], ['1', '高'], ['2', '中'], ['3', '低']].forEach(([val, text]) => {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = text;
          if (Number(val) === state.distance) opt.selected = true;
          distanceSelect.appendChild(opt);
        });
        distanceSelect.addEventListener('change', function() {
          setState({ distance: Number(distanceSelect.value), page: 1 });
        });
        toolbar.appendChild(distanceLabel);
        toolbar.appendChild(distanceSelect);
      }
      const startBtn = document.createElement('button');
      startBtn.className = 'idc-btn idc-btn-primary';
      startBtn.textContent = state.groups.length ? '重新扫描' : '开始扫描';
      startBtn.addEventListener('click', function() { load(); });
      toolbar.appendChild(startBtn);
      container.appendChild(toolbar);

      const pathRow = document.createElement('div');
      pathRow.className = 'idc-toolbar idc-path-row';
      const pathLabel = document.createElement('label');
      pathLabel.textContent = '扫描范围（可选）：';
      const pathSelect = document.createElement('select');
      pathSelect.className = 'idc-select idc-path-select';
      if (!state.foldersLoaded) {
        var loadingOpt = document.createElement('option');
        loadingOpt.value = '';
        loadingOpt.textContent = '加载路径列表…';
        pathSelect.appendChild(loadingOpt);
      } else {
        var allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = '全部路径';
        pathSelect.appendChild(allOpt);
        (state.folders || []).forEach(function(f) {
          var opt = document.createElement('option');
          opt.value = f.path;
          opt.textContent = f.path;
          if (state.pathFilter === f.path) opt.selected = true;
          pathSelect.appendChild(opt);
        });
      }
      pathSelect.disabled = !state.foldersLoaded;
      pathSelect.addEventListener('change', function(e) { setState({ pathFilter: e.target.value }); });
      pathRow.appendChild(pathLabel);
      pathRow.appendChild(pathSelect);
      container.appendChild(pathRow);

      if (state.missingPhashCount > 0) {
        const warn = document.createElement('div');
        warn.className = 'idc-alert idc-alert-info';
        warn.textContent = '有 ' + state.missingPhashCount + ' 张图片尚未生成 phash，请先在设置中运行「生成图片 phash」任务。';
        container.appendChild(warn);
      }

      if (state.errorMessage && !state.apiMissing) {
        const err = document.createElement('div');
        err.className = 'idc-alert idc-alert-danger';
        err.textContent = state.errorMessage;
        container.appendChild(err);
      }

      if (state.hasScanned || state.groups.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'idc-actions';
        const btnSelectLargest = document.createElement('button');
        btnSelectLargest.className = 'idc-btn idc-btn-secondary';
        btnSelectLargest.textContent = '勾选除最大文件外的项';
        btnSelectLargest.addEventListener('click', selectAllButLargest);
        const btnSelectRes = document.createElement('button');
        btnSelectRes.className = 'idc-btn idc-btn-secondary';
        btnSelectRes.textContent = '勾选除最高分辨率外的项';
        btnSelectRes.addEventListener('click', selectAllButLargestResolution);
        const btnOldest = document.createElement('button');
        btnOldest.className = 'idc-btn idc-btn-secondary';
        btnOldest.textContent = '勾选除最旧外的项';
        btnOldest.addEventListener('click', () => selectByAge(true));
        const btnNewest = document.createElement('button');
        btnNewest.className = 'idc-btn idc-btn-secondary';
        btnNewest.textContent = '勾选除最新外的项';
        btnNewest.addEventListener('click', () => selectByAge(false));
        const btnNone = document.createElement('button');
        btnNone.className = 'idc-btn idc-btn-secondary';
        btnNone.textContent = '全部取消勾选';
        btnNone.addEventListener('click', selectNone);
        const btnDelete = document.createElement('button');
        btnDelete.className = 'idc-btn idc-btn-danger';
        btnDelete.textContent = '删除已勾选';
        btnDelete.addEventListener('click', deleteChecked);
        const count = checkedCount();
        if (count > 0) btnDelete.textContent = '删除已勾选 (' + count + ')';
        actions.append(btnSelectLargest, btnSelectRes, btnOldest, btnNewest, btnNone, btnDelete);
        container.appendChild(actions);
      }

      if (state.loading || state.scanStatus === 'running' || state.lastScanResult) {
        const statusBox = document.createElement('div');
        statusBox.className = 'idc-scan-status';
        if (state.loading || state.scanStatus === 'running') {
          const phaseLabel = state.scanProgress && state.scanProgress.phase === 'checksum' ? '按 checksum 拉取图片' : '正在请求接口';
          let text = state.scanStatus === 'running' ? '扫描进行中（后台）… ' : '扫描进行中… ';
          text += phaseLabel;
          if (state.scanProgress && state.scanProgress.phase === 'checksum' && state.scanProgress.totalFetched != null) {
            text += '，已获取 ' + state.scanProgress.totalFetched + ' 张图片';
            if (state.scanProgress.totalCount != null) text += ' / 共 ' + state.scanProgress.totalCount;
            if (state.scanProgress.page != null) text += '（第 ' + state.scanProgress.page + ' 页）';
          } else {
            text += '…';
          }
          statusBox.textContent = text;
          statusBox.classList.add('idc-scan-status-running');
        } else if (state.lastScanResult) {
          if (state.lastScanResult.error) {
            statusBox.textContent = '上次扫描失败：' + state.lastScanResult.error;
            statusBox.classList.add('idc-scan-status-error');
          } else {
            var timeStr = state.lastScanResult.completedAt ? new Date(state.lastScanResult.completedAt).toLocaleString() : '';
            statusBox.textContent = '上次扫描于 ' + timeStr + ' 完成，发现 ' + (state.lastScanResult.groupCount ?? 0) + ' 组重复。请点击「重新扫描」查看结果。';
            statusBox.classList.add('idc-scan-status-done');
          }
        }
        container.appendChild(statusBox);
      }

      if (state.hasScanned || state.groups.length > 0) {
        const paginationTop = document.createElement('div');
        paginationTop.className = 'idc-pagination';
        const total = state.groups.length;
        const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
        const pageSizeSelect = document.createElement('select');
        pageSizeSelect.className = 'idc-select idc-page-size';
        [10, 20, 50, 100].forEach(n => {
          const o = document.createElement('option');
          o.value = n;
          o.textContent = n + ' 组/页';
          if (n === state.pageSize) o.selected = true;
          pageSizeSelect.appendChild(o);
        });
        pageSizeSelect.addEventListener('change', () => {
          setState({ pageSize: Number(pageSizeSelect.value), page: 1 });
        });
        const pageInfo = document.createElement('span');
        pageInfo.className = 'idc-page-info';
        pageInfo.textContent = '第 ' + state.page + ' / ' + totalPages + ' 页，共 ' + total + ' 组';
        paginationTop.appendChild(pageSizeSelect);
        paginationTop.appendChild(pageInfo);
        container.appendChild(paginationTop);

        const tableWrap = document.createElement('div');
        tableWrap.className = 'idc-table-wrap';
        const table = document.createElement('table');
        table.className = 'idc-table';
        table.innerHTML = '<thead><tr><th>勾选</th><th>缩略图</th><th>详情</th><th>分辨率</th><th>大小</th><th>操作</th></tr></thead><tbody></tbody>';
        const tbody = table.querySelector('tbody');

        getFilteredGroups().forEach((group, gi) => {
          group.forEach((img, ii) => {
            const tr = document.createElement('tr');
            const file = getImageFile(img);
            const thumb = (img.paths && img.paths.thumbnail) ? img.paths.thumbnail : (img.paths && img.paths.preview) ? img.paths.preview : '';
            const title = img.title || ('Image #' + img.id);
            const res = formatResolution(img);
            const size = formatSize(getImageSize(img));
            tr.innerHTML =
              '<td class="idc-cell-check"><input type="checkbox" class="idc-checkbox" data-id="' + img.id + '"></td>' +
              '<td class="idc-cell-thumb">' + (thumb ? '<img src="' + thumb + '" alt="" class="idc-thumb">' : '—') + '</td>' +
              '<td class="idc-cell-detail"><a href="/images/' + img.id + '" target="_blank">' + escapeHtml(title) + '</a></td>' +
              '<td class="idc-cell-res">' + res + '</td>' +
              '<td class="idc-cell-size">' + size + '</td>' +
              '<td class="idc-cell-actions"><button type="button" class="idc-btn idc-btn-sm idc-btn-danger idc-btn-delete-one" data-id="' + img.id + '">删除</button></td>';
            const cb = tr.querySelector('.idc-checkbox');
            cb.checked = !!state.checked[img.id];
            cb.addEventListener('change', e => toggleCheck(img.id, e.target.checked));
            tr.querySelector('.idc-btn-delete-one').addEventListener('click', () => {
              setState({ checked: { ...state.checked, [img.id]: true } });
              setState({ deleteConfirm: { ids: [img.id], deleteFile: false } });
            });
            tbody.appendChild(tr);
          });
        });

        tableWrap.appendChild(table);
        container.appendChild(tableWrap);

        if (state.groups.length === 0 && !state.loading) {
          const empty = document.createElement('p');
          empty.className = 'idc-empty';
          empty.textContent = state.hasScanned ? '未发现重复图片。' : '选择扫描范围（可选）后点击「开始扫描」。';
          container.appendChild(empty);
        }

        const paginationBottom = document.createElement('div');
        paginationBottom.className = 'idc-pagination';
        const prevBtn = document.createElement('button');
        prevBtn.className = 'idc-btn idc-btn-secondary';
        prevBtn.textContent = '上一页';
        prevBtn.disabled = state.page <= 1;
        prevBtn.addEventListener('click', () => setState({ page: state.page - 1 }));
        const nextBtn = document.createElement('button');
        nextBtn.className = 'idc-btn idc-btn-secondary';
        nextBtn.textContent = '下一页';
        nextBtn.disabled = state.page >= totalPages;
        nextBtn.addEventListener('click', () => setState({ page: state.page + 1 }));
        paginationBottom.appendChild(prevBtn);
        paginationBottom.appendChild(nextBtn);
        container.appendChild(paginationBottom);
      } else {
        const empty = document.createElement('p');
        empty.className = 'idc-empty';
        empty.textContent = '选择扫描范围（可选）后点击「开始扫描」。';
        container.appendChild(empty);
      }

      if (state.deleteConfirm) {
        const overlay = document.createElement('div');
        overlay.className = 'idc-modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'idc-modal';
        modal.innerHTML =
          '<p class="idc-modal-title">确认删除 ' + state.deleteConfirm.ids.length + ' 张图片？</p>' +
          '<p class="idc-modal-hint">可选：同时从磁盘删除文件。</p>' +
          '<div class="idc-modal-actions"></div>';
        const act = modal.querySelector('.idc-modal-actions');
        const btnCancel = document.createElement('button');
        btnCancel.className = 'idc-btn idc-btn-secondary';
        btnCancel.textContent = '取消';
        btnCancel.addEventListener('click', cancelDelete);
        const btnDbOnly = document.createElement('button');
        btnDbOnly.className = 'idc-btn idc-btn-danger';
        btnDbOnly.textContent = '仅从库中删除';
        btnDbOnly.addEventListener('click', () => confirmDelete(false));
        const btnWithFile = document.createElement('button');
        btnWithFile.className = 'idc-btn idc-btn-danger';
        btnWithFile.textContent = '删除并删除文件';
        btnWithFile.addEventListener('click', () => confirmDelete(true));
        act.append(btnCancel, btnDbOnly, btnWithFile);
        overlay.appendChild(modal);
        overlay.addEventListener('click', e => { if (e.target === overlay) cancelDelete(); });
        container.appendChild(overlay);
      }

      if (state.deleting) {
        const overlay = document.createElement('div');
        overlay.className = 'idc-modal-overlay idc-loading-overlay';
        overlay.innerHTML = '<div class="idc-loading-spinner">删除中…</div>';
        container.appendChild(overlay);
      }

      rootEl.appendChild(container);
    }

    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }

    // 恢复 sessionStorage 中的扫描状态（用户扫码中离开再返回时展示进度）
    var stored = getScanState();
    if (stored && stored.inProgress && stored.startedAt && (Date.now() - stored.startedAt < SCAN_STALE_MS)) {
      state.scanStatus = 'running';
      state.scanProgress = (stored.totalFetched != null)
        ? { phase: stored.phase || 'checksum', page: stored.page, totalFetched: stored.totalFetched, totalCount: stored.totalCount }
        : { phase: stored.phase || 'api', page: 0, totalFetched: 0, totalCount: null };
    } else if (stored && stored.completedAt != null && (Date.now() - stored.completedAt < SCAN_STALE_MS)) {
      state.lastScanResult = { completedAt: stored.completedAt, groupCount: stored.groupCount, error: stored.error };
    }

    mountInstance = {
      unmount: function() {
        if (this.scanPollTimer) clearInterval(this.scanPollTimer);
        this.scanPollTimer = null;
        rootEl.innerHTML = '';
      }
    };

    if (state.scanStatus === 'running') {
      mountInstance.scanPollTimer = setInterval(function() {
        var s = getScanState();
        if (!s || !s.inProgress) {
          if (mountInstance.scanPollTimer) clearInterval(mountInstance.scanPollTimer);
          mountInstance.scanPollTimer = null;
          state.scanStatus = 'idle';
          if (s && s.completedAt != null) state.lastScanResult = { completedAt: s.completedAt, groupCount: s.groupCount, error: s.error };
          state.scanProgress = null;
          setState({});
          return;
        }
        state.scanProgress = (s.totalFetched != null)
          ? { phase: s.phase || 'checksum', page: s.page, totalFetched: s.totalFetched, totalCount: s.totalCount }
          : { phase: s.phase || 'api', page: 0, totalFetched: 0, totalCount: null };
        setState({});
      }, 1500);
    }

    setState({});

    if (!state.foldersLoaded) {
      fetchFolders().then(function(list) {
        setState({ folders: list, foldersLoaded: true });
      }).catch(function() {
        setState({ folders: [], foldersLoaded: true });
      });
    }
  }

  function registerRoute() {
    const api = window.PluginApi;
    if (!api || !api.register || !api.register.route) return false;
    const RouteComponent = function() {
      const React = (api && api.React) || window.React;
      if (!React || !React.useRef || !React.useEffect) {
        return React ? React.createElement('div', { id: ROOT_ID }) : null;
      }
      const ref = React.useRef(null);
      React.useEffect(function() {
        if (ref.current) mount(ref.current);
        return function() { unmount(); };
      }, []);
      return React.createElement('div', { id: ROOT_ID, ref: ref });
    };
    try {
      api.register.route(ROUTE_PATH, RouteComponent);
      return true;
    } catch (e) {
      console.warn('[ImageDuplicateChecker] register.route failed:', e);
      return false;
    }
  }

  /** 在设置 → 工具 页面注入「Image Tools」整块，DOM 与类名与原生 Tools/Scene Tools 完全一致 */
  function injectToolsEntry() {
    if (document.getElementById('idc-tools-inject-root')) return;
    var path = window.location.pathname || '';
    if (path.indexOf('settings') === -1 && path.indexOf('tools') === -1) return;
    function findElWithText(node, text) {
      if (!node) return null;
      if (node.nodeType === 3 && node.textContent && node.textContent.trim().indexOf(text) !== -1) return node.parentElement;
      if (node.nodeType === 1) {
        for (var i = 0; i < (node.childNodes && node.childNodes.length) || 0; i++) {
          var found = findElWithText(node.childNodes[i], text);
          if (found) return found;
        }
      }
      return null;
    }
    var sceneToolsHeading = findElWithText(document.body, 'Scene Tools');
    if (!sceneToolsHeading) return;
    var sceneToolsSection = sceneToolsHeading.closest('.setting-section');
    if (!sceneToolsSection || !sceneToolsSection.parentNode) return;
    var section = document.createElement('div');
    section.id = 'idc-tools-inject-root';
    section.className = 'setting-section';
    var h1 = document.createElement('h1');
    h1.textContent = 'Image Tools';
    var card = document.createElement('div');
    card.className = 'card';
    var setting = document.createElement('div');
    setting.className = 'setting  ';
    var left = document.createElement('div');
    var h3 = document.createElement('h3');
    var a = document.createElement('a');
    a.href = ROUTE_PATH;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = 'Image Duplicate Checker';
    a.appendChild(btn);
    h3.appendChild(a);
    left.appendChild(h3);
    setting.appendChild(left);
    setting.appendChild(document.createElement('div'));
    card.appendChild(setting);
    section.appendChild(h1);
    section.appendChild(card);
    a.addEventListener('click', function(e) {
      e.preventDefault();
      if (window.history && window.history.pushState) {
        window.history.pushState({}, '', ROUTE_PATH);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } else {
        window.location.href = ROUTE_PATH;
      }
    });
    sceneToolsSection.parentNode.insertBefore(section, sceneToolsSection.nextSibling);
  }

  function tryRegister() {
    var ok = registerRoute();
    if (ok) {
      console.log('[ImageDuplicateChecker] Route registered at ' + ROUTE_PATH);
      if (window.PluginApi && window.PluginApi.Event && window.PluginApi.Event.addEventListener) {
        window.PluginApi.Event.addEventListener('stash:location', function() {
          setTimeout(injectToolsEntry, 400);
        });
      }
      setTimeout(injectToolsEntry, 800);
    } else {
      var t = setInterval(function() {
        if (registerRoute()) {
          clearInterval(t);
          console.log('[ImageDuplicateChecker] Route registered at ' + ROUTE_PATH);
          setTimeout(injectToolsEntry, 800);
        }
      }, 200);
      setTimeout(function() { clearInterval(t); }, 10000);
    }
  }

  /** 直接打开插件 URL 时若路由未命中导致 Not Found，则主动创建容器并挂载 UI */
  function tryMountFallback() {
    var path = (window.location && window.location.pathname) || '';
    if (path.indexOf('/plugin/image-duplicate-checker') === -1) return;
    var root = document.getElementById(ROOT_ID);
    if (root) {
      if (root.children.length === 0) mount(root);
      return;
    }
    var main = document.querySelector('main') || document.querySelector('#root') || document.body;
    if (!main) return;
    var container = document.createElement('div');
    container.id = ROOT_ID;
    main.innerHTML = '';
    main.appendChild(container);
    mount(container);
  }

  (function bootstrap() {
    tryRegister();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        tryRegister();
        setTimeout(injectToolsEntry, 500);
        setTimeout(tryMountFallback, 600);
      });
    } else {
      setTimeout(injectToolsEntry, 500);
      setTimeout(tryMountFallback, 600);
    }
  })();
})();
