/**
 * PowerWall — Stash 原生风格砌墙视图插件
 * @version 1.4.1
 *
 * 砌墙布局：边距(margin)、行距(rowGap)、列距(columnGap)，按行排列、统一行高，
 * 替代自适应瀑布流。支持 /images、/scenes 列表，无限滚动、内置 lightbox、筛选与设置。
 *
 * 参考：Image-Wall与缩放滑块技术调研报告、Image-Lightbox-技术调研报告
 * API：PluginApi.Event 监听 stash:location
 */

(function() {
  'use strict';

  const isZh = () => {
    const lang = (navigator.language || navigator.userLanguage || document.documentElement?.lang || '').toLowerCase();
    return lang.startsWith('zh');
  };
  const t = (zh, en) => (isZh() ? zh : en);

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

  /** 布局预设：边距、行距、列距 */
  const LAYOUT_PRESETS = {
    compact:  { margin: 2, rowGap: 2, columnGap: 2, labelZh: '紧凑', labelEn: 'Compact' },
    normal:   { margin: 4, rowGap: 4, columnGap: 4, labelZh: '标准', labelEn: 'Normal' },
    spacious: { margin: 8, rowGap: 8, columnGap: 8, labelZh: '宽松', labelEn: 'Spacious' },
  };
  const getPresetLabel = (p) => p ? t(p.labelZh, p.labelEn) : '';

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
    debug: false,
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
  function saveConfig(updates) {
    const current = getConfig();
    const merged = { ...current, ...updates };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[PowerWall]', t('配置保存失败', 'Failed to save config'), e);
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
        error(t('GraphQL错误', 'GraphQL error') + ':', errMsg);
        return null;
      }
      return result.data;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      error(t('请求失败', 'Request failed') + ':', err);
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

  function parseIdList(val) {
    if (!val || typeof val !== 'string') return [];
    return val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  }

  function getFilterFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const findFilter = {};
    if (params.has('q')) findFilter.q = params.get('q');
    if (params.has('sortby')) findFilter.sort = params.get('sortby');
    const sortDir = params.get('sortdir') || '';
    findFilter.direction = (sortDir.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
    const tagIds = parseIdList(params.get('tags') || params.get('tag_ids'));
    const performerIds = parseIdList(params.get('performers') || params.get('performer_ids'));
    const studioIds = parseIdList(params.get('studios') || params.get('studio_ids'));
    const galleryIds = parseIdList(params.get('galleries') || params.get('gallery_ids'));
    const pathFilter = params.get('path') || params.get('path_filter') || '';
    const imageFilter = {};
    const sceneFilter = {};
    if (pathFilter) {
      imageFilter.path = { value: pathFilter, modifier: 'INCLUDES' };
      sceneFilter.path = { value: pathFilter, modifier: 'INCLUDES' };
    }
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
  function openBuiltinLightbox(ids, index, type) {
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
          <span class="power-wall-lightbox-counter"></span>
          <button type="button" class="power-wall-lightbox-close" title="${t('关闭 (Esc)', 'Close (Esc)')}">&times;</button>
        </div>
        <button type="button" class="power-wall-lightbox-prev" title="${t('上一张', 'Previous')}">&#9664;</button>
        <div class="power-wall-lightbox-content">
          <img class="power-wall-lightbox-img" alt="" draggable="false">
        </div>
        <button type="button" class="power-wall-lightbox-next" title="${t('下一张', 'Next')}">&#9654;</button>
        <div class="power-wall-lightbox-footer">
          <a class="power-wall-lightbox-detail" href="#" target="_blank">${t('查看详情', 'View details')}</a>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay._lbState = { scale: 1, translateX: 0, translateY: 0, lastX: 0, lastY: 0, isDragging: false };
      overlay._lbRaf = null;
      const imgEl = overlay.querySelector('.power-wall-lightbox-img');
      const content = overlay.querySelector('.power-wall-lightbox-content');
      const applyTransform = () => {
        overlay._lbRaf = null;
        const s = overlay._lbState;
        imgEl.style.transform = `translate(${s.translateX}px, ${s.translateY}px) scale(${s.scale})`;
      };
      const scheduleApply = () => {
        if (!overlay._lbRaf) overlay._lbRaf = requestAnimationFrame(applyTransform);
      };
      overlay.querySelector('.power-wall-lightbox-backdrop').addEventListener('click', () => overlay.dispatchEvent(new CustomEvent('lightbox:close')));
      overlay.querySelector('.power-wall-lightbox-close').addEventListener('click', () => overlay.dispatchEvent(new CustomEvent('lightbox:close')));
      overlay.querySelector('.power-wall-lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:prev')); });
      overlay.querySelector('.power-wall-lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:next')); });
      content.addEventListener('wheel', (e) => {
        e.preventDefault();
        const s = overlay._lbState;
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : (e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY);
        const factor = 1 - delta * 0.002;
        const newScale = Math.max(0.2, Math.min(10, s.scale * factor));
        if (newScale === s.scale) return;
        const rect = content.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        const mx = e.clientX - cx, my = e.clientY - cy;
        s.translateX = mx * (1 - newScale / s.scale) + s.translateX * (newScale / s.scale);
        s.translateY = my * (1 - newScale / s.scale) + s.translateY * (newScale / s.scale);
        s.scale = newScale;
        scheduleApply();
      }, { passive: false });
      content.addEventListener('mousedown', (e) => {
        if (e.button === 0) { overlay._lbState.isDragging = true; overlay._lbState.lastX = e.clientX; overlay._lbState.lastY = e.clientY; }
      });
      overlay._lbMouseMove = (e) => {
        const s = overlay._lbState;
        if (s.isDragging) { s.translateX += e.clientX - s.lastX; s.translateY += e.clientY - s.lastY; s.lastX = e.clientX; s.lastY = e.clientY; scheduleApply(); }
      };
      overlay._lbMouseUp = () => { if (overlay._lbState) overlay._lbState.isDragging = false; };
    }
    if (!overlay._lbState) overlay._lbState = { scale: 1, translateX: 0, translateY: 0 };
    overlay._lbIds = ids;
    overlay._lbIndex = index;
    overlay._lbTotal = ids.length;
    const updateContent = () => {
      if (!overlay.isConnected) return;
      const idx = overlay._lbIndex;
      const total = overlay._lbTotal;
      const id = overlay._lbIds?.[idx];
      if (!id) return;
      const img = overlay.querySelector('.power-wall-lightbox-img');
      const counter = overlay.querySelector('.power-wall-lightbox-counter');
      const detailLink = overlay.querySelector('.power-wall-lightbox-detail');
      const s = overlay._lbState || {};
      s.scale = 1; s.translateX = 0; s.translateY = 0;
      if (img) img.src = getImageUrl(id);
      if (img) img.style.transform = 'translate(0,0) scale(1)';
      if (counter) counter.textContent = `${idx + 1} / ${total}`;
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
        if (overlay._lbMouseMove) document.removeEventListener('mousemove', overlay._lbMouseMove);
        if (overlay._lbMouseUp) document.removeEventListener('mouseup', overlay._lbMouseUp);
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
      const columnHeights = new Array(columnCount).fill(0);

      for (const item of this.items) {
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

      const maxHeight = columnHeights.length ? Math.max(...columnHeights) - this.rowGap + this.margin : 0;
      this.container.style.height = `${maxHeight}px`;
      this.container.style.padding = `${this.margin}px`;
      this.container.style.margin = '0 auto';
      this.container.style.boxSizing = 'content-box';
    }

    clear() {
      this.items = [];
      this.container.style.height = '0';
      this.container.style.padding = '0';
      this.container.style.margin = '0 auto';
    }
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
    }
    start(container) {
      if (!container || this.observer) return;
      this.sentinel = document.createElement('div');
      this.sentinel.className = 'power-wall-sentinel';
      this.sentinel.style.cssText = 'position:absolute;left:0;bottom:0;width:1px;height:1px;pointer-events:none';
      container.appendChild(this.sentinel);
      this.observer = new IntersectionObserver(
        (entries) => {
          if (this.isLoading || !this.hasMore) return;
          const e = entries[0];
          if (e?.isIntersecting) {
            try { this.loadMore(); } catch (err) { this.isLoading = false; }
          }
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
      if (this.observer && this.sentinel) this.observer.unobserve(this.sentinel);
      this.observer = null;
      this.sentinel?.remove();
      this.sentinel = null;
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
    }
    reset() {
      this.isLoading = false;
      this.hasMore = true;
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

  // ==================== 主类 PowerWall ====================
  class PowerWall {
    constructor() {
      this.container = null;
      this.wallContainer = null;
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
        error(t('创建容器失败', 'Failed to create container'));
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
        if (!this.isEnabled || !this.brickWall) return;
        requestAnimationFrame(() => {
          if (this.isEnabled && this.brickWall) this.brickWall.relayout();
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
        this.resizeObserver.observe(document.documentElement);
      }
      this._lastScrollbarW = getScrollbarWidth();
      this._viewportCheck = setInterval(() => {
        if (!this.isEnabled || !this.brickWall) return;
        const now = getScrollbarWidth();
        if (now !== this._lastScrollbarW) {
          this._lastScrollbarW = now;
          this.resizeHandler();
        }
      }, 200);
      this.createBackToTopButton();
    }

    createBackToTopButton() {
      let btn = document.getElementById('power-wall-back-to-top');
      if (btn) return;
      btn = document.createElement('button');
      btn.id = 'power-wall-back-to-top';
      btn.type = 'button';
      btn.className = 'power-wall-back-to-top';
      btn.title = t('返回顶部', 'Back to top');
      btn.textContent = 'TOP';
      btn.setAttribute('aria-label', t('返回顶部', 'Back to top'));
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

    disable() {
      if (!this.isEnabled) return;
      this.isEnabled = false;
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
      if (this.regionElement) { this.regionElement.classList.remove('power-wall-region'); this.regionElement = null; }
      if (this.container) { this.container.remove(); this.container = null; this.wallContainer = null; }
      this.brickWall = null;
      this.items = [];
      this.page = 1;
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
      if (type === 'images') openBuiltinLightbox(ids, index, type);
      else window.location.href = `/${type}/${id}`;
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
      if (!targetContainer) { error(t('找不到容器', 'Container not found')); return; }
      this.container = document.createElement('div');
      this.container.className = 'power-wall-container';
      const cfg = getConfig();
      const zoomMax = ZOOM_WIDTHS.length - 1;
      this.container.innerHTML = `
        <div class="power-wall-toolbar">
          <div class="power-wall-toolbar-left">
            <span class="power-wall-count">${t('加载中...', 'Loading...')}</span>
          </div>
          <div class="power-wall-toolbar-zoom">
            <input type="range" class="power-wall-zoom-slider" id="pw-zoom-slider" min="0" max="${zoomMax}" value="${Math.min(cfg.zoomIndex, zoomMax)}" title="${t('缩放', 'Zoom')}">
          </div>
          <div class="power-wall-toggle">
            <button type="button" class="power-wall-toggle-btn" data-action="random" title="${t('随机', 'Random')}"><span class="pw-btn-icon">🎲</span><span class="pw-btn-text">${t('随览', 'Random')}</span></button>
            <button type="button" class="power-wall-toggle-btn" data-action="filter" title="${t('筛选', 'Filter')}"><span class="pw-btn-icon">🔍</span><span class="pw-btn-text">${t('筛选', 'Filter')}</span></button>
            <button type="button" class="power-wall-toggle-btn" data-action="settings" title="${t('设置', 'Settings')}"><span class="pw-btn-icon">⚙️</span><span class="pw-btn-text">${t('设置', 'Settings')}</span></button>
            <button type="button" class="power-wall-toggle-btn" data-action="refresh" title="${t('刷新', 'Refresh')}"><span class="pw-btn-icon">🔄</span><span class="pw-btn-text">${t('刷新', 'Refresh')}</span></button>
            <button type="button" class="power-wall-toggle-btn" data-action="original" title="${t('原始视图', 'Original view')}"><span class="pw-btn-icon">📋</span><span class="pw-btn-text">${t('原始', 'Original')}</span></button>
          </div>
        </div>
        <div class="power-wall-masonry"></div>
        <div class="power-wall-loading">
          <div class="power-wall-loading-spinner"></div>
          <span>${t('加载中...', 'Loading...')}</span>
        </div>
      `;
      this.wallContainer = this.container.querySelector('.power-wall-masonry');
      this.loadingIndicator = this.container.querySelector('.power-wall-loading');
      if (pluginMount) targetContainer.appendChild(this.container);
      else targetContainer.insertBefore(this.container, targetContainer.firstChild);
      this.regionElement = targetContainer;
      targetContainer.classList.add('power-wall-region');

      const slider = this.container.querySelector('#pw-zoom-slider');
      if (slider) {
        slider.addEventListener('input', () => {
          const v = parseInt(slider.value, 10);
          saveConfig({ zoomIndex: v });
          this.brickWall?.relayout();
        });
      }
      this.container.querySelector('.power-wall-toolbar').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'settings') this.openSettingsPanel();
        else if (action === 'filter') this.openFilterPanel();
        else if (action === 'refresh') this.refresh();
        else if (action === 'random') this.loadRandom();
        else if (action === 'original') this.disable();
      });
    }

    async loadMore() {
      if (!this.isEnabled || !this.scroller || !this.scroller.hasMore || !this.wallContainer) return;
      this.showLoading(true);
      try {
        const data = await this.fetchData();
        if (!this.isEnabled || !this.wallContainer) return;
        if (data?.items?.length > 0) {
          this.totalCount = data.count;
          this.updateCount();
          await this.addItemsBatch(data.items);
          if (!this.isEnabled || !this.wallContainer || !this.scroller) return;
          this.page++;
          this.scroller.hasMore = this.items.length < this.totalCount;
        } else {
          if (this.scroller) this.scroller.hasMore = false;
        }
        if (this.scroller && !this.scroller.hasMore) this.showEndMessage();
      } catch (err) {
        error(t('加载失败', 'Load failed') + ':', err);
        this.showError();
      } finally {
        this.showLoading(false);
        if (!this.container?.classList.contains('power-wall-ready')) {
          requestAnimationFrame(() => {
            this.container?.classList.add('power-wall-ready');
          });
        }
      }
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
              visual_files { ... on ImageFile { width height } }
              tags { id name } galleries { id title }
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
              files { width height duration }
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

    async addItemsBatch(itemsData) {
      const cfg = getConfig();
      this.brickWall.margin = cfg.margin;
      this.brickWall.rowGap = cfg.rowGap;
      this.brickWall.columnGap = cfg.columnGap;
      const dimPromises = itemsData.map((d) => this.getImageDimensions(this.getItemThumbnail(d), d));
      const dims = await Promise.all(dimPromises);
      const fragment = document.createDocumentFragment();
      const prepared = [];
      const useLightbox = cfg.enableLightbox !== false;
      for (let i = 0; i < itemsData.length; i++) {
        const data = itemsData[i];
        const item = this.createItemElement(data, useLightbox);
        if (!item) continue;
        const d = dims[i];
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
      prepared.forEach(({ element, data }) => {
        try {
          element.dispatchEvent(new CustomEvent('enhancedWallItemAdded', { detail: { item: element, data, type: this.pageType }, bubbles: true }));
        } catch (_) {}
      });
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
      item.innerHTML = `
        <a href="${link}" class="power-wall-link" data-id="${data.id}" data-type="${this.pageType}" ${useLightbox ? 'data-lightbox="1"' : ''}>
          <div class="power-wall-media">
            <img src="${thumbnail}" alt="${this.escapeHtml(title)}" loading="lazy">
            ${preview ? `<video src="${preview}" muted loop playsinline preload="none"></video>` : ''}
            ${this.pageType === 'scenes' ? '<div class="power-wall-play-indicator"><span class="play-icon"></span></div>' : ''}
          </div>
          ${specs ? `<div class="power-wall-specs">${specs}</div>` : ''}
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
      if (data.rating100) parts.push(`<span class="meta-rating">⭐ ${Math.round(data.rating100 / 20)}</span>`);
      if (data.o_counter) parts.push(`<span class="meta-views">👁 ${data.o_counter}</span>`);
      if (data.performers?.length) parts.push(`<span class="meta-performers">👤 ${data.performers.slice(0, 2).map(p => p.name).join(', ')}</span>`);
      if (data.studio?.name) parts.push(`<span class="meta-studio">🏢 ${data.studio.name}</span>`);
      return parts.join('');
    }
    getItemSpecs(data) {
      const specs = [];
      let width, height;
      if (data.files?.[0]) { width = data.files[0].width; height = data.files[0].height; }
      else if (data.visual_files?.[0]) { width = data.visual_files[0].width; height = data.visual_files[0].height; }
      if (height) {
        const res = formatResolution(width, height);
        let resClass = height >= 2160 ? 'resolution-4k' : height >= 1080 ? 'resolution-hd' : '';
        specs.push(`<span class="power-wall-spec ${resClass}">${res}</span>`);
      }
      if (data.files?.[0]?.duration) specs.push(`<span class="power-wall-spec duration">${formatDuration(data.files[0].duration)}</span>`);
      return specs.join('');
    }
    getImageDimensions(src, data) {
      let width, height;
      if (data.files?.[0]) { width = data.files[0].width; height = data.files[0].height; }
      else if (data.visual_files?.[0]) { width = data.visual_files[0].width; height = data.visual_files[0].height; }
      if (width && height) return Promise.resolve({ width, height });
      return Promise.resolve({ width: 16, height: 9 });
    }
    updateCount() {
      const el = this.container?.querySelector('.power-wall-count');
      if (el) el.textContent = t('已加载', 'Loaded') + ' ' + formatCountShort(this.items.length) + ' / ' + formatCountShort(this.totalCount) + ' ' + t('项', 'items');
    }
    showLoading(show) {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = show ? 'flex' : 'none';
        this.loadingIndicator.innerHTML = '<div class="power-wall-loading-spinner"></div><span>' + t('加载中...', 'Loading...') + '</span>';
      }
    }
    showEndMessage() {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = 'flex';
        this.loadingIndicator.innerHTML = '<span class="power-wall-end">✨ ' + t('已加载全部', 'All loaded') + '</span>';
      }
    }
    showError() {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = 'flex';
        this.loadingIndicator.innerHTML = '<span class="power-wall-error">❌ ' + t('加载失败，请刷新', 'Load failed, please refresh') + '</span>';
      }
    }
    async refresh() {
      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();
      this.items.forEach(item => item.element?.remove());
      this.items = [];
      this.page = 1;
      if (this.brickWall) this.brickWall.clear();
      if (this.scroller) this.scroller.reset();
      await this.loadMore();
    }
    loadRandom() {
      const url = new URL(window.location.href);
      url.searchParams.set('sortby', 'random_' + Date.now());
      url.searchParams.delete('page');
      window.history.pushState({}, '', url.href);
      this.refresh();
    }

    async fetchFilterOptions() {
      const [tagsRes, performersRes, studiosRes, foldersRes] = await Promise.all([
        graphqlRequest('query { findTags(filter: { per_page: 80 }) { tags { id name } } }'),
        graphqlRequest('query { findPerformers(filter: { per_page: 80 }) { performers { id name } } }'),
        graphqlRequest('query { findStudios(filter: { per_page: 80 }) { studios { id name } } }'),
        graphqlRequest('query { findFolders(filter: { per_page: 300 }) { folders { id path } } }'),
      ]);
      const folders = (foldersRes?.findFolders?.folders || []).map(f => (f.path || '').trim()).filter(Boolean).sort();
      return {
        tags: tagsRes?.findTags?.tags || [],
        performers: performersRes?.findPerformers?.performers || [],
        studios: studiosRes?.findStudios?.studios || [],
        folders: [...new Set(folders)],
      };
    }

    async openFilterPanel() {
      const params = new URLSearchParams(window.location.search);
      const currentQ = params.get('q') || '';
      const currentPath = params.get('path') || params.get('path_filter') || '';
      const currentTags = params.get('tags') || params.get('tag_ids') || '';
      const currentPerformers = params.get('performers') || params.get('performer_ids') || '';
      const currentStudios = params.get('studios') || params.get('studio_ids') || '';
      const sortbyParam = params.get('sortby') || 'created_at';
      const currentSort = sortbyParam.startsWith('random_') ? 'random' : sortbyParam;
      const currentSortDir = (params.get('sortdir') || 'DESC').toUpperCase();
      let modal = document.getElementById('power-wall-filter-modal');
      if (modal) {
        modal.querySelector('#pw-filter-q').value = currentQ;
        const pathEl = modal.querySelector('#pw-filter-path');
        if (pathEl) pathEl.value = currentPath || '';
        modal.querySelector('#pw-filter-sortby').value = currentSort;
        modal.querySelector('#pw-filter-sortdir').value = currentSortDir === 'ASC' ? 'ASC' : 'DESC';
        this.populateFilterCheckboxes(modal, currentTags, currentPerformers, currentStudios);
        modal.style.display = 'flex';
        return;
      }
      modal = document.createElement('div');
      modal.id = 'power-wall-filter-modal';
      modal.className = 'power-wall-settings-modal power-wall-filter-modal';
      const sortOpts = [['created_at', t('创建时间', 'Created')], ['date', t('日期', 'Date')], ['title', t('标题', 'Title')], ['rating100', t('评分', 'Rating')], ['updated_at', t('更新时间', 'Updated')], ['random', t('随机', 'Random')]];
      modal.innerHTML = `
        <div class="power-wall-settings-overlay"></div>
        <div class="power-wall-settings-panel power-wall-filter-panel">
          <div class="power-wall-settings-header">
            <h3>🔍 ${t('筛选', 'Filter')}</h3>
            <button type="button" class="power-wall-settings-close" data-action="close">&times;</button>
          </div>
          <div class="power-wall-settings-body">
            <div class="power-wall-settings-section">
              <h4>${t('关键词', 'Keywords')}</h4>
              <input type="text" class="power-wall-filter-input" id="pw-filter-q" placeholder="${t('搜索', 'Search')}" value="${currentQ.replace(/"/g, '&quot;')}">
            </div>
            <div class="power-wall-settings-section">
              <h4>${t('路径', 'Path')}</h4>
              <select id="pw-filter-path" class="power-wall-filter-select">
                <option value="">${t('不限', 'Any')}</option>
              </select>
            </div>
            <div class="power-wall-settings-section">
              <h4>${t('排序', 'Sort')}</h4>
              <div class="power-wall-filter-row">
                <select id="pw-filter-sortby" class="power-wall-filter-select">${sortOpts.map(([v, l]) => `<option value="${v}" ${currentSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <select id="pw-filter-sortdir" class="power-wall-filter-select">
                  <option value="DESC" ${currentSortDir === 'DESC' ? 'selected' : ''}>${t('降序', 'Desc')}</option>
                  <option value="ASC" ${currentSortDir === 'ASC' ? 'selected' : ''}>${t('升序', 'Asc')}</option>
                </select>
              </div>
            </div>
            <div class="power-wall-settings-section"><h4>${t('标签', 'Tags')}</h4><div class="power-wall-filter-list" id="pw-filter-tags">${t('加载中...', 'Loading...')}</div></div>
            <div class="power-wall-settings-section"><h4>${t('演员', 'Performers')}</h4><div class="power-wall-filter-list" id="pw-filter-performers">${t('加载中...', 'Loading...')}</div></div>
            <div class="power-wall-settings-section"><h4>${t('工作室', 'Studios')}</h4><div class="power-wall-filter-list" id="pw-filter-studios">${t('加载中...', 'Loading...')}</div></div>
          </div>
          <div class="power-wall-settings-footer">
            <button type="button" class="power-wall-settings-btn" data-action="clearFilter">${t('清除', 'Clear')}</button>
            <button type="button" class="power-wall-settings-btn primary" data-action="applyFilter">${t('应用', 'Apply')}</button>
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
          : '<span class="power-wall-filter-empty">' + t('无', 'None') + '</span>';
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
        const pathSelect = modal.querySelector('#pw-filter-path');
        opts.folders?.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          if (p === currentPath) opt.selected = true;
          pathSelect.appendChild(opt);
        });
      } catch (e) {
        const tagsEl = modal.querySelector('#pw-filter-tags');
        if (tagsEl) tagsEl.textContent = t('加载失败', 'Load failed');
      }
      const getSelectedIds = (id) => [...(modal.querySelector('#' + id)?.querySelectorAll('input:checked') || [])].map(cb => cb.value).filter(Boolean);
      const applyFilter = () => {
        const q = modal.querySelector('#pw-filter-q')?.value?.trim() || '';
        const pathVal = modal.querySelector('#pw-filter-path')?.value?.trim() || '';
        let sortby = modal.querySelector('#pw-filter-sortby')?.value || 'created_at';
        const sortdir = modal.querySelector('#pw-filter-sortdir')?.value || 'DESC';
        if (sortby === 'random') sortby = 'random_' + Date.now();
        const tags = getSelectedIds('pw-filter-tags');
        const performers = getSelectedIds('pw-filter-performers');
        const studios = getSelectedIds('pw-filter-studios');
        const url = new URL(window.location.href);
        if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
        if (pathVal) url.searchParams.set('path', pathVal); else url.searchParams.delete('path');
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
        window.history.pushState({}, '', window.location.origin + window.location.pathname);
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
            <h3>${t('砌墙设置', 'PowerWall Settings')}</h3>
            <button type="button" class="power-wall-settings-close" data-action="close">&times;</button>
          </div>
          <div class="power-wall-settings-body">
            <div class="power-wall-settings-section">
              <h4>${t('布局预设', 'Layout preset')}</h4>
              <select id="pw-setting-layoutPreset" class="power-wall-settings-select">
                ${Object.entries(LAYOUT_PRESETS).map(([key, p]) => `<option value="${key}" ${cfg.layoutPreset === key ? 'selected' : ''}>${getPresetLabel(p)}</option>`).join('')}
              </select>
            </div>
            <div class="power-wall-settings-section">
              <h4>${t('功能', 'Features')}</h4>
              <div class="power-wall-settings-row power-wall-settings-checkbox">
                <label><input type="checkbox" id="pw-setting-enableOnImages" ${cfg.enableOnImages ? 'checked' : ''}> ${t('图片列表启用', 'Enable on Images')}</label>
              </div>
              <div class="power-wall-settings-row power-wall-settings-checkbox">
                <label><input type="checkbox" id="pw-setting-enableOnScenes" ${cfg.enableOnScenes ? 'checked' : ''}> ${t('短片列表启用', 'Enable on Scenes')}</label>
              </div>
              <div class="power-wall-settings-row power-wall-settings-checkbox">
                <label><input type="checkbox" id="pw-setting-enableLightbox" ${cfg.enableLightbox !== false ? 'checked' : ''}> ${t('点击图片用内置 lightbox', 'Use built-in lightbox for images')}</label>
              </div>
            </div>
            <details class="power-wall-settings-advanced">
              <summary>${t('高级', 'Advanced')}</summary>
              <div class="power-wall-settings-row">
                <label>${t('每页数量', 'Items per page')}</label>
                <input type="number" id="pw-setting-itemsPerPage" min="12" max="120" value="${cfg.itemsPerPage}">
              </div>
              <div class="power-wall-settings-row power-wall-settings-checkbox">
                <label><input type="checkbox" id="pw-setting-debug" ${cfg.debug ? 'checked' : ''}> ${t('调试', 'Debug')}</label>
              </div>
            </details>
          </div>
          <div class="power-wall-settings-footer">
            <button type="button" class="power-wall-settings-btn" data-action="reset">${t('恢复默认', 'Reset to default')}</button>
            <button type="button" class="power-wall-settings-btn primary" data-action="save">${t('保存并应用', 'Save & apply')}</button>
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
  let powerWall = null;
  function init() {
    const pageType = getPageType();
    if (!pageType) return;
    if (powerWall) powerWall.disable();
    powerWall = new PowerWall();
    powerWall.init();
  }
  function mountPowerWall(container) {
    if (!container || powerWall) return;
    powerWall = new PowerWall();
    powerWall.enable(container);
  }
  function unmountPowerWall() {
    if (powerWall) { powerWall.disable(); powerWall = null; }
    document.body.classList.remove('power-wall-active');
    document.body.classList.remove('power-wall-lightbox-open');
    document.body.style.paddingRight = '';
    document.documentElement.style.paddingRight = '';
    document.documentElement.classList.remove('power-wall-preload');
    document.getElementById('power-wall-back-to-top')?.remove();
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
      unmountPowerWall();
      if (!isExcludedPath(path) && isListPath(path)) setTimeout(init, 300);
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
      unmountPowerWall();
      initTimeout = setTimeout(() => { initTimeout = null; init(); }, 300);
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
  log(t('PowerWall 砌墙视图插件已加载', 'PowerWall brick wall plugin loaded'));
})();
