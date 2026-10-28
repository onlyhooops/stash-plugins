/**
 * PowerWall — Stash 原生风格砌墙视图插件
 * @version 1.9.2
 *
 * 砌墙布局：边距(margin)、行距(rowGap)、列距(columnGap)，按行排列、统一行高，
 * 替代自适应瀑布流。支持 /images、/scenes 列表，无限滚动、内置 lightbox、筛选与设置。
 *
 * 参考：Image-Wall与缩放滑块技术调研报告、Image-Lightbox-技术调研报告
 * API：PluginApi.Event 监听 stash:location
 */

(function() {
  'use strict';

  const isMobile = () => window.matchMedia('only screen and (max-width: 576px)').matches;
  const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
  if (isMobile() || isTouch()) return;

  const isListPath = (path) => {
    const p = (path || window.location.pathname).replace(/\/$/, '') || '/';
    return p === '/images' || p === '/scenes';
  };
  const isExcludedPath = (path) => {
    const p = path || window.location.pathname;
    return /^\/(tags|galleries|performers|studios|movies|markers)(\/|$)/.test(p);
  };

  (function hideOriginalImmediately() {
    if (isListPath() && !isExcludedPath() && document.documentElement) {
      document.documentElement.classList.add('power-wall-preload');
    }
  })();

  // ==================== 配置 ====================
  const STORAGE_KEY = 'PowerWall_config';
  /** 缩放档位列宽（像素），0=最小/多列 … 5=最大/少列 */
  const ZOOM_WIDTHS = [160, 220, 280, 340, 480, 640];

  /** 布局预设：边距、行距、列距（无缝：无间距；紧凑之上） */
  const LAYOUT_PRESETS = {
    seamless: { margin: 0, rowGap: 0, columnGap: 0, label: '无缝' },
    compact:  { margin: 2, rowGap: 2, columnGap: 2, label: '紧凑' },
    normal:   { margin: 4, rowGap: 4, columnGap: 4, label: '标准' },
    spacious: { margin: 8, rowGap: 8, columnGap: 8, label: '宽松' },
  };

  const DEFAULT_CONFIG = {
    zoomIndex: 2,
    layoutPreset: 'normal',
    margin: 4,
    rowGap: 4,
    columnGap: 4,
    itemsPerPage: 40,
    loadThreshold: 600,
    videoPreviewDelay: 300,
    enableLightbox: true,
    enableOnImages: true,
    enableOnScenes: true,
    /** 视图模式：'wall'=砌墙 / 'original'=原生列表。按页面类型分别记忆，刷新/换页后保持 */
    viewModeImages: 'wall',
    viewModeScenes: 'wall',
    debug: false,
    /** 上次筛选中的排序，用于无 URL 参数时恢复默认 */
    lastSort: 'created_at',
    lastSortDir: 'DESC',
  };

  let _configCache = null;
  function getConfig() {
    if (_configCache) return _configCache;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      _configCache = { ...DEFAULT_CONFIG, ...parsed };
      const preset = LAYOUT_PRESETS[_configCache.layoutPreset];
      if (preset) {
        _configCache.margin = preset.margin;
        _configCache.rowGap = preset.rowGap;
        _configCache.columnGap = preset.columnGap;
      }
      const maxZoom = ZOOM_WIDTHS.length - 1;
      _configCache.zoomIndex = Math.max(0, Math.min(maxZoom, _configCache.zoomIndex));
      _configCache.itemsPerPage = Math.max(12, Math.min(120, _configCache.itemsPerPage || DEFAULT_CONFIG.itemsPerPage));
      return _configCache;
    } catch (e) {
      _configCache = { ...DEFAULT_CONFIG };
      return _configCache;
    }
  }
  /**
   * 合并配置。persist=false 时只更新内存缓存，不写 localStorage —— 供 zoom 滑块 input
   * 这类高频事件使用（一次拖动会有几十个 input 事件，逐个同步落盘会阻塞主线程）。
   */
  function saveConfig(updates, persist = true) {
    const current = getConfig();
    const merged = { ...current, ...updates };
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[PowerWall] 配置保存失败', e);
      }
    }
    _configCache = merged;
    return merged;
  }
  function resetConfig() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    _configCache = null;
    return getConfig();
  }

  function getPreferredColumnWidth() {
    const cfg = getConfig();
    const maxIndex = ZOOM_WIDTHS.length - 1;
    const zoomIndex = Math.max(0, Math.min(maxIndex, cfg.zoomIndex));
    return ZOOM_WIDTHS[zoomIndex];
  }

  const GRAPHQL_ENDPOINT = '/graphql';
  const GRAPHQL_TIMEOUT_MS = 30000;

  function log(...args) {
    if (getConfig().debug) console.log('🧱 [PowerWall]', ...args);
  }
  function error(...args) {
    console.error('🧱 [PowerWall]', ...args);
  }

  async function graphqlRequest(query, variables = {}, options = {}) {
    const { signal: externalSignal } = options;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timeoutId); return null; }
      externalSignal.addEventListener('abort', () => { clearTimeout(timeoutId); controller.abort(); }, { once: true });
    }
    try {
      const response = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (result.errors) {
        const errMsg = result.errors[0]?.message || JSON.stringify(result.errors);
        error('GraphQL错误:', errMsg);
        return null;
      }
      return result.data;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      error('请求失败:', err);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function getPageType() {
    const path = window.location.pathname;
    if (isExcludedPath(path)) return null;
    if (!isListPath(path)) return null;
    const cfg = getConfig();
    const p = path.replace(/\/$/, '') || '/';
    if (p === '/images' && cfg.enableOnImages) return 'images';
    if (p === '/scenes' && cfg.enableOnScenes) return 'scenes';
    return null;
  }

  /** 视图模式记在配置里（按页面类型分开），因此刷新/换页后仍然保持用户的选择 */
  const VIEW_MODE_KEYS = { images: 'viewModeImages', scenes: 'viewModeScenes' };
  function getViewMode(pageType) {
    const key = VIEW_MODE_KEYS[pageType];
    return key && getConfig()[key] === 'original' ? 'original' : 'wall';
  }
  function setViewMode(pageType, mode) {
    const key = VIEW_MODE_KEYS[pageType];
    if (!key) return;
    saveConfig({ [key]: mode === 'original' ? 'original' : 'wall' });
  }

  function parseIdList(val) {
    if (!val || typeof val !== 'string') return [];
    return val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  }

  /** 本插件管理的 URL 参数：首页/清除只删这些，避免连带清掉其它插件或 Stash 自身的参数 */
  const MANAGED_PARAM_KEYS = [
    'q', 'sortby', 'sortdir', 'page',
    'tags', 'tag_ids', 'performers', 'performer_ids',
    'studios', 'studio_ids', 'galleries', 'gallery_ids',
  ];
  function buildHomeUrl() {
    const url = new URL(window.location.href);
    MANAGED_PARAM_KEYS.forEach((key) => url.searchParams.delete(key));
    return url.pathname + url.search;
  }

  function getFilterFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const findFilter = {};
    if (params.has('q')) findFilter.q = params.get('q');
    const cfg = getConfig();
    if (params.has('sortby')) {
      findFilter.sort = params.get('sortby');
      const sortDir = params.get('sortdir') || '';
      findFilter.direction = (sortDir.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
    } else {
      findFilter.sort = cfg.lastSort || 'created_at';
      findFilter.direction = (cfg.lastSortDir || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    }
    const tagIds = parseIdList(params.get('tags') || params.get('tag_ids'));
    const performerIds = parseIdList(params.get('performers') || params.get('performer_ids'));
    const studioIds = parseIdList(params.get('studios') || params.get('studio_ids'));
    const galleryIds = parseIdList(params.get('galleries') || params.get('gallery_ids'));
    const imageFilter = {};
    const sceneFilter = {};
    if (tagIds.length) {
      imageFilter.tags = { value: tagIds.map(String), modifier: 'INCLUDES' };
      sceneFilter.tags = { value: tagIds.map(String), modifier: 'INCLUDES' };
    }
    if (performerIds.length) {
      imageFilter.performers = { value: performerIds.map(String), modifier: 'INCLUDES' };
      sceneFilter.performers = { value: performerIds.map(String), modifier: 'INCLUDES' };
    }
    if (studioIds.length) {
      imageFilter.studios = { value: studioIds.map(String), modifier: 'INCLUDES' };
      sceneFilter.studios = { value: studioIds.map(String), modifier: 'INCLUDES' };
    }
    if (galleryIds.length) {
      imageFilter.galleries = { value: galleryIds.map(String), modifier: 'INCLUDES' };
    }
    return { findFilter, imageFilter, sceneFilter };
  }

  /** 数字简写：999→999, 1000→1K, 1742954→1.7M */
  function formatCountShort(n) {
    if (n == null || n < 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1000000) {
      const k = n / 1000;
      return (k % 1 === 0 ? k : k.toFixed(1)) + 'K';
    }
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  function formatDuration(seconds) {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  function formatResolution(width, height) {
    if (!height) return '';
    if (height >= 2160) return '4K';
    if (height >= 1440) return '2K';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    return `${height}p`;
  }
  function debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  /** 主文档滚动条宽度；overflow:hidden 时为 0 */
  function getScrollbarWidth() {
    return Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  }

  /** 视口真实可用宽度（不含滚动条占据空间），用于与容器宽度对齐 */
  function getViewportAvailableWidth() {
    return document.documentElement.clientWidth;
  }

  /** 是否支持 scrollbar-gutter（若支持则 lightbox 勿再加 padding，避免双重补偿导致左移）*/
  function supportsScrollbarGutterStable() {
    return typeof CSS !== 'undefined' && CSS.supports && CSS.supports('scrollbar-gutter', 'stable');
  }

  // ==================== 内置 Lightbox ====================
  function setInfobarContent(infobarEl, imgName, idx, total, galleryStr, galleryId) {
    const line1 = infobarEl?.querySelector('.power-wall-lightbox-infobar-line1');
    const line2 = infobarEl?.querySelector('.power-wall-lightbox-infobar-line2');
    if (!line1 || !line2) return;
    const counter = `${idx + 1}/${total}`;
    line1.textContent = imgName ? `${imgName} ${counter}` : counter;
    if (galleryStr && galleryId) {
      const a = document.createElement('a');
      a.href = `/galleries/${galleryId}`;
      a.className = 'power-wall-lightbox-gallery-link';
      a.textContent = galleryStr;
      a.target = '_self';
      line2.innerHTML = '';
      line2.appendChild(a);
      line2.style.display = '';
    } else {
      line2.innerHTML = '';
      line2.style.display = galleryStr ? '' : 'none';
      if (galleryStr) line2.textContent = galleryStr;
    }
  }

  /** 鸟瞰图：根据当前 scale/translate 更新可见区域框，scale>1.05 时显示，否则隐藏 */
  function updateMinimap(overlay) {
    if (!overlay?.isConnected) return;
    const minimapEl = overlay.querySelector('.power-wall-lightbox-minimap');
    const viewportEl = overlay.querySelector('.power-wall-lightbox-minimap-viewport');
    const content = overlay.querySelector('.power-wall-lightbox-content');
    const img = overlay.querySelector('.power-wall-lightbox-img');
    const s = overlay._lbState;
    if (!minimapEl || !viewportEl || !content || !img || !s) return;
    const scale = s.scale;
    const show = scale > 1.05;
    if (!show) {
      minimapEl.classList.remove('power-wall-lightbox-minimap-visible');
      return;
    }
    const cRect = content.getBoundingClientRect();
    const cw = cRect.width;
    const ch = cRect.height;
    const imgW0 = img.offsetWidth;
    const imgH0 = img.offsetHeight;
    if (!cw || !ch || !imgW0 || !imgH0) {
      minimapEl.classList.remove('power-wall-lightbox-minimap-visible');
      return;
    }
    const minimapInner = overlay.querySelector('.power-wall-lightbox-minimap-inner');
    if (minimapInner && img.naturalWidth && img.naturalHeight) {
      const aspect = img.naturalWidth / img.naturalHeight;
      minimapInner.style.setProperty('--minimap-aspect', String(aspect));
    }
    const tx = s.translateX;
    const ty = s.translateY;
    const imgLeft = cw / 2 + tx - (imgW0 * scale) / 2;
    const imgTop = ch / 2 + ty - (imgH0 * scale) / 2;
    const imgW = imgW0 * scale;
    const imgH = imgH0 * scale;
    const visLeft = Math.max(0, imgLeft);
    const visTop = Math.max(0, imgTop);
    const visRight = Math.min(cw, imgLeft + imgW);
    const visBottom = Math.min(ch, imgTop + imgH);
    const leftFrac = (visLeft - imgLeft) / imgW;
    const topFrac = (visTop - imgTop) / imgH;
    const widthFrac = (visRight - visLeft) / imgW;
    const heightFrac = (visBottom - visTop) / imgH;
    viewportEl.style.left = (leftFrac * 100).toFixed(2) + '%';
    viewportEl.style.top = (topFrac * 100).toFixed(2) + '%';
    viewportEl.style.width = (widthFrac * 100).toFixed(2) + '%';
    viewportEl.style.height = (heightFrac * 100).toFixed(2) + '%';
    minimapEl.classList.add('power-wall-lightbox-minimap-visible');
  }

  function openBuiltinLightbox(ids, index, type, itemsData) {
    if (!ids?.length || index < 0 || type !== 'images') return;
    const getImageUrl = (id) => `/image/${id}/image`;
    let overlay = document.getElementById('power-wall-lightbox-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'power-wall-lightbox-overlay';
      overlay.className = 'power-wall-lightbox';
      overlay.innerHTML = `
        <div class="power-wall-lightbox-backdrop"></div>
        <div class="power-wall-lightbox-header">
          <div class="power-wall-lightbox-infobar">
            <div class="power-wall-lightbox-infobar-line1"></div>
            <div class="power-wall-lightbox-infobar-line2"></div>
          </div>
          <button type="button" class="power-wall-lightbox-close" title="关闭 (Esc)" aria-label="关闭">${ICONS.close}</button>
        </div>
        <div class="power-wall-lightbox-toolbar">
          <button type="button" class="power-wall-lightbox-btn" data-action="zoom-out" title="缩小">${ICONS.minus}</button>
          <button type="button" class="power-wall-lightbox-btn" data-action="zoom-in" title="放大">${ICONS.plus}</button>
          <button type="button" class="power-wall-lightbox-btn" data-action="toggle-1to1" title="1:1 原图">1:1</button>
        </div>
        <button type="button" class="power-wall-lightbox-prev" title="上一张">${ICONS.chevronLeft}</button>
        <div class="power-wall-lightbox-content">
          <div class="power-wall-lightbox-loading"></div>
          <img class="power-wall-lightbox-img" alt="" draggable="false">
        </div>
        <button type="button" class="power-wall-lightbox-next" title="下一张">${ICONS.chevronRight}</button>
        <div class="power-wall-lightbox-minimap" aria-hidden="true">
          <div class="power-wall-lightbox-minimap-inner">
            <img class="power-wall-lightbox-minimap-img" alt="">
          </div>
          <div class="power-wall-lightbox-minimap-viewport"></div>
        </div>
        <div class="power-wall-lightbox-footer">
          <a class="power-wall-lightbox-detail" href="#" target="_blank">查看详情</a>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay._lbState = { scale: 1, translateX: 0, translateY: 0, lastX: 0, lastY: 0, isDragging: false, startY: 0 };
      overlay._lbRaf = null;
      overlay._lbWheelAccum = 0;
      overlay._lbWheelPivot = null;
      const imgEl = overlay.querySelector('.power-wall-lightbox-img');
      const content = overlay.querySelector('.power-wall-lightbox-content');
      const applyTransform = () => {
        overlay._lbRaf = null;
        const s = overlay._lbState;
        const accum = overlay._lbWheelAccum;
        const pivot = overlay._lbWheelPivot;
        if (accum !== 0 && pivot && content) {
          const delta = Math.max(-200, Math.min(200, overlay._lbWheelAccum));
          overlay._lbWheelAccum = 0;
          overlay._lbWheelPivot = null;
          const factor = 1 - delta * 0.002;
          const newScale = Math.max(0.2, Math.min(20, s.scale * factor));
          if (newScale !== s.scale) {
            const rect = content.getBoundingClientRect();
            const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
            const mx = pivot.x - cx, my = pivot.y - cy;
            s.translateX = mx * (1 - newScale / s.scale) + s.translateX * (newScale / s.scale);
            s.translateY = my * (1 - newScale / s.scale) + s.translateY * (newScale / s.scale);
            s.scale = newScale;
          }
        }
        imgEl.style.transform = `translate3d(${s.translateX}px, ${s.translateY}px, 0) scale(${s.scale})`;
        updateMinimap(overlay);
      };
      const scheduleApply = () => {
        if (!overlay._lbRaf) overlay._lbRaf = requestAnimationFrame(applyTransform);
      };
      overlay.querySelector('.power-wall-lightbox-backdrop').addEventListener('click', () => overlay.dispatchEvent(new CustomEvent('lightbox:close')));
      overlay.querySelector('.power-wall-lightbox-close').addEventListener('click', () => overlay.dispatchEvent(new CustomEvent('lightbox:close')));
      overlay.querySelector('.power-wall-lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:prev')); });
      overlay.querySelector('.power-wall-lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:next')); });
      overlay.querySelectorAll('.power-wall-lightbox-btn[data-action]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          overlay.dispatchEvent(new CustomEvent('lightbox:toolbar', { detail: { action: btn.dataset.action } }));
        });
      });
      content.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        overlay.dispatchEvent(new CustomEvent('lightbox:toolbar', { detail: { action: 'toggle-1to1' } }));
      });
      content.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : (e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY);
        overlay._lbWheelAccum += delta;
        overlay._lbWheelPivot = { x: e.clientX, y: e.clientY };
        scheduleApply();
      }, { passive: false });
      const startDrag = (clientX, clientY) => {
        overlay._lbState.isDragging = true;
        overlay._lbState.lastX = clientX;
        overlay._lbState.lastY = clientY;
        overlay._lbState.startY = clientY;
      };
      content.addEventListener('mousedown', (e) => {
        if (e.button === 0) startDrag(e.clientX, e.clientY);
      });
      content.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) startDrag(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: true });
      const getClientCoords = (e) => (e.touches?.[0] ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY });
      overlay._lbMouseMove = (e) => {
        const s = overlay._lbState;
        if (!s.isDragging) return;
        const { x: cx, y: cy } = getClientCoords(e);
        if (Math.abs(s.scale - 1) < 0.05) {
          const dragDown = cy - s.startY;
          if (dragDown > 100) {
            overlay._lbState.isDragging = false;
            overlay.dispatchEvent(new CustomEvent('lightbox:close'));
            return;
          }
          s.translateY = Math.max(0, dragDown);
          scheduleApply();
        } else {
          s.translateX += cx - s.lastX;
          s.translateY += cy - s.lastY;
          s.lastX = cx;
          s.lastY = cy;
          scheduleApply();
        }
      };
      overlay._lbMouseUp = () => {
        if (!overlay._lbState) return;
        const s = overlay._lbState;
        if (Math.abs(s.scale - 1) < 0.05 && s.translateY > 0) {
          const dragDown = s.translateY;
          s.translateY = 0;
          scheduleApply();
          if (dragDown > 60) overlay.dispatchEvent(new CustomEvent('lightbox:close'));
        }
        s.isDragging = false;
      };
      overlay.addEventListener('lightbox:toolbar', (e) => {
        const action = e.detail?.action;
        const s = overlay._lbState;
        const content = overlay.querySelector('.power-wall-lightbox-content');
        const img = overlay.querySelector('.power-wall-lightbox-img');
        if (!s || !content || !img) return;
        const rect = content.getBoundingClientRect();
        if (action === 'zoom-in') {
          const newScale = Math.min(20, s.scale * 1.25);
          if (newScale !== s.scale) {
            s.translateX *= newScale / s.scale;
            s.translateY *= newScale / s.scale;
            s.scale = newScale;
            overlay._lbRaf = null;
            overlay._lbRaf = requestAnimationFrame(applyTransform);
          }
        } else if (action === 'zoom-out') {
          const newScale = Math.max(0.2, s.scale * 0.8);
          if (newScale !== s.scale) {
            s.translateX = s.translateX * (newScale / s.scale);
            s.translateY = s.translateY * (newScale / s.scale);
            s.scale = newScale;
            overlay._lbRaf = null;
            overlay._lbRaf = requestAnimationFrame(applyTransform);
          }
        } else if (action === 'toggle-1to1') {
          const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
          const cw = rect.width, ch = rect.height;
          const fitScale = (nw && nh && cw && ch) ? Math.min(cw / nw, ch / nh) : 1;
          const targetScale = Math.abs(s.scale - 1) < 0.05 ? (1 / Math.max(0.01, fitScale)) : 1;
          const newScale = Math.max(0.2, Math.min(20, targetScale));
          s.translateX = s.translateX * (newScale / s.scale);
          s.translateY = s.translateY * (newScale / s.scale);
          s.scale = newScale;
          overlay._lbRaf = null;
          overlay._lbRaf = requestAnimationFrame(applyTransform);
        }
      });
    }
    if (!overlay._lbState) overlay._lbState = { scale: 1, translateX: 0, translateY: 0, lastX: 0, lastY: 0, isDragging: false, startY: 0 };
    overlay._lbIds = ids;
    overlay._lbItemsData = itemsData || null;
    overlay._lbIndex = index;
    overlay._lbTotal = ids.length;
    overlay._lbGalleryNameFromUrl = null;
    overlay._lbGalleryNameCache = overlay._lbGalleryNameCache || {};
    const galleryIds = parseIdList(new URLSearchParams(window.location.search).get('galleries') || new URLSearchParams(window.location.search).get('gallery_ids') || '');
    if (galleryIds.length === 1) {
      const gid0 = galleryIds[0];
      graphqlRequest('query($id: ID!) { findGallery(id: $id) { title folder { path } } }', { id: String(gid0) }).then((res) => {
        const g = res?.findGallery;
        const name = g?.title || (g?.folder?.path ? g.folder.path.replace(/^.*[/\\]/, '') : '');
        if (!overlay.isConnected || !name) return;
        overlay._lbGalleryNameFromUrl = name;
        if (!overlay._lbGalleryNameCache) overlay._lbGalleryNameCache = {};
        overlay._lbGalleryNameCache[gid0] = name;
        const infobarEl = overlay.querySelector('.power-wall-lightbox-infobar');
        const itemData = overlay._lbItemsData?.[overlay._lbIndex];
        const getImageName = (d) => {
          if (d?.title) return d.title;
          const vf = d?.visual_files?.[0];
          if (vf?.path) return vf.path.replace(/^.*[/\\]/, '');
          return d?.id ? `#${d.id}` : '';
        };
        const imgName = itemData ? getImageName(itemData) : '';
        const idx = overlay._lbIndex;
        const total = overlay._lbTotal;
        if (infobarEl) setInfobarContent(infobarEl, imgName, idx, total, name, gid0);
      }).catch(() => {});
    }
    const updateContent = () => {
      if (!overlay.isConnected) return;
      const idx = overlay._lbIndex;
      const total = overlay._lbTotal;
      const id = overlay._lbIds?.[idx];
      if (!id) return;
      const img = overlay.querySelector('.power-wall-lightbox-img');
      const loadingEl = overlay.querySelector('.power-wall-lightbox-loading');
      const infobarEl = overlay.querySelector('.power-wall-lightbox-infobar');
      const detailLink = overlay.querySelector('.power-wall-lightbox-detail');
      const s = overlay._lbState || {};
      s.scale = 1; s.translateX = 0; s.translateY = 0;
      if (img) {
        img.style.opacity = '0';
        img.style.transition = 'none';
        if (loadingEl) loadingEl.classList.add('power-wall-lightbox-loading-active');
        const showImg = () => {
          img.style.opacity = '1';
          img.style.transition = 'none';
          if (loadingEl) loadingEl.classList.remove('power-wall-lightbox-loading-active');
        };
        img.onload = showImg;
        img.onerror = showImg;
        img.src = getImageUrl(id);
        if (img.complete && img.naturalWidth) showImg();
        img.style.transform = 'translate3d(0,0,0) scale(1)';
        const minimapImg = overlay.querySelector('.power-wall-lightbox-minimap-img');
        if (minimapImg) minimapImg.src = getImageUrl(id);
        updateMinimap(overlay);
      }
      if (infobarEl) {
        const itemData = overlay._lbItemsData?.[idx];
        const getGalleryName = (g) => {
          if (g?.title) return g.title;
          const p = g?.folder?.path;
          return p ? p.replace(/^.*[/\\]/, '') : '';
        };
        const galleryNames = itemData?.galleries?.map(getGalleryName).filter(Boolean) || [];
        let galleryStr = galleryNames.length ? galleryNames.join(' · ') : '';
        if (!galleryStr && overlay._lbGalleryNameFromUrl) galleryStr = overlay._lbGalleryNameFromUrl;
        if (!galleryStr && itemData?.galleries?.[0]?.id) {
          const gid = itemData.galleries[0].id;
          const cached = overlay._lbGalleryNameCache?.[gid];
          if (cached) galleryStr = cached;
        }
        if (!galleryStr && itemData?.galleries?.[0]?.id) {
          const gid = itemData.galleries[0].id;
          const fetchIdx = idx;
          graphqlRequest('query($id: ID!) { findGallery(id: $id) { title folder { path } } }', { id: String(gid) }).then((res) => {
            const g = res?.findGallery;
            const name = g?.title || (g?.folder?.path ? g.folder.path.replace(/^.*[/\\]/, '') : '');
            if (name) {
              if (!overlay._lbGalleryNameCache) overlay._lbGalleryNameCache = {};
              overlay._lbGalleryNameCache[gid] = name;
            }
            if (name && overlay.isConnected && overlay._lbIndex === fetchIdx) {
              overlay._lbGalleryNameFromUrl = name;
              const inf = overlay.querySelector('.power-wall-lightbox-infobar');
              const idat = overlay._lbItemsData?.[overlay._lbIndex];
              const getName = (d) => d?.title || (d?.visual_files?.[0]?.path ? d.visual_files[0].path.replace(/^.*[/\\]/, '') : (d?.id ? `#${d.id}` : ''));
              const iname = idat ? getName(idat) : '';
              const i = overlay._lbIndex;
              const t = overlay._lbTotal;
              if (inf) setInfobarContent(inf, iname, i, t, name, gid);
            }
          }).catch(() => {});
        }
        const getImageName = (d) => {
          if (d?.title) return d.title;
          const vf = d?.visual_files?.[0];
          if (vf?.path) return vf.path.replace(/^.*[/\\]/, '');
          return d?.id ? `#${d.id}` : '';
        };
        const imgName = itemData ? getImageName(itemData) : '';
        let galleryId = itemData?.galleries?.[0]?.id;
        if (!galleryId && galleryStr && overlay._lbGalleryNameFromUrl === galleryStr) {
          const urlGids = parseIdList(new URLSearchParams(window.location.search).get('galleries') || new URLSearchParams(window.location.search).get('gallery_ids') || '');
          if (urlGids.length === 1) galleryId = urlGids[0];
        }
        setInfobarContent(infobarEl, imgName, idx, total, galleryStr || null, galleryId);
      }
      if (detailLink) detailLink.href = `/images/${id}`;
    };
    const keyHandler = (e) => {
      if (!overlay.classList.contains('power-wall-lightbox-visible')) {
        document.removeEventListener('keydown', keyHandler, true);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:close')); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:prev')); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:next')); }
    };
    overlay._lbKeyHandler = keyHandler;
    if (!overlay._lbCloseBound) {
      overlay._lbCloseBound = () => {
        overlay.classList.remove('power-wall-lightbox-visible');
        document.body.classList.remove('power-wall-lightbox-open');
        if (overlay._lbKeyHandler) document.removeEventListener('keydown', overlay._lbKeyHandler, true);
        if (overlay._lbMouseMove) {
          document.removeEventListener('mousemove', overlay._lbMouseMove);
          document.removeEventListener('touchmove', overlay._lbMouseMove);
        }
        if (overlay._lbMouseUp) {
          document.removeEventListener('mouseup', overlay._lbMouseUp);
          document.removeEventListener('touchend', overlay._lbMouseUp);
        }
        document.body.style.overflow = '';
        if (overlay._lbAddedPadding) {
          document.documentElement.style.paddingRight = '';
          document.body.style.paddingRight = '';
          overlay._lbAddedPadding = false;
        }
      };
      overlay.addEventListener('lightbox:close', overlay._lbCloseBound);
      overlay.addEventListener('lightbox:prev', () => {
        if (overlay._lbIndex > 0) { overlay._lbIndex--; updateContent(); }
      });
      overlay.addEventListener('lightbox:next', () => {
        if (overlay._lbIndex < overlay._lbTotal - 1) { overlay._lbIndex++; updateContent(); }
      });
    }
    document.addEventListener('keydown', keyHandler, true);
    updateContent();
    document.addEventListener('mousemove', overlay._lbMouseMove);
    document.addEventListener('mouseup', overlay._lbMouseUp);
    document.addEventListener('touchmove', overlay._lbMouseMove, { passive: true });
    document.addEventListener('touchend', overlay._lbMouseUp);
    const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    overlay._scrollbarWidth = scrollbarWidth;
    overlay._lbAddedPadding = false;
    if (scrollbarWidth > 0 && !supportsScrollbarGutterStable()) {
      document.documentElement.style.paddingRight = scrollbarWidth + 'px';
      document.body.style.paddingRight = scrollbarWidth + 'px';
      overlay._lbAddedPadding = true;
    }
    document.body.classList.add('power-wall-lightbox-open');
    document.body.style.overflow = 'hidden';
    overlay.classList.add('power-wall-lightbox-visible');
  }

  // ==================== 砌墙布局引擎（列优先递补：最短列放置，等比例缩放无剪裁）====================
  class BrickWallLayout {
    constructor(container, options = {}) {
      this.container = container;
      this.margin = options.margin ?? 3;
      this.rowGap = options.rowGap ?? 3;
      this.columnGap = options.columnGap ?? 3;
      this.items = [];
      // 增量重排状态：布局参数不变时仅排列新增项，避免 O(n²) 样式写入
      this._layoutKey = '';
      this._columnHeights = null;
      this._laidOutCount = 0;
    }

    getContainerWidth() {
      const parent = this.container.parentElement;
      const viewportW = getViewportAvailableWidth();
      if (!parent) return viewportW || window.innerWidth;
      const parentW = parent.clientWidth;
      if (parentW <= 0) return viewportW || window.innerWidth;
      return Math.min(parentW, viewportW);
    }

    /** 列数：由 zoomIndex 偏好列宽决定，与 Stash zoomWidths 一致 */
    getColumnCount() {
      const containerWidth = this.getContainerWidth();
      const preferredWidth = getPreferredColumnWidth();
      if (containerWidth <= 0 || preferredWidth <= 0) return 1;
      const totalGap = (containerWidth - 2 * this.margin + this.columnGap);
      const count = Math.floor(totalGap / (preferredWidth + this.columnGap));
      return Math.max(1, count);
    }

    /** 单列宽度（等分容器，扣除边距与列距）*/
    getColumnWidth() {
      const containerWidth = this.getContainerWidth();
      const columnCount = this.getColumnCount();
      return (containerWidth - 2 * this.margin - (columnCount - 1) * this.columnGap) / columnCount;
    }

    /** 添加一项：element + 原始宽高（仅用于等比例计算，不剪裁不拉伸）*/
    addItem(element, srcWidth, srcHeight) {
      this.items.push({ element, width: srcWidth, height: srcHeight });
    }

    relayout() {
      const containerWidth = this.getContainerWidth();
      if (containerWidth <= 0) return;

      const columnCount = this.getColumnCount();
      const columnWidth = this.getColumnWidth();
      // 布局参数指纹：任一变化（宽度/列数/间距）则全量重排，否则仅排列新增项
      const layoutKey = `${containerWidth}|${columnCount}|${columnWidth}|${this.margin}|${this.rowGap}|${this.columnGap}`;

      let columnHeights;
      let startIndex;
      if (this._layoutKey === layoutKey && this._columnHeights && this._laidOutCount > 0) {
        columnHeights = this._columnHeights;
        startIndex = this._laidOutCount;
      } else {
        columnHeights = new Array(columnCount).fill(0);
        startIndex = 0;
      }

      for (let i = startIndex; i < this.items.length; i++) {
        const item = this.items[i];
        const srcW = item.width;
        const srcH = item.height;
        if (!srcW || !srcH) continue;
        const displayWidth = columnWidth;
        const displayHeight = columnWidth * (srcH / srcW);

        let colIndex = 0;
        let minH = columnHeights[0];
        for (let c = 1; c < columnCount; c++) {
          if (columnHeights[c] < minH) { minH = columnHeights[c]; colIndex = c; }
        }
        const left = this.margin + colIndex * (columnWidth + this.columnGap);
        const top = columnHeights[colIndex];

        item.element.style.position = 'absolute';
        item.element.style.left = `${left}px`;
        item.element.style.top = `${top}px`;
        item.element.style.width = `${displayWidth}px`;
        item.element.style.height = `${displayHeight}px`;

        columnHeights[colIndex] = top + displayHeight + this.rowGap;
      }

      this._layoutKey = layoutKey;
      this._columnHeights = columnHeights;
      this._laidOutCount = this.items.length;

      const maxHeight = columnHeights.length ? Math.max(...columnHeights) - this.rowGap + this.margin : 0;
      this.container.style.height = `${maxHeight}px`;
      this.container.style.padding = `${this.margin}px`;
      this.container.style.margin = '0 auto';
      this.container.style.boxSizing = 'content-box';
    }

    clear() {
      this.items = [];
      this._layoutKey = '';
      this._columnHeights = null;
      this._laidOutCount = 0;
      this.container.style.height = '0';
      this.container.style.padding = '0';
      this.container.style.margin = '0 auto';
    }

    /** 数组顺序变化后（如标题重排），使增量缓存失效，强制全量重排 */
    forceFullRelayout() {
      this._layoutKey = '';
      this._columnHeights = null;
      this._laidOutCount = 0;
      this.relayout();
    }
  }

  // ==================== 标题数字感知排序（日系写真） ====================
  // 主键：文件名中第一串数字的前导零个数（0 个零一组、1 个零一组……）
  // 次键：同组内按去前导零后的数值；方向同时作用于两个维度
  // 注：取文件名内首个数字串而非严格开头——写真文件常带 DSC_/img_ 等前缀，严格开头会全部落入兜底组
  function parseTitleNumKey(title) {
    const m = String(title || '').match(/(\d+)/);
    if (!m) return null;
    const digits = m[1];
    const stripped = digits.replace(/^0+/, '');
    return { zeros: digits.length - stripped.length, value: parseInt(stripped || '0', 10) };
  }
  function compareByTitle(titleA, titleB, dir) {
    const sign = dir === 'ASC' ? 1 : -1;
    const ka = parseTitleNumKey(titleA);
    const kb = parseTitleNumKey(titleB);
    if (!ka && !kb) return String(titleA || '').localeCompare(String(titleB || '')) * sign;
    if (!ka) return 1;   // 无数字串恒排数字组之后
    if (!kb) return -1;
    if (ka.zeros !== kb.zeros) return (ka.zeros - kb.zeros) * sign;
    if (ka.value !== kb.value) return (ka.value - kb.value) * sign;
    return String(titleA || '').localeCompare(String(titleB || '')) * sign;
  }

  // ==================== 无限滚动 ====================
  class InfiniteScroller {
    constructor(options = {}) {
      this.threshold = options.threshold || 600;
      this.onLoadMore = options.onLoadMore || (() => {});
      this.isLoading = false;
      this.hasMore = true;
      this.sentinel = null;
      this.observer = null;
      // 自动续载预算：一次 IO 触发最多续 3 页，之后必须等新的交叉状态变化，避免异常情况下无限拉取
      this._resumeStreak = 0;
      this._resumeTimer = null;
    }
    start(container) {
      if (!container || this.observer) return;
      this.sentinel = document.createElement('div');
      this.sentinel.className = 'power-wall-sentinel';
      this.sentinel.style.cssText = 'position:absolute;left:0;bottom:0;width:1px;height:1px;pointer-events:none';
      container.appendChild(this.sentinel);
      this.observer = new IntersectionObserver(
        (entries) => {
          // 同一 target 在一个回调里可能投递多条 entry（unobserve/observe 之后很常见，
          // 且顺序不保证是"过期的在前"）。只看 entries[0] 一旦读到过期的 isIntersecting:false
          // 就会永久停止加载：此时 observer 已缓存 true，状态不再变化 → 再也不投递回调。
          if (!entries.some((e) => e.isIntersecting)) return;
          this._resumeStreak = 0;
          if (this.isLoading || !this.hasMore) return;
          this.loadMore().catch(() => {});
        },
        { rootMargin: `${this.threshold}px 0px`, threshold: 0 }
      );
      this.observer.observe(this.sentinel);
    }
    updateSentinel() {
      if (this.sentinel?.parentElement) {
        this.observer?.unobserve(this.sentinel);
        this.observer?.observe(this.sentinel);
      }
    }
    stop() {
      if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
      if (this.observer && this.sentinel) this.observer.unobserve(this.sentinel);
      this.observer = null;
      this.sentinel?.remove();
      this.sentinel = null;
    }
    /** 哨兵当前是否仍在视口（含 rootMargin）内 —— 实时读取，不依赖 IO 的缓存状态 */
    _sentinelInRange() {
      if (!this.sentinel?.isConnected) return false;
      const r = this.sentinel.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      return r.top <= vh + this.threshold && r.bottom >= -this.threshold;
    }
    /**
     * 兜底自恢复：IntersectionObserver 只在交叉状态"变化"时投递回调。
     * 若某次加载结束后哨兵仍停留在 rootMargin 内，就没有下一次变化可触发 → 墙静默停住。
     * 这里在每次加载结束后补一次续载检查（每页最多一次，不是滚动轮询）。
     */
    scheduleResumeCheck() {
      if (this._resumeTimer || !this.hasMore || !this.sentinel) return;
      this._resumeTimer = setTimeout(() => {
        this._resumeTimer = null;
        if (this.isLoading || !this.hasMore || this._resumeStreak >= 3) return;
        if (!this._sentinelInRange()) return;
        this._resumeStreak++;
        this.loadMore().catch(() => {});
      }, 120);
    }
    async loadMore() {
      if (this.isLoading || !this.hasMore) return;
      this.isLoading = true;
      try {
        await this.onLoadMore();
        this.updateSentinel();
      } finally {
        this.isLoading = false;
      }
      this.scheduleResumeCheck();
    }
    reset() {
      this.isLoading = false;
      this.hasMore = true;
      this._resumeStreak = 0;
      if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    }
  }

  // ==================== 视频悬停预览 ====================
  class VideoPreviewManager {
    constructor(options = {}) {
      this.delay = options.delay || 300;
      this.hoverTimer = null;
      this.boundHandler = null;
    }
    attach(container) {
      if (!container || this.boundHandler) return;
      this.container = container;
      this.boundHandler = (e) => {
        const item = e.target.closest('.power-wall-item');
        if (!item) return;
        const video = item.querySelector('video');
        if (!video) return;
        const img = item.querySelector('img');
        if (e.type === 'mouseenter') {
          this.clearTimer();
          this.hoverTimer = setTimeout(() => {
            if (video.preload === 'none') video.preload = 'auto';
            video.currentTime = 0;
            video.play().then(() => { video.classList.add('playing'); if (img) img.classList.add('hidden'); }).catch(() => {});
          }, this.delay);
        } else {
          this.clearTimer();
          video.pause();
          video.classList.remove('playing');
          if (img) img.classList.remove('hidden');
        }
      };
      container.addEventListener('mouseenter', this.boundHandler, true);
      container.addEventListener('mouseleave', this.boundHandler, true);
    }
    clearTimer() {
      if (this.hoverTimer) { clearTimeout(this.hoverTimer); this.hoverTimer = null; }
    }
    destroy() {
      this.clearTimer();
      if (this.boundHandler && this.container) {
        this.container.removeEventListener('mouseenter', this.boundHandler, true);
        this.container.removeEventListener('mouseleave', this.boundHandler, true);
      }
      this.boundHandler = null;
      this.container = null;
    }
  }

  // ==================== 内联 SVG 图标（Font Awesome 6 Solid）====================
  // 与 Stash 顶部导航同一图标集（@fortawesome/free-solid-svg-icons）：实心路径、fill=currentColor、
  // 按 FA 原始比例缩放。自绘的 24×24 线性图标与原生实心图标视觉重量差距明显，故整体替换。
  const FA_ICON_PATHS = {
    'house': [512, 512, 'M277.8 8.6c-12.3-11.4-31.3-11.4-43.5 0l-224 208c-9.6 9-12.8 22.9-8 35.1S18.8 272 32 272l16 0 0 176c0 35.3 28.7 64 64 64l288 0c35.3 0 64-28.7 64-64l0-176 16 0c13.2 0 25-8.1 29.8-20.3s1.6-26.2-8-35.1l-224-208zM240 320l32 0c26.5 0 48 21.5 48 48l0 96-128 0 0-96c0-26.5 21.5-48 48-48z'],
    'shuffle': [512, 512, 'M403.8 34.4c12-5 25.7-2.2 34.9 6.9l64 64c6 6 9.4 14.1 9.4 22.6s-3.4 16.6-9.4 22.6l-64 64c-9.2 9.2-22.9 11.9-34.9 6.9S384 204.9 384 192l0-32-32 0c-10.1 0-19.6 4.7-25.6 12.8l-32.4 43.2-40-53.3 21.2-28.3C293.3 110.2 321.8 96 352 96l32 0 0-32c0-12.9 7.8-24.6 19.8-29.6zM154 296l40 53.3-21.2 28.3C154.7 401.8 126.2 416 96 416l-64 0c-17.7 0-32-14.3-32-32s14.3-32 32-32l64 0c10.1 0 19.6-4.7 25.6-12.8L154 296zM438.6 470.6c-9.2 9.2-22.9 11.9-34.9 6.9S384 460.9 384 448l0-32-32 0c-30.2 0-58.7-14.2-76.8-38.4L121.6 172.8c-6-8.1-15.5-12.8-25.6-12.8l-64 0c-17.7 0-32-14.3-32-32S14.3 96 32 96l64 0c30.2 0 58.7 14.2 76.8 38.4L326.4 339.2c6 8.1 15.5 12.8 25.6 12.8l32 0 0-32c0-12.9 7.8-24.6 19.8-29.6s25.7-2.2 34.9 6.9l64 64c6 6 9.4 14.1 9.4 22.6s-3.4 16.6-9.4 22.6l-64 64z'],
    'book-open': [512, 512, 'M256 141.3l0 309.3 .5-.2C311.1 427.7 369.7 416 428.8 416l19.2 0 0-320-19.2 0c-42.2 0-84.1 8.4-123.1 24.6-16.8 7-33.4 13.9-49.7 20.7zM230.9 61.5L256 72 281.1 61.5C327.9 42 378.1 32 428.8 32L464 32c26.5 0 48 21.5 48 48l0 352c0 26.5-21.5 48-48 48l-35.2 0c-50.7 0-100.9 10-147.7 29.5l-12.8 5.3c-7.9 3.3-16.7 3.3-24.6 0l-12.8-5.3C184.1 490 133.9 480 83.2 480L48 480c-26.5 0-48-21.5-48-48L0 80C0 53.5 21.5 32 48 32l35.2 0c50.7 0 100.9 10 147.7 29.5z'],
    'arrow-up': [384, 512, 'M214.6 17.4c-12.5-12.5-32.8-12.5-45.3 0l-160 160c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L160 117.3 160 488c0 17.7 14.3 32 32 32s32-14.3 32-32l0-370.7 105.4 105.4c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3l-160-160z'],
    'arrow-down': [384, 512, 'M169.4 502.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 402.7 224 32c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 370.7-105.4-105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z'],
    'filter': [512, 512, 'M32 64C19.1 64 7.4 71.8 2.4 83.8S.2 109.5 9.4 118.6L192 301.3 192 416c0 8.5 3.4 16.6 9.4 22.6l64 64c9.2 9.2 22.9 11.9 34.9 6.9S320 492.9 320 480l0-178.7 182.6-182.6c9.2-9.2 11.9-22.9 6.9-34.9S492.9 64 480 64L32 64z'],
    'sliders': [512, 512, 'M32 64C14.3 64 0 78.3 0 96s14.3 32 32 32l86.7 0c12.3 28.3 40.5 48 73.3 48s61-19.7 73.3-48L480 128c17.7 0 32-14.3 32-32s-14.3-32-32-32L265.3 64C253 35.7 224.8 16 192 16s-61 19.7-73.3 48L32 64zm0 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l246.7 0c12.3 28.3 40.5 48 73.3 48s61-19.7 73.3-48l54.7 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-54.7 0c-12.3-28.3-40.5-48-73.3-48s-61 19.7-73.3 48L32 224zm0 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l54.7 0c12.3 28.3 40.5 48 73.3 48s61-19.7 73.3-48L480 448c17.7 0 32-14.3 32-32s-14.3-32-32-32l-246.7 0c-12.3-28.3-40.5-48-73.3-48s-61 19.7-73.3 48L32 384z'],
    'rotate-right': [512, 512, 'M488 192l-144 0c-9.7 0-18.5-5.8-22.2-14.8s-1.7-19.3 5.2-26.2l46.7-46.7c-75.3-58.6-184.3-53.3-253.5 15.9-75 75-75 196.5 0 271.5s196.5 75 271.5 0c8.2-8.2 15.5-16.9 21.9-26.1 10.1-14.5 30.1-18 44.6-7.9s18 30.1 7.9 44.6c-8.5 12.2-18.2 23.8-29.1 34.7-100 100-262.1 100-362 0S-25 175 75 75c94.3-94.3 243.7-99.6 344.3-16.2L471 7c6.9-6.9 17.2-8.9 26.2-5.2S512 14.3 512 24l0 144c0 13.3-10.7 24-24 24z'],
    'rotate-left': [512, 512, 'M24 192l144 0c9.7 0 18.5-5.8 22.2-14.8s1.7-19.3-5.2-26.2l-46.7-46.7c75.3-58.6 184.3-53.3 253.5 15.9 75 75 75 196.5 0 271.5s-196.5 75-271.5 0c-10.2-10.2-19-21.3-26.4-33-9.5-14.9-29.3-19.3-44.2-9.8s-19.3 29.3-9.8 44.2C49.7 408.7 61.4 423.5 75 437 175 537 337 537 437 437S537 175 437 75C342.8-19.3 193.3-24.7 92.7 58.8L41 7C34.1 .2 23.8-1.9 14.8 1.8S0 14.3 0 24L0 168c0 13.3 10.7 24 24 24z'],
    'list': [512, 512, 'M40 48C26.7 48 16 58.7 16 72l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24L40 48zM192 64c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L192 64zm0 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-288 0zm0 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-288 0zM16 232l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24l-48 0c-13.3 0-24 10.7-24 24zM40 368c-13.3 0-24 10.7-24 24l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24l-48 0z'],
    'table-cells-large': [448, 512, 'M384 96l-128 0 0 128 128 0 0-128zm64 128l0 192c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96C0 60.7 28.7 32 64 32l320 0c35.3 0 64 28.7 64 64l0 128zM64 288l0 128 128 0 0-128-128 0zm128-64l0-128-128 0 0 128 128 0zm64 64l0 128 128 0 0-128-128 0z'],
    'xmark': [384, 512, 'M55.1 73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L147.2 256 9.9 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192.5 301.3 329.9 438.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.8 256 375.1 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192.5 210.7 55.1 73.4z'],
    'check': [448, 512, 'M434.8 70.1c14.3 10.4 17.5 30.4 7.1 44.7l-256 352c-5.5 7.6-14 12.3-23.4 13.1s-18.5-2.7-25.1-9.3l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l101.5 101.5 234-321.7c10.4-14.3 30.4-17.5 44.7-7.1z'],
    'circle-check': [512, 512, 'M256 512a256 256 0 1 1 0-512 256 256 0 1 1 0 512zM374 145.7c-10.7-7.8-25.7-5.4-33.5 5.3L221.1 315.2 169 263.1c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9l72 72c5 5 11.8 7.5 18.8 7s13.4-4.1 17.5-9.8L379.3 179.2c7.8-10.7 5.4-25.7-5.3-33.5z'],
    'triangle-exclamation': [512, 512, 'M256 0c14.7 0 28.2 8.1 35.2 21l216 400c6.7 12.4 6.4 27.4-.8 39.5S486.1 480 472 480L40 480c-14.1 0-27.2-7.4-34.4-19.5s-7.5-27.1-.8-39.5l216-400c7-12.9 20.5-21 35.2-21zm0 352a32 32 0 1 0 0 64 32 32 0 1 0 0-64zm0-192c-18.2 0-32.7 15.5-31.4 33.7l7.4 104c.9 12.5 11.4 22.3 23.9 22.3 12.6 0 23-9.7 23.9-22.3l7.4-104c1.3-18.2-13.1-33.7-31.4-33.7z'],
    'chevron-down': [448, 512, 'M201.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 338.7 54.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z'],
    'star': [576, 512, 'M309.5-18.9c-4.1-8-12.4-13.1-21.4-13.1s-17.3 5.1-21.4 13.1L193.1 125.3 33.2 150.7c-8.9 1.4-16.3 7.7-19.1 16.3s-.5 18 5.8 24.4l114.4 114.5-25.2 159.9c-1.4 8.9 2.3 17.9 9.6 23.2s16.9 6.1 25 2L288.1 417.6 432.4 491c8 4.1 17.7 3.3 25-2s11-14.2 9.6-23.2L441.7 305.9 556.1 191.4c6.4-6.4 8.6-15.8 5.8-24.4s-10.1-14.9-19.1-16.3L383 125.3 309.5-18.9z'],
    'eye': [576, 512, 'M288 32c-80.8 0-145.5 36.8-192.6 80.6-46.8 43.5-78.1 95.4-93 131.1-3.3 7.9-3.3 16.7 0 24.6 14.9 35.7 46.2 87.7 93 131.1 47.1 43.7 111.8 80.6 192.6 80.6s145.5-36.8 192.6-80.6c46.8-43.5 78.1-95.4 93-131.1 3.3-7.9 3.3-16.7 0-24.6-14.9-35.7-46.2-87.7-93-131.1-47.1-43.7-111.8-80.6-192.6-80.6zM144 256a144 144 0 1 1 288 0 144 144 0 1 1 -288 0zm144-64c0 35.3-28.7 64-64 64-11.5 0-22.3-3-31.7-8.4-1 10.9-.1 22.1 2.9 33.2 13.7 51.2 66.4 81.6 117.6 67.9s81.6-66.4 67.9-117.6c-12.2-45.7-55.5-74.8-101.1-70.8 5.3 9.3 8.4 20.1 8.4 31.7z'],
    'user': [448, 512, 'M224 248a120 120 0 1 0 0-240 120 120 0 1 0 0 240zm-29.7 56C95.8 304 16 383.8 16 482.3 16 498.7 29.3 512 45.7 512l356.6 0c16.4 0 29.7-13.3 29.7-29.7 0-98.5-79.8-178.3-178.3-178.3l-59.4 0z'],
    'building': [384, 512, 'M64 0C28.7 0 0 28.7 0 64L0 448c0 35.3 28.7 64 64 64l256 0c35.3 0 64-28.7 64-64l0-384c0-35.3-28.7-64-64-64L64 0zM176 352l32 0c17.7 0 32 14.3 32 32l0 80-96 0 0-80c0-17.7 14.3-32 32-32zM96 112c0-8.8 7.2-16 16-16l32 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-32 0c-8.8 0-16-7.2-16-16l0-32zM240 96l32 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-32 0c-8.8 0-16-7.2-16-16l0-32c0-8.8 7.2-16 16-16zM96 240c0-8.8 7.2-16 16-16l32 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-32 0c-8.8 0-16-7.2-16-16l0-32zm144-16l32 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-32 0c-8.8 0-16-7.2-16-16l0-32c0-8.8 7.2-16 16-16z'],
    'minus': [448, 512, 'M0 256c0-17.7 14.3-32 32-32l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32z'],
    'plus': [448, 512, 'M256 64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 160-160 0c-17.7 0-32 14.3-32 32s14.3 32 32 32l160 0 0 160c0 17.7 14.3 32 32 32s32-14.3 32-32l0-160 160 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-160 0 0-160z'],
    'chevron-left': [320, 512, 'M9.4 233.4c-12.5 12.5-12.5 32.8 0 45.3l192 192c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L77.3 256 246.6 86.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-192 192z'],
    'chevron-right': [320, 512, 'M311.1 233.4c12.5 12.5 12.5 32.8 0 45.3l-192 192c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L243.2 256 73.9 86.6c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l192 192z'],
  };

  /**
   * 生成 FA Solid 内联 SVG。size 为高度（px），宽度按 FA 原始比例换算，
   * 与 Stash 的 .fa-icon 排版一致（非正方形图标不会被拉宽）。
   */
  function faIcon(name, size = 16) {
    const data = FA_ICON_PATHS[name];
    if (!data) return '';
    const [w, h, d] = data;
    const width = Math.round((size * w / h) * 100) / 100;
    return `<svg viewBox="0 0 ${w} ${h}" width="${width}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
  }

  const ICONS = {
    /** 首页：清除筛选/随机，回到默认视图 */
    home: faIcon('house'),
    /** 随览：随机 */
    shuffle: faIcon('shuffle'),
    /** 随阅：随机图库 */
    bookOpen: faIcon('book-open'),
    arrowUp: faIcon('arrow-up'),
    arrowDown: faIcon('arrow-down'),
    /** 筛选：漏斗 */
    filter: faIcon('filter'),
    /** 设置：滑杆 */
    sliders: faIcon('sliders'),
    refresh: faIcon('rotate-right'),
    /** 原始视图：回到原生列表 */
    layoutList: faIcon('list'),
    /** 墙视图：砌墙（原始视图下的返回入口） */
    layoutGrid: faIcon('table-cells-large'),
    checkCircle: faIcon('circle-check'),
    alert: faIcon('triangle-exclamation'),
    /** 面板通用：关闭 / 确认 / 复位 / 折叠 / 缩放 / 翻页 */
    close: faIcon('xmark'),
    check: faIcon('check'),
    rotateCcw: faIcon('rotate-left'),
    chevronDown: faIcon('chevron-down'),
    minus: faIcon('minus'),
    plus: faIcon('plus'),
    chevronLeft: faIcon('chevron-left'),
    chevronRight: faIcon('chevron-right'),
  };

  // 卡片 meta 行的小图标：12px 起步，节点数刻意压到 1–2 个（每张卡片可能渲染 1–4 个，
  // 直接按大图标那样堆节点会明显推高整墙 DOM 量）
  const META_ICONS = {
    star: faIcon('star', 12),
    eye: faIcon('eye', 12),
    user: faIcon('user', 12),
    building: faIcon('building', 12),
  };

  // ==================== 主类 PowerWall ====================
  class PowerWall {
    constructor() {
      this.container = null;
      this.wallContainer = null;
      this.toolbarEl = null;
      this.brickWall = null;
      this.scroller = null;
      this.videoPreview = null;
      this.abortController = null;
      this.items = [];
      this.page = 1;
      this.totalCount = 0;
      this.pageType = null;
      this.isEnabled = false;
      this.loadingIndicator = null;
      this.resizeHandler = null;
      // 标题排序方向（'ASC'/'DESC'，null=未启用；不持久化，刷新/随览/随阅/切换路由时自动释放）
      this.titleSortDir = null;
      // 代际令牌：disable/refresh 时递增，使残留的异步加载循环（loadMore/addItemsBatch）失配退出，
      // 避免旧批次继续追加导致同一图片重复上墙（abortController 被替换后 signal 检查会失效）
      this.generation = 0;
      // 跨批次去重：记录本墙实例已渲染的 data.id，绝对杜绝同 id 重复上墙（终极防线）
      this.addedDataIds = new Set();
    }

    async init() {
      this.pageType = getPageType();
      if (!this.pageType) {
        document.documentElement.classList.remove('power-wall-preload');
        return;
      }
      document.documentElement.classList.add('power-wall-preload');
      document.body.classList.add('power-wall-active');
      this.enable();
    }

    async enable(pluginMount) {
      if (this.isEnabled) return;
      this.isEnabled = true;
      this.abortController = new AbortController();
      const cfg = getConfig();
      this.videoPreview = new VideoPreviewManager({ delay: cfg.videoPreviewDelay });
      document.body.classList.add('power-wall-active');
      if (pluginMount) pluginMount.classList.add('power-wall-mount');
      this.createContainer(pluginMount);
      if (!this.wallContainer) {
        error('创建容器失败');
        this.isEnabled = false;
        return;
      }
      this.brickWall = new BrickWallLayout(this.wallContainer, {
        margin: cfg.margin,
        rowGap: cfg.rowGap,
        columnGap: cfg.columnGap,
      });
      this.scroller = new InfiniteScroller({
        threshold: cfg.loadThreshold,
        onLoadMore: () => this.loadMore()
      });
      this.videoPreview.attach(this.wallContainer);
      this._boundItemClick = (e) => this.handleItemClick(e);
      this.wallContainer.addEventListener('click', this._boundItemClick);
      await this.loadMore();
      if (!this.isEnabled || !this.wallContainer || !this.scroller) return;
      this.scroller.start(this.wallContainer);
      this.resizeHandler = debounce(() => {
        if (!this.isEnabled || !this.brickWall || !this.wallContainer?.isConnected) return;
        requestAnimationFrame(() => {
          if (!this.isEnabled || !this.brickWall || !this.wallContainer?.isConnected) return;
          this.updateFixedToolbar();
          this.brickWall.relayout();
        });
      }, 150);
      window.addEventListener('resize', this.resizeHandler);
      if (typeof ResizeObserver !== 'undefined') {
        const onResize = () => this.resizeHandler();
        this.resizeObserver = new ResizeObserver(onResize);
        if (this.wallContainer) {
          this.resizeObserver.observe(this.wallContainer.parentElement || this.wallContainer);
        }
        if (this.regionElement) this.resizeObserver.observe(this.regionElement);
        // 系统顶栏高度变化（响应式/字体加载）时重新贴合
        const topNav = document.querySelector('.top-nav');
        if (topNav) this.resizeObserver.observe(topNav);
        this.resizeObserver.observe(document.documentElement);
      }
      this._lastScrollbarW = getScrollbarWidth();
      this._viewportCheck = setInterval(() => {
        if (!this.isEnabled || !this.brickWall || !this.wallContainer?.isConnected) return;
        const now = getScrollbarWidth();
        if (now !== this._lastScrollbarW) {
          this._lastScrollbarW = now;
          this.resizeHandler();
        }
      }, 500);
      this.createBackToTopButton();
    }

    createBackToTopButton() {
      let btn = document.getElementById('power-wall-back-to-top');
      if (btn) return;
      btn = document.createElement('button');
      btn.id = 'power-wall-back-to-top';
      btn.type = 'button';
      btn.className = 'power-wall-back-to-top';
      btn.title = '返回顶部';
      btn.textContent = 'TOP';
      btn.setAttribute('aria-label', '返回顶部');
      const scrollThreshold = 200;
      const updateVisibility = () => {
        if (!btn?.isConnected || !this.isEnabled) return;
        const y = window.scrollY || document.documentElement.scrollTop;
        if (y > scrollThreshold) btn.classList.add('power-wall-back-to-top-visible');
        else btn.classList.remove('power-wall-back-to-top-visible');
      };
      btn.addEventListener('click', () => {
        (document.scrollingElement || document.documentElement).scrollTo({ top: 0, behavior: 'smooth' });
      });
      this._backToTopScroll = () => { if (this.isEnabled) updateVisibility(); };
      window.addEventListener('scroll', this._backToTopScroll, { passive: true });
      updateVisibility();
      document.body.appendChild(btn);
    }

    destroyBackToTopButton() {
      const btn = document.getElementById('power-wall-back-to-top');
      if (btn) btn.remove();
      if (this._backToTopScroll) {
        window.removeEventListener('scroll', this._backToTopScroll);
        this._backToTopScroll = null;
      }
    }

    /**
     * 切到「原始」视图：记住该选择（刷新/换页后保持），卸载砌墙并挂上唯一的返回入口
     * （右下角「墙视图」按钮）。不持久化的话用户的选择会被刷新/换页直接覆盖。
     */
    switchToOriginalView() {
      const pageType = this.pageType;
      if (!pageType) return;
      setViewMode(pageType, 'original');
      this.disable();
      mountSwitchToWallButton(pageType);
    }

    disable() {
      if (!this.isEnabled) return;
      this.isEnabled = false;
      this.generation++;
      this.destroyBackToTopButton();
      if (this.abortController) { this.abortController.abort(); this.abortController = null; }
      document.body.classList.remove('power-wall-active');
      document.documentElement.classList.remove('power-wall-preload');
      if (this.scroller) { this.scroller.stop(); this.scroller = null; }
      if (this.videoPreview) { this.videoPreview.destroy(); this.videoPreview = null; }
      if (this.wallContainer) this.wallContainer.removeEventListener('click', this._boundItemClick);
      if (this.resizeHandler) { window.removeEventListener('resize', this.resizeHandler); this.resizeHandler = null; }
      if (this._viewportCheck) { clearInterval(this._viewportCheck); this._viewportCheck = null; }
      if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
      const mountEl = this.container?.closest?.('.power-wall-mount');
      if (mountEl) mountEl.classList.remove('power-wall-mount');
      if (this.toolbarEl) { this.toolbarEl.remove(); this.toolbarEl = null; }
      if (this.regionElement) { this.regionElement.classList.remove('power-wall-region'); this.regionElement = null; }
      if (this.container) { this.container.remove(); this.container = null; this.wallContainer = null; }
      this.brickWall = null;
      this.items = [];
      this.addedDataIds.clear();
      this.page = 1;
    }

    waitNextFrame() {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    }

    handleItemClick(e) {
      const link = e.target.closest('a.power-wall-link[data-lightbox="1"]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const id = link.dataset.id;
      const type = link.dataset.type;
      if (!id || !type) return;
      const ids = this.items.map((it) => String(it.data?.id)).filter(Boolean);
      const index = ids.indexOf(id);
      if (index < 0) return;
      if (type === 'images') {
        const itemsData = this.items.map((it) => it.data).filter(Boolean);
        openBuiltinLightbox(ids, index, type, itemsData);
      } else {
        window.location.href = `/${type}/${id}`;
      }
    }

    createContainer(pluginMount) {
      const targetContainer = pluginMount || [
        document.querySelector('.container-fluid'),
        document.querySelector('main'),
        document.querySelector('.wall')?.parentElement,
        document.querySelector('.container'),
        document.querySelector('#root > div > div'),
        document.querySelector('#root'),
        document.body
      ].find(c => c);
      if (!targetContainer) { error('找不到容器'); return; }

      // 防御性清理：移除此前可能残留的 .power-wall-container（避免双重初始化遗留）
      targetContainer.querySelectorAll('.power-wall-container').forEach(el => el.remove());
      this.container = document.createElement('div');
      this.container.className = 'power-wall-container' + (getConfig().layoutPreset === 'seamless' ? ' power-wall-seamless' : '');
      this.container.innerHTML = `
        <div class="power-wall-masonry"></div>
        <div class="power-wall-loading">
          <div class="power-wall-loading-spinner"></div>
          <span>加载中...</span>
        </div>
      `;
      this.wallContainer = this.container.querySelector('.power-wall-masonry');
      this.loadingIndicator = this.container.querySelector('.power-wall-loading');
      if (pluginMount) targetContainer.appendChild(this.container);
      else targetContainer.insertBefore(this.container, targetContainer.firstChild);
      this.regionElement = targetContainer;
      targetContainer.classList.add('power-wall-region');
      // 工具栏独立挂到 body，固定悬浮于系统顶栏下方（见 createToolbar）
      this.createToolbar();
      // 首屏就点亮正确的模式按钮（不等第一页加载完），避免"三个都不亮"的闪烁
      this.updateModeButtons();
    }

    /**
     * 创建悬浮工具栏。
     * 挂到 body 而不是 .power-wall-container 内：容器自身有 opacity 过场，祖先节点
     * 也可能带 transform/filter —— 这些都会让 position:fixed 改变参照系，导致工具栏
     * 跟随内容滚动或被裁切。挂到 body 才能稳定贴住视口顶部，并与系统顶栏同层（z-index:1030）。
     */
    createToolbar() {
      const cfg = getConfig();
      const zoomMax = ZOOM_WIDTHS.length - 1;
      // 防御性清理：移除此前可能残留的工具栏（避免双重初始化遗留）
      document.querySelectorAll('.power-wall-toolbar').forEach(el => el.remove());
      const toolbar = document.createElement('div');
      toolbar.className = 'power-wall-toolbar';
      toolbar.innerHTML = `
        <div class="power-wall-toolbar-left">
          <span class="power-wall-count">加载中...</span>
        </div>
        <div class="power-wall-toolbar-zoom">
          <input type="range" class="power-wall-zoom-slider" id="pw-zoom-slider" min="0" max="${zoomMax}" value="${Math.min(cfg.zoomIndex, zoomMax)}" title="缩放">
        </div>
        <div class="power-wall-toggle">
          <button type="button" class="power-wall-toggle-btn" data-action="home" title="回到首页（清除筛选与随机）" aria-label="回到首页" aria-pressed="false"><span class="pw-btn-icon">${ICONS.home}</span><span class="pw-btn-text">首页</span></button>
          <button type="button" class="power-wall-toggle-btn" data-action="random" title="随机浏览" aria-label="随览"><span class="pw-btn-icon">${ICONS.shuffle}</span><span class="pw-btn-text">随览</span></button>
          ${this.pageType === 'images' ? `<button type="button" class="power-wall-toggle-btn" data-action="randomGallery" title="随机打开一个图库" aria-label="随阅"><span class="pw-btn-icon">${ICONS.bookOpen}</span><span class="pw-btn-text">随阅</span></button>` : ''}
          <button type="button" class="power-wall-toggle-btn" data-action="titleAsc" title="按文件名升序（前导零分组 + 数值）" aria-label="按文件名升序" aria-pressed="false"><span class="pw-btn-icon">${ICONS.arrowUp}</span><span class="pw-btn-text">升序</span></button>
          <button type="button" class="power-wall-toggle-btn" data-action="titleDesc" title="按文件名降序（前导零分组 + 数值）" aria-label="按文件名降序" aria-pressed="false"><span class="pw-btn-icon">${ICONS.arrowDown}</span><span class="pw-btn-text">降序</span></button>
          <button type="button" class="power-wall-toggle-btn" data-action="filter" title="筛选" aria-label="筛选"><span class="pw-btn-icon">${ICONS.filter}</span><span class="pw-btn-text">筛选</span></button>
          <button type="button" class="power-wall-toggle-btn" data-action="settings" title="设置" aria-label="设置"><span class="pw-btn-icon">${ICONS.sliders}</span><span class="pw-btn-text">设置</span></button>
          <button type="button" class="power-wall-toggle-btn" data-action="refresh" title="刷新" aria-label="刷新"><span class="pw-btn-icon">${ICONS.refresh}</span><span class="pw-btn-text">刷新</span></button>
          <button type="button" class="power-wall-toggle-btn" data-action="original" title="原始视图" aria-label="原始视图"><span class="pw-btn-icon">${ICONS.layoutList}</span><span class="pw-btn-text">原始</span></button>
        </div>
      `;
      // 必须挂到 body：fixed 元素若留在容器内，会受容器 opacity/祖先 transform 影响。
      // 放在 #root 之前（同为 z-index:1030，后出现的原生顶栏优先绘制）：
      // 这样系统顶栏的下拉菜单展开时可正常盖在工具栏之上，不会被工具栏压住。
      document.body.insertBefore(toolbar, document.body.firstChild);
      this.toolbarEl = toolbar;
      this.updateFixedToolbar();

      const slider = toolbar.querySelector('#pw-zoom-slider');
      if (slider) {
        // range 的 input 按指针采样率触发（>60Hz）。原实现每个事件都同步写 localStorage + 全量重排，
        // 实测 400 项时 40 个事件会阻塞主线程约 1s。
        // 现在：input 只更新内存配置 + rAF 合并后重排一次；change（松手）时才落盘一次。
        let zoomRaf = 0;
        let pendingZoom = null;
        const flushZoom = () => {
          if (pendingZoom === null || !this.isEnabled) return;
          const v = pendingZoom;
          pendingZoom = null;
          if (getConfig().zoomIndex !== v) saveConfig({ zoomIndex: v }, false);
          this.brickWall?.relayout();
        };
        slider.addEventListener('input', () => {
          pendingZoom = parseInt(slider.value, 10);
          if (!zoomRaf) zoomRaf = requestAnimationFrame(() => { zoomRaf = 0; flushZoom(); });
        });
        slider.addEventListener('change', () => {
          pendingZoom = parseInt(slider.value, 10);
          if (zoomRaf) { cancelAnimationFrame(zoomRaf); zoomRaf = 0; }
          flushZoom();
          saveConfig({ zoomIndex: parseInt(slider.value, 10) });   // 落盘一次
        });
      }
      toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'settings') this.openSettingsPanel();
        else if (action === 'filter') this.openFilterPanel();
        else if (action === 'home') this.goHome();
        else if (action === 'refresh') this.refresh();
        else if (action === 'random') this.loadRandom();
        else if (action === 'randomGallery') this.loadRandomGallery();
        else if (action === 'titleAsc') this.setTitleSort('ASC');
        else if (action === 'titleDesc') this.setTitleSort('DESC');
        else if (action === 'original') this.switchToOriginalView();
      });
    }

    /**
     * 悬浮工具栏贴合系统顶部导航下沿：高度与导航一致、z-index 同为 1030，
     * 滚动时位置不变。固定定位脱离文档流，因此在容器顶部预留同等高度，
     * 避免工具栏遮住第一行图片。
     */
    updateFixedToolbar() {
      if (!this.toolbarEl || !this.container) return;
      const nav = document.querySelector('.top-nav');
      const navHeight = nav ? nav.getBoundingClientRect().height : 0;
      const height = navHeight > 0 ? navHeight : 48.75;
      this.toolbarEl.style.top = navHeight > 0 ? `${navHeight}px` : '0px';
      this.toolbarEl.style.height = `${height}px`;
      this.container.style.setProperty('--pw-toolbar-space', `${height}px`);
    }

    async loadMore() {
      if (!this.isEnabled || !this.scroller || !this.scroller.hasMore || !this.wallContainer) return;
      const gen = this.generation;
      this.showLoading(true);
      try {
        const data = await this.fetchData();
        if (!this.isEnabled || !this.wallContainer || gen !== this.generation) return;
        if (data?.items?.length > 0) {
          this.totalCount = data.count;
          this.updateCount();
          await this.addItemsBatch(data.items, gen);
          if (!this.isEnabled || !this.wallContainer || !this.scroller || gen !== this.generation) return;
          this.page++;
          this.scroller.hasMore = this.items.length < this.totalCount;
        } else {
          if (this.scroller) this.scroller.hasMore = false;
        }
        if (this.scroller && !this.scroller.hasMore) this.showEndMessage();
      } catch (err) {
        error('加载失败:', err);
        this.showError();
      } finally {
        if (gen === this.generation) {
          this.showLoading(false);
          this.updateModeButtons();
          if (!this.container?.classList.contains('power-wall-ready')) {
            requestAnimationFrame(() => {
              this.container?.classList.add('power-wall-ready');
            });
          }
        }
      }
    }

    /** 按标题数字感知排序：设置方向并立即对已加载项重排（同向再点视为重复，忽略）*/
    setTitleSort(dir) {
      if (!this.isEnabled || this.titleSortDir === dir) return;
      this.titleSortDir = dir;
      this.applyTitleSort();
      this.updateTitleSortButtons();
    }

    /** 排序用标题：优先真实文件名（visual_files/files 的 basename），空 title 会退化为 #ID，不适用数字排序 */
    getItemSortTitle(data) {
      const fileBase = this.pageType === 'images'
        ? data?.visual_files?.[0]?.basename
        : data?.files?.[0]?.basename;
      return fileBase || data?.title || `#${data?.id ?? ''}`;
    }

    /** 对已加载项按标题重排：使用 id 匹配代替索引 zipper，避免因竞态导致 this.items 与 brickWall.items 长度不同步时残影/重复 */
    applyTitleSort() {
      if (!this.titleSortDir || !this.brickWall || !this.items.length) return;
      const dir = this.titleSortDir;

      // 以 data.id 建立 brickWall.item 映射，消除索引失配风险
      const wallItemMap = new Map();
      this.brickWall.items.forEach(wi => {
        const el = wi.element;
        const dataId = el?.dataset?.id || el?.querySelector?.('.power-wall-link')?.dataset?.id || '';
        if (dataId) wallItemMap.set(String(dataId), wi);
      });

      // 对齐：仅保留同时存在于两边的项（data 有对应 wallItem），避免孤儿。
      // seenDataIds 防止 this.items 中出现同 dataId 导致 brickWall.items 重复元素引用
      const combined = [];
      const seenDataIds = new Set();
      for (const entry of this.items) {
        const dataId = String(entry.data?.id ?? '');
        if (seenDataIds.has(dataId)) continue;
        seenDataIds.add(dataId);
        const wi = wallItemMap.get(dataId);
        if (wi) combined.push({ entry, wallItem: wi });
      }
      combined.sort((a, b) => compareByTitle(
        this.getItemSortTitle(a.entry.data),
        this.getItemSortTitle(b.entry.data),
        dir
      ));
      this.items = combined.map(c => c.entry);
      this.brickWall.items = combined.map(c => c.wallItem);

      // 把已不归属于此的孤儿元素清理出 DOM（防止留在砌墙容器内产生视觉重复）
      const keep = new Set(this.brickWall.items.map(wi => wi.element));
      const toRemove = [];
      for (let i = this.wallContainer.children.length - 1; i >= 0; i--) {
        const child = this.wallContainer.children[i];
        if (child.classList.contains('power-wall-item') && !keep.has(child)) {
          toRemove.push(child);
        }
      }
      toRemove.forEach(el => el.remove());

      const fragment = document.createDocumentFragment();
      this.brickWall.items.forEach(wi => fragment.appendChild(wi.element));
      this.wallContainer.appendChild(fragment);
      this.brickWall.forceFullRelayout();
      // 排序重排后 sentinel 在 DOM 树位置可能偏移，重新 observer 保证滚动加载正确触发
      this.scroller?.updateSentinel();
    }

    updateTitleSortButtons() {
      const root = this.toolbarEl || this.container;
      root?.querySelectorAll('[data-action="titleAsc"], [data-action="titleDesc"]').forEach(btn => {
        const active = (btn.dataset.action === 'titleAsc' && this.titleSortDir === 'ASC')
          || (btn.dataset.action === 'titleDesc' && this.titleSortDir === 'DESC');
        btn.classList.toggle('power-wall-toggle-btn-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    async fetchData() {
      const { findFilter, imageFilter, sceneFilter } = getFilterFromUrl();
      const perPage = getConfig().itemsPerPage;
      const baseFilter = {
        page: this.page,
        per_page: perPage,
        sort: findFilter.sort || 'created_at',
        direction: findFilter.direction || 'DESC'
      };
      if (findFilter.q) baseFilter.q = findFilter.q;
      let query, variables, resultKey;
      if (this.pageType === 'images') {
        query = `query FindImages($filter: FindFilterType, $image_filter: ImageFilterType) {
          findImages(filter: $filter, image_filter: $image_filter) {
            count
            images {
              id title rating100 o_counter
              paths { thumbnail preview image }
              visual_files { ... on ImageFile { width height path basename } }
              tags { id name } galleries { id title folder { path } }
            }
          }
        }`;
        variables = { filter: baseFilter, image_filter: imageFilter };
        resultKey = 'findImages';
      } else {
        query = `query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
          findScenes(filter: $filter, scene_filter: $scene_filter) {
            count
            scenes {
              id title details rating100 o_counter date
              paths { screenshot preview stream }
              files { width height duration basename }
              tags { id name } performers { id name } studio { id name }
            }
          }
        }`;
        variables = { filter: baseFilter, scene_filter: sceneFilter };
        resultKey = 'findScenes';
      }
      const result = await graphqlRequest(query, variables, this.abortController?.signal ? { signal: this.abortController.signal } : {});
      if (this.abortController?.signal?.aborted) return null;
      if (!result || !result[resultKey]) return null;
      const data = result[resultKey];
      return { count: data.count, items: data[this.pageType] || [] };
    }

    async addItemsBatch(itemsData, gen) {
      if (!this.wallContainer || !itemsData?.length) return;
      const cfg = getConfig();
      this.brickWall.margin = cfg.margin;
      this.brickWall.rowGap = cfg.rowGap;
      this.brickWall.columnGap = cfg.columnGap;

      const useLightbox = cfg.enableLightbox !== false;

      // 防重集合：基于 data.id 滤掉重复上墙项（同 id 仅保留首次出现）
      const seenIds = new Set();

      // 逐一上墙：每帧只插入 1 项，一张一张依次出现。
      // 取片仍按整页（itemsPerPage）请求，避免逐张 GraphQL 往返把加载拖慢一个数量级。
      let cursor = 0;
      let firstItemInserted = false;

      while (cursor < itemsData.length) {
        // 代际失配即退出：refresh/disable 后旧批次的残留循环不得继续追加（否则同一图片重复上墙）
        if (!this.isEnabled || gen !== this.generation) return;
        const end = Math.min(itemsData.length, cursor + 1);

        const fragment = document.createDocumentFragment();
        const prepared = [];

        for (let i = cursor; i < end; i++) {
          const data = itemsData[i];
          // 防重：同 id 已在墙上则跳过（可能在竞态或双重初始化中被重复添加）
          const dataId = String(data?.id ?? '');
          if (!dataId || seenIds.has(dataId) || this.addedDataIds.has(dataId)) continue;
          seenIds.add(dataId);
          this.addedDataIds.add(dataId);
          const item = this.createItemElement(data, useLightbox);
          if (!item) continue;
          const d = this.getImageDimensions(this.getItemThumbnail(data), data);
          const width = (d && d.width) ? d.width : 16;
          const height = (d && d.height) ? d.height : 9;
          prepared.push({ element: item, data, width, height });
          fragment.appendChild(item);
        }

        if (!this.wallContainer) return;
        this.wallContainer.appendChild(fragment);

        for (const p of prepared) {
          this.brickWall.addItem(p.element, p.width, p.height);
          this.items.push({ element: p.element, data: p.data });
        }

        this.brickWall.relayout();
        this.updateCount();

        prepared.forEach(({ element, data }) => {
          try {
            element.dispatchEvent(new CustomEvent('enhancedWallItemAdded', { detail: { item: element, data, type: this.pageType }, bubbles: true }));
          } catch (_) {}
        });

        cursor = end;

        // 首张上墙后立刻隐藏 loading，其余继续逐张插入
        if (!firstItemInserted) {
          firstItemInserted = true;
          this.showLoading(false);
        }

        if (cursor < itemsData.length) await this.waitNextFrame();
      }

      // 标题排序激活时，对本批做一次全量重排。
      // 原实现放在 chunk 循环内部：每 16 项就完整走一遍 Map 重建 + 排序 + 孤儿扫描 + 全量重挂 + 全量重排，
      // 实测（400+ 项）每页会产生 3–5 个 55–178ms 的长任务；移到批末后每页只剩一次。
      if (this.titleSortDir && this.isEnabled && gen === this.generation) this.applyTitleSort();
    }

    createItemElement(data, useLightbox) {
      const item = document.createElement('div');
      item.className = 'power-wall-item';
      item.dataset.id = data.id;
      item.dataset.type = this.pageType;
      const thumbnail = this.getItemThumbnail(data);
      const preview = this.getItemPreview(data);
      const link = this.getItemLink(data);
      const title = this.getItemTitle(data);
      const meta = this.getItemMeta(data);
      const specs = this.getItemSpecs(data);
      // 右下角有时长角标时，给 meta 行预留空间，避免 hover 时胶囊滑到角标下面
      if (specs.right) item.classList.add('power-wall-item-has-spec-right');
      item.innerHTML = `
        <a href="${link}" class="power-wall-link" data-id="${data.id}" data-type="${this.pageType}" ${useLightbox ? 'data-lightbox="1"' : ''}>
          <div class="power-wall-media">
            <img src="${thumbnail}" alt="${this.escapeHtml(title)}" loading="lazy">
            ${preview ? `<video src="${preview}" muted loop playsinline preload="none"></video>` : ''}
            ${this.pageType === 'scenes' ? '<div class="power-wall-play-indicator"><span class="play-icon"></span></div>' : ''}
          </div>
          ${specs.left ? `<div class="power-wall-specs">${specs.left}</div>` : ''}
          ${specs.right ? `<div class="power-wall-specs power-wall-specs-right">${specs.right}</div>` : ''}
          <div class="power-wall-overlay">
            <div class="power-wall-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
            <div class="power-wall-meta">${meta}</div>
          </div>
        </a>
      `;
      return item;
    }
    escapeHtml(text) {
      if (!text) return '';
      return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    getItemThumbnail(data) {
      if (this.pageType === 'images') return data.paths?.thumbnail || data.paths?.image || '';
      return data.paths?.screenshot || '';
    }
    getItemPreview(data) {
      return data.paths?.preview || null;
    }
    getItemLink(data) {
      return `/${this.pageType === 'scenes' ? 'scenes' : 'images'}/${data.id}`;
    }
    getItemTitle(data) {
      return data.title || `#${data.id}`;
    }
    getItemMeta(data) {
      const parts = [];
      if (data.rating100) parts.push(`<span class="meta-rating">${META_ICONS.star}${Math.round(data.rating100 / 20)}</span>`);
      if (data.o_counter) parts.push(`<span class="meta-views">${META_ICONS.eye}${data.o_counter}</span>`);
      if (data.performers?.length) parts.push(`<span class="meta-performers">${META_ICONS.user}${this.escapeHtml(data.performers.slice(0, 2).map(p => p.name).join(', '))}</span>`);
      if (data.studio?.name) parts.push(`<span class="meta-studio">${META_ICONS.building}${this.escapeHtml(data.studio.name)}</span>`);
      return parts.join('');
    }
    getItemSpecs(data) {
      // 返回 { left, right }：分辨率在左上角，时长等次要信息在右上角，避免都挤在左上
      const out = { left: '', right: '' };
      let width, height;
      if (data.files?.[0]) { width = data.files[0].width; height = data.files[0].height; }
      else if (data.visual_files?.[0]) { width = data.visual_files[0].width; height = data.visual_files[0].height; }
      if (height) {
        const res = formatResolution(width, height);
        const resClass = height >= 2160 ? 'resolution-4k' : height >= 1080 ? 'resolution-hd' : '';
        out.left = `<span class="power-wall-spec ${resClass}">${res}</span>`;
      }
      if (data.files?.[0]?.duration) out.right = `<span class="power-wall-spec duration">${formatDuration(data.files[0].duration)}</span>`;
      return out;
    }
    getImageDimensions(src, data) {
      let width, height;
      if (data.files?.[0]) { width = data.files[0].width; height = data.files[0].height; }
      else if (data.visual_files?.[0]) { width = data.visual_files[0].width; height = data.visual_files[0].height; }
      if (width && height) return { width, height };
      return { width: 16, height: 9 };
    }
    updateCount() {
      const root = this.toolbarEl || this.container;
      const el = root?.querySelector('.power-wall-count');
      if (el) el.textContent = `已加载 ${formatCountShort(this.items.length)} / ${formatCountShort(this.totalCount)} 项`;
    }
    showLoading(show) {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = show ? 'flex' : 'none';
        this.loadingIndicator.innerHTML = '<div class="power-wall-loading-spinner"></div><span>加载中...</span>';
      }
    }
    showEndMessage() {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = 'flex';
        this.loadingIndicator.innerHTML = `<span class="power-wall-end">${ICONS.checkCircle}已加载全部</span>`;
      }
    }
    showError() {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = 'flex';
        this.loadingIndicator.innerHTML = `<span class="power-wall-error">${ICONS.alert}加载失败，请刷新</span>`;
      }
    }
    async refresh() {
      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();
      this.generation++;
      this.items.forEach(item => item.element?.remove());
      this.items = [];
      this.addedDataIds.clear();
      this.page = 1;
      this.titleSortDir = null;
      this.updateTitleSortButtons();
      if (this.brickWall) this.brickWall.clear();
      if (this.scroller) this.scroller.reset();
      await this.loadMore();
      this.updateModeButtons();
    }

    /** 当前是否已"离开首页"：URL 上带任何筛选/图库/随机/非默认排序参数 */
    isAwayFromHome() {
      const { findFilter, imageFilter, sceneFilter } = getFilterFromUrl();
      if (findFilter.q) return true;
      if (Object.keys(imageFilter).length || Object.keys(sceneFilter).length) return true;
      const cfg = getConfig();
      const defSort = cfg.lastSort || 'created_at';
      const defDir = (cfg.lastSortDir || 'DESC').toUpperCase();
      const sort = findFilter.sort || defSort;
      if (String(sort).startsWith('random_')) return true;
      if (sort !== defSort) return true;
      return (findFilter.direction || defDir) !== defDir;
    }

    /**
     * 三种"视图模式"按钮（首页 / 随览 / 随阅）各自的状态：
     *   随览 = URL 上带随机排序（sortby=random_*）
     *   随阅 = URL 上带随机图库（galleries=*）
     *   首页 = 既非上面两者，也没有任何筛选/非默认排序，即默认视图
     */
    getViewModes() {
      const params = new URLSearchParams(window.location.search);
      const random = String(params.get('sortby') || '').startsWith('random_');
      const gallery = params.has('galleries') || params.has('gallery_ids');
      return { random, gallery, home: !random && !gallery && !this.isAwayFromHome() };
    }

    /**
     * 只点亮"当前正在生效"的那个模式按钮：
     * 点『随览』点亮的是『随览』、点『随阅』点亮的是『随阅』，
     * 只有回到默认视图时『首页』才点亮，避免给用户错误的模式指示。
     */
    updateModeButtons() {
      const root = this.toolbarEl || this.container;
      if (!root) return;
      const modes = this.getViewModes();
      const set = (action, on) => {
        const btn = root.querySelector(`[data-action="${action}"]`);
        if (!btn) return;
        btn.classList.toggle('power-wall-toggle-btn-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      };
      set('home', modes.home);
      set('random', modes.random);
      set('randomGallery', modes.gallery);
    }

    /**
     * 回到首页：清除 URL 上全部筛选/图库/随机/排序参数，恢复默认排序后重新加载。
     * 随览（随机排序）与随阅（随机图库）之后无需刷新浏览器即可回到默认视图。
     */
    goHome() {
      const modal = document.getElementById('power-wall-filter-modal');
      if (modal) modal.style.display = 'none';
      saveConfig({ lastSort: 'created_at', lastSortDir: 'DESC' });
      const home = buildHomeUrl();
      if (window.location.pathname + window.location.search !== home) window.history.pushState({}, '', home);
      this.refresh();
    }
    loadRandom() {
      const url = new URL(window.location.href);
      url.searchParams.set('sortby', 'random_' + Date.now());
      url.searchParams.delete('page');
      window.history.pushState({}, '', url.href);
      this.refresh();
    }

    /** 随阅：在当墙内打开一个随机图库里的全部资源（不跳转页面；与随览不同：随览完全随机，随阅随机选图库）*/
    async loadRandomGallery() {
      if (this.pageType !== 'images') {
        error('随阅仅在图片页可用');
        return;
      }
      const query = `query FindGalleries($filter: FindFilterType) {
        findGalleries(filter: $filter) {
          count
          galleries { id title }
        }
      }`;
      const filter = {
        per_page: 250,
        page: 1,
        sort: 'random_' + Date.now(),
        direction: 'ASC'
      };
      const result = await graphqlRequest(query, { filter }, this.abortController?.signal ? { signal: this.abortController.signal } : {});
      const data = result?.findGalleries;
      if (!data?.galleries?.length) {
        error('未找到任何图库');
        return;
      }
      const gallery = data.galleries[Math.floor(Math.random() * data.galleries.length)];
      const url = new URL('/images', window.location.origin);
      url.searchParams.set('galleries', String(gallery.id));
      url.searchParams.delete('page');
      window.history.pushState({}, '', url.pathname + url.search);
      this.refresh();
    }

    async fetchFilterOptions() {
      const [tagsRes, performersRes, studiosRes] = await Promise.all([
        graphqlRequest('query { findTags(filter: { per_page: 80 }) { tags { id name } } }'),
        graphqlRequest('query { findPerformers(filter: { per_page: 80 }) { performers { id name } } }'),
        graphqlRequest('query { findStudios(filter: { per_page: 80 }) { studios { id name } } }'),
      ]);
      return {
        tags: tagsRes?.findTags?.tags || [],
        performers: performersRes?.findPerformers?.performers || [],
        studios: studiosRes?.findStudios?.studios || [],
      };
    }

    async openFilterPanel() {
      const params = new URLSearchParams(window.location.search);
      const cfg = getConfig();
      const currentQ = params.get('q') || '';
      const currentTags = params.get('tags') || params.get('tag_ids') || '';
      const currentPerformers = params.get('performers') || params.get('performer_ids') || '';
      const currentStudios = params.get('studios') || params.get('studio_ids') || '';
      const sortbyParam = params.get('sortby') || cfg.lastSort || 'created_at';
      const currentSort = sortbyParam.startsWith('random_') ? 'random' : sortbyParam;
      const currentSortDir = (params.get('sortdir') || cfg.lastSortDir || 'DESC').toUpperCase();
      let modal = document.getElementById('power-wall-filter-modal');
      if (modal) {
        modal.querySelector('#pw-filter-q').value = currentQ;
        modal.querySelector('#pw-filter-sortby').value = currentSort;
        modal.querySelector('#pw-filter-sortdir').value = currentSortDir === 'ASC' ? 'ASC' : 'DESC';
        this.populateFilterCheckboxes(modal, currentTags, currentPerformers, currentStudios);
        modal.style.display = 'flex';
        return;
      }
      modal = document.createElement('div');
      modal.id = 'power-wall-filter-modal';
      modal.className = 'power-wall-settings-modal power-wall-filter-modal';
      const sortOpts = [['created_at', '创建时间'], ['date', '日期'], ['title', '标题'], ['rating100', '评分'], ['updated_at', '更新时间'], ['random', '随机']];
      modal.innerHTML = `
        <div class="power-wall-settings-overlay"></div>
        <div class="power-wall-settings-panel power-wall-filter-panel">
          <div class="power-wall-settings-header">
            <h3><span class="pw-h3-icon">${ICONS.filter}</span>筛选</h3>
            <button type="button" class="power-wall-settings-close" data-action="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
          </div>
          <div class="power-wall-settings-body">
            <div class="power-wall-settings-section">
              <h4>关键词</h4>
              <input type="text" class="power-wall-filter-input" id="pw-filter-q" placeholder="搜索" value="${currentQ.replace(/"/g, '&quot;')}">
            </div>
            <div class="power-wall-settings-section">
              <h4>排序</h4>
              <div class="power-wall-filter-row">
                <select id="pw-filter-sortby" class="power-wall-filter-select">${sortOpts.map(([v, l]) => `<option value="${v}" ${currentSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <select id="pw-filter-sortdir" class="power-wall-filter-select">
                  <option value="DESC" ${currentSortDir === 'DESC' ? 'selected' : ''}>降序</option>
                  <option value="ASC" ${currentSortDir === 'ASC' ? 'selected' : ''}>升序</option>
                </select>
              </div>
            </div>
            <div class="power-wall-settings-section"><h4>标签</h4><div class="power-wall-filter-list" id="pw-filter-tags">加载中...</div></div>
            <div class="power-wall-settings-section"><h4>演员</h4><div class="power-wall-filter-list" id="pw-filter-performers">加载中...</div></div>
            <div class="power-wall-settings-section"><h4>工作室</h4><div class="power-wall-filter-list" id="pw-filter-studios">加载中...</div></div>
          </div>
          <div class="power-wall-settings-footer">
            <button type="button" class="power-wall-settings-btn" data-action="clearFilter"><span class="pw-btn-icon">${ICONS.rotateCcw}</span>清除</button>
            <button type="button" class="power-wall-settings-btn primary" data-action="applyFilter"><span class="pw-btn-icon">${ICONS.check}</span>应用</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      const escapeFn = (t) => (t || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const renderCheckboxList = (containerId, items, currentIds, nameKey) => {
        const container = modal.querySelector('#' + containerId);
        if (!container) return;
        const ids = new Set(parseIdList(currentIds));
        container.innerHTML = items.length
          ? items.map(it => `<label class="power-wall-filter-item"><input type="checkbox" value="${it.id}" ${ids.has(parseInt(it.id, 10)) ? 'checked' : ''}> ${escapeFn(it[nameKey] || it.name || '')}</label>`).join('')
          : '<span class="power-wall-filter-empty">无</span>';
      };
      this.populateFilterCheckboxes = (m, tagIds, performerIds, studioIds) => {
        ['pw-filter-tags', 'pw-filter-performers', 'pw-filter-studios'].forEach((id, idx) => {
          const ids = [tagIds, performerIds, studioIds][idx];
          const set = new Set(parseIdList(ids));
          m.querySelector('#' + id)?.querySelectorAll('input')?.forEach(cb => { cb.checked = set.has(parseInt(cb.value, 10)); });
        });
      };
      try {
        const opts = await this.fetchFilterOptions();
        renderCheckboxList('pw-filter-tags', opts.tags, currentTags, 'name');
        renderCheckboxList('pw-filter-performers', opts.performers, currentPerformers, 'name');
        renderCheckboxList('pw-filter-studios', opts.studios, currentStudios, 'name');
      } catch (e) {
        const tagsEl = modal.querySelector('#pw-filter-tags');
        if (tagsEl) tagsEl.textContent = '加载失败';
      }
      const getSelectedIds = (id) => [...(modal.querySelector('#' + id)?.querySelectorAll('input:checked') || [])].map(cb => cb.value).filter(Boolean);
      const applyFilter = () => {
        const q = modal.querySelector('#pw-filter-q')?.value?.trim() || '';
        let sortby = modal.querySelector('#pw-filter-sortby')?.value || 'created_at';
        const sortdir = modal.querySelector('#pw-filter-sortdir')?.value || 'DESC';
        if (sortby === 'random') sortby = 'random_' + Date.now();
        if (!sortby.startsWith('random_')) saveConfig({ lastSort: sortby, lastSortDir: sortdir });
        const tags = getSelectedIds('pw-filter-tags');
        const performers = getSelectedIds('pw-filter-performers');
        const studios = getSelectedIds('pw-filter-studios');
        const url = new URL(window.location.href);
        if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
        url.searchParams.set('sortby', sortby);
        if (sortby.startsWith('random_')) url.searchParams.delete('sortdir');
        else url.searchParams.set('sortdir', sortdir);
        if (tags.length) url.searchParams.set('tags', tags.join(',')); else url.searchParams.delete('tags');
        if (performers.length) url.searchParams.set('performers', performers.join(',')); else url.searchParams.delete('performers');
        if (studios.length) url.searchParams.set('studios', studios.join(',')); else url.searchParams.delete('studios');
        url.searchParams.delete('page');
        window.history.pushState({}, '', url.href);
        modal.style.display = 'none';
        this.refresh();
      };
      const clearFilter = () => {
        saveConfig({ lastSort: 'created_at', lastSortDir: 'DESC' });
        window.history.pushState({}, '', buildHomeUrl());
        modal.style.display = 'none';
        this.refresh();
      };
      modal.querySelector('.power-wall-settings-overlay').addEventListener('click', () => { modal.style.display = 'none'; });
      modal.querySelector('[data-action="close"]').addEventListener('click', () => { modal.style.display = 'none'; });
      modal.querySelector('[data-action="applyFilter"]').addEventListener('click', applyFilter);
      modal.querySelector('[data-action="clearFilter"]').addEventListener('click', clearFilter);
      modal.style.display = 'flex';
    }

    openSettingsPanel() {
      let modal = document.getElementById('power-wall-settings-modal');
      if (modal) {
        modal.style.display = 'flex';
        this.populateSettingsForm(modal);
        return;
      }
      const cfg = getConfig();
      modal = document.createElement('div');
      modal.id = 'power-wall-settings-modal';
      modal.className = 'power-wall-settings-modal';
      modal.innerHTML = `
        <div class="power-wall-settings-overlay"></div>
        <div class="power-wall-settings-panel">
          <div class="power-wall-settings-header">
            <h3><span class="pw-h3-icon">${ICONS.sliders}</span>砌墙设置</h3>
            <button type="button" class="power-wall-settings-close" data-action="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
          </div>
          <div class="power-wall-settings-body">
            <div class="power-wall-settings-section">
              <h4>布局预设</h4>
              <select id="pw-setting-layoutPreset" class="power-wall-settings-select">
                ${Object.entries(LAYOUT_PRESETS).map(([key, p]) => `<option value="${key}" ${cfg.layoutPreset === key ? 'selected' : ''}>${p.label}</option>`).join('')}
              </select>
            </div>
            <div class="power-wall-settings-section">
              <h4>功能</h4>
              <div class="power-wall-settings-row power-wall-settings-checkbox">
                <label><input type="checkbox" id="pw-setting-enableOnImages" ${cfg.enableOnImages ? 'checked' : ''}> 图片列表启用</label>
              </div>
              <div class="power-wall-settings-row power-wall-settings-checkbox">
                <label><input type="checkbox" id="pw-setting-enableOnScenes" ${cfg.enableOnScenes ? 'checked' : ''}> 短片列表启用</label>
              </div>
              <div class="power-wall-settings-row power-wall-settings-checkbox">
                <label><input type="checkbox" id="pw-setting-enableLightbox" ${cfg.enableLightbox !== false ? 'checked' : ''}> 点击图片用内置 lightbox</label>
              </div>
            </div>
            <details class="power-wall-settings-advanced">
              <summary><span class="pw-btn-icon">${ICONS.chevronDown}</span>高级</summary>
              <div class="power-wall-settings-row">
                <label>每页数量</label>
                <input type="number" id="pw-setting-itemsPerPage" min="12" max="120" value="${cfg.itemsPerPage}">
              </div>
              <div class="power-wall-settings-row power-wall-settings-checkbox">
                <label><input type="checkbox" id="pw-setting-debug" ${cfg.debug ? 'checked' : ''}> 调试</label>
              </div>
            </details>
          </div>
          <div class="power-wall-settings-footer">
            <button type="button" class="power-wall-settings-btn" data-action="reset"><span class="pw-btn-icon">${ICONS.rotateCcw}</span>恢复默认</button>
            <button type="button" class="power-wall-settings-btn primary" data-action="save"><span class="pw-btn-icon">${ICONS.check}</span>保存并应用</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('.power-wall-settings-overlay').addEventListener('click', () => this.closeSettingsPanel());
      modal.querySelector('[data-action="close"]').addEventListener('click', () => this.closeSettingsPanel());
      modal.querySelector('[data-action="save"]').addEventListener('click', () => this.saveSettings());
      modal.querySelector('[data-action="reset"]').addEventListener('click', () => this.resetSettings());
      modal.style.display = 'flex';
    }
    populateSettingsForm(modal) {
      if (!modal) return;
      const cfg = getConfig();
      const n = (id) => modal.querySelector('#' + id);
      if (n('pw-setting-layoutPreset')) n('pw-setting-layoutPreset').value = cfg.layoutPreset || 'normal';
      if (n('pw-setting-itemsPerPage')) n('pw-setting-itemsPerPage').value = cfg.itemsPerPage;
      ['enableOnImages', 'enableOnScenes', 'enableLightbox', 'debug'].forEach(id => {
        const el = n('pw-setting-' + id);
        if (el) el.checked = cfg[id];
      });
    }
    closeSettingsPanel() {
      const modal = document.getElementById('power-wall-settings-modal');
      if (modal) modal.style.display = 'none';
    }
    saveSettings() {
      const presetKey = document.getElementById('pw-setting-layoutPreset')?.value || 'normal';
      const preset = LAYOUT_PRESETS[presetKey] || LAYOUT_PRESETS.normal;
      const updates = {
        layoutPreset: presetKey,
        margin: preset.margin,
        rowGap: preset.rowGap,
        columnGap: preset.columnGap,
        enableOnImages: document.getElementById('pw-setting-enableOnImages')?.checked ?? true,
        enableOnScenes: document.getElementById('pw-setting-enableOnScenes')?.checked ?? true,
        enableLightbox: document.getElementById('pw-setting-enableLightbox')?.checked ?? true,
        itemsPerPage: Math.max(12, Math.min(120, parseInt(document.getElementById('pw-setting-itemsPerPage')?.value, 10) || DEFAULT_CONFIG.itemsPerPage)),
        debug: document.getElementById('pw-setting-debug')?.checked ?? false,
      };
      saveConfig(updates);
      this.closeSettingsPanel();
      this.disable();
      this.enable();
    }
    resetSettings() {
      resetConfig();
      this.populateSettingsForm(document.getElementById('power-wall-settings-modal'));
    }
  }

  // ==================== 初始化 ====================
  const SWITCH_BTN_ID = 'power-wall-switch-to-wall';

  function removeSwitchToWallButton() {
    document.getElementById(SWITCH_BTN_ID)?.remove();
  }

  /**
   * 「原始」视图下的唯一返回入口：固定右下角的「墙视图」按钮。
   * 刻意做成功能唯一（点击即回到砌墙，不带任何其它动作），位置固定且常驻，
   * 避免用户停在原生视图时找不到插件、以为插件失效。
   */
  function mountSwitchToWallButton(pageType) {
    removeSwitchToWallButton();
    const btn = document.createElement('button');
    btn.id = SWITCH_BTN_ID;
    btn.type = 'button';
    btn.className = 'power-wall-switch-to-wall';
    btn.title = '切换到墙视图';
    btn.setAttribute('aria-label', '切换到墙视图');
    btn.innerHTML = `${ICONS.layoutGrid}<span>墙视图</span>`;
    btn.addEventListener('click', () => {
      setViewMode(pageType, 'wall');
      removeSwitchToWallButton();
      init();
    });
    document.body.appendChild(btn);
  }

  let powerWall = null;
  function init() {
    const pageType = getPageType();
    // 非列表页 / 该页面类型未启用：确保不残留隐藏原生内容的 class（否则会出现"空白列表"）
    if (!pageType) { unmountPowerWall(false); return; }
    if (pageType === 'images') {
      const params = new URLSearchParams(window.location.search);
      if (params.has('galleries') || params.has('gallery_ids')) {
        window.location.replace(window.location.pathname);
        return;
      }
    }
    // 「原始」视图：不挂砌墙、不隐藏原生列表，只挂一个「墙视图」返回按钮
    if (getViewMode(pageType) === 'original') {
      if (powerWall) { powerWall.disable(); powerWall = null; }
      document.documentElement.classList.remove('power-wall-preload');
      document.body.classList.remove('power-wall-active');
      mountSwitchToWallButton(pageType);
      return;
    }
    removeSwitchToWallButton();
    if (powerWall) powerWall.disable();
    powerWall = new PowerWall();
    powerWall.init();
  }
  function mountPowerWall(container) {
    if (!container || powerWall) return;
    if (getViewMode(getPageType() || '') === 'original') return;
    powerWall = new PowerWall();
    powerWall.enable(container);
  }
  function unmountPowerWall(keepPreload) {
    if (powerWall) { powerWall.disable(); powerWall = null; }
    document.body.classList.remove('power-wall-active');
    document.body.classList.remove('power-wall-lightbox-open');
    document.body.style.paddingRight = '';
    document.documentElement.style.paddingRight = '';
    // 列表页之间切换时保留 preload，避免重建间隙原生网格闪出
    if (!keepPreload) document.documentElement.classList.remove('power-wall-preload');
    document.getElementById('power-wall-back-to-top')?.remove();
    removeSwitchToWallButton();
    const overlay = document.getElementById('power-wall-lightbox-overlay');
    if (overlay?.classList.contains('power-wall-lightbox-visible')) {
      overlay.classList.remove('power-wall-lightbox-visible');
      document.body.style.overflow = '';
    }
  }
  function setupPluginApi() {
    const api = window.PluginApi;
    if (!api?.Event) return false;
    api.Event.addEventListener('stash:location', (e) => {
      const path = e.detail?.data?.location?.pathname || window.location.pathname;
      document.body.classList.add('power-wall-transitioning');
      const toList = !isExcludedPath(path) && isListPath(path);
      unmountPowerWall(toList);
      if (toList) {
        // 目标仍是列表页：立即隐藏原生列表，避免重建窗口内原生网格闪出
        document.documentElement.classList.add('power-wall-preload');
        // 立即挂载新墙，不再等待 300ms；300ms 处仅做存活检查：
        // 若 React 路由重绘将容器冲掉（detached），再兜底重建一次
        init();
        setTimeout(() => {
          // 「原始」视图下 powerWall 为空但按钮已在，属正常状态，不必再 init 一次
          if (!powerWall?.container?.isConnected && !document.getElementById(SWITCH_BTN_ID)) init();
          requestAnimationFrame(() => document.body.classList.remove('power-wall-transitioning'));
        }, 300);
      } else {
        requestAnimationFrame(() => document.body.classList.remove('power-wall-transitioning'));
      }
    });
    return true;
  }
  function setupFallback() {
    let lastUrl = location.href;
    let initTimeout = null;
    const checkUrl = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      if (initTimeout) clearTimeout(initTimeout);
      document.body.classList.add('power-wall-transitioning');
      const path = window.location.pathname;
      const toList = !isExcludedPath(path) && isListPath(path);
      unmountPowerWall(toList);
      if (toList) {
        // 目标仍是列表页：立即隐藏原生列表，避免重建窗口内原生网格闪出
        document.documentElement.classList.add('power-wall-preload');
        // 立即挂载新墙；300ms 处仅做存活检查，容器被 React 冲掉则兜底重建
        init();
        initTimeout = setTimeout(() => {
          initTimeout = null;
          // 「原始」视图下 powerWall 为空但按钮已在，属正常状态，不必再 init 一次
          if (!powerWall?.container?.isConnected && !document.getElementById(SWITCH_BTN_ID)) init();
          requestAnimationFrame(() => document.body.classList.remove('power-wall-transitioning'));
        }, 300);
      } else {
        document.body.classList.remove('power-wall-transitioning');
      }
    };
    window.addEventListener('popstate', checkUrl);
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    if (origPush) history.pushState = function(...args) { origPush.apply(this, args); setTimeout(checkUrl, 50); };
    if (origReplace) history.replaceState = function(...args) { origReplace.apply(this, args); setTimeout(checkUrl, 50); };
  }
  function bootstrap() {
    if (setupPluginApi()) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    } else {
      setupFallback();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    }
  }
  if (window.PluginApi) bootstrap();
  else {
    const tryBootstrap = () => { if (window.PluginApi) { bootstrap(); return; } setTimeout(tryBootstrap, 50); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(tryBootstrap, 100));
    else setTimeout(tryBootstrap, 100);
  }
  log('PowerWall 砌墙视图插件已加载');
})();
