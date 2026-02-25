/**
 * Stash 瀑布流增强预览墙插件
 * Enhanced Wall View Plugin for Stash
 *
 * 功能：瀑布流布局、无限滚动、图片内置 lightbox、视频悬停预览、智能规格标签
 * 作用范围：仅 /images 与 /scenes 列表页，不修改 tags/galleries 等其它页面
 *
 * API 使用：PluginApi.Event 监听 stash:location 路由（参考 Stash UI Plugin API）
 * 文档：https://docs.stashapp.cc/in-app-manual/plugins/uipluginapi/
 */

(function() {
  'use strict';

  /**
   * 与 Stash 前端一致的终端类型检测：小屏或触屏时不运行本插件，保留原生墙/网格体验
   * - 视口宽度：max-width: 576px 视为移动端
   * - 触屏：(pointer: coarse)
   */
  const isMobileViewport = () => window.matchMedia('only screen and (max-width: 576px)').matches;
  const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;
  const shouldDisableOnDevice = () => isMobileViewport() || isTouchDevice();
  if (shouldDisableOnDevice()) return;

  /**
   * 严格路径匹配：仅 /images 或 /scenes 根列表页
   * 明确排除：/tags、/galleries、/performers、/studios、/movies、/markers 及所有详情页
   * 防止在标签、图库、演员等页面误激活
   */
  const isListPath = (path) => {
    const p = (path || window.location.pathname).replace(/\/$/, '') || '/';
    if (p !== '/images' && p !== '/scenes') return false;
    return true;
  };

  /** 是否为应完全排除的路径（tags/图库/演员等） */
  const isExcludedPath = (path) => {
    const p = path || window.location.pathname;
    return /^\/(tags|galleries|performers|studios|movies|markers)(\/|$)/.test(p);
  };

  // ==================== 抢先隐藏原始内容（脚本解析时立即执行）====================
  (function hideOriginalImmediately() {
    if (isListPath() && !isExcludedPath() && document.documentElement) {
      document.documentElement.classList.add('enhanced-wall-preload');
    }
  })();

  // ==================== 配置 ====================
  const STORAGE_KEY = 'EnhancedWallView_config';
  /* 瀑布流外边距固定最小不变；调整布局时只增加图片与图片之间的行距/列距以适应瀑布流 */
  const LAYOUT_PRESETS = {
    compact: { columnWidth: 200, columnGap: 4, rowGap: 4, label: '紧凑', desc: '小卡片，最小行距列距' },
  };
  const DEFAULT_CONFIG = {
    layoutPreset: 'compact',
    columnWidth: 200,
    columnGap: 4,
    rowGap: 4,
    itemsPerPage: 40,
    loadThreshold: 600,
    videoPreviewDelay: 300,
    enableLightbox: true,
    enableOnImages: true,
    enableOnScenes: true,
    debug: false,
  };

  /** 根据 preset 或当前配置返回实际使用的布局参数（行距与列距统一为同一数值，保证视觉一致） */
  function getLayoutParams() {
    const cfg = getConfig();
    const preset = LAYOUT_PRESETS[cfg.layoutPreset];
    let columnWidth, columnGap, rowGap;
    if (preset) {
      columnWidth = preset.columnWidth;
      columnGap = preset.columnGap;
      rowGap = preset.rowGap;
    } else {
      columnWidth = cfg.columnWidth;
      columnGap = cfg.columnGap;
      rowGap = cfg.rowGap;
    }
    const gap = Math.round((columnGap + rowGap) / 2);
    return { columnWidth, columnGap: gap, rowGap: gap };
  }

  let _configCache = null;

  /**
   * 获取当前配置（合并 localStorage 中的用户设置，带缓存避免重复解析）
   */
  function getConfig() {
    if (_configCache) return _configCache;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      _configCache = { ...DEFAULT_CONFIG, ...parsed };
      return _configCache;
    } catch (e) {
      _configCache = { ...DEFAULT_CONFIG };
      return _configCache;
    }
  }

  /**
   * 保存配置到 localStorage
   */
  function saveConfig(updates) {
    const current = getConfig();
    const merged = { ...current, ...updates };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    _configCache = merged;
    return merged;
  }

  /**
   * 重置为默认配置
   */
  function resetConfig() {
    localStorage.removeItem(STORAGE_KEY);
    _configCache = { ...DEFAULT_CONFIG };
    return _configCache;
  }

  // GraphQL 端点
  const GRAPHQL_ENDPOINT = '/graphql';

  // 日志函数
  function log(...args) {
    if (getConfig().debug) {
      console.log('🎨 [EnhancedWallView]', ...args);
    }
  }

  function error(...args) {
    console.error('🎨 [EnhancedWallView]', ...args);
  }

  /**
   * 内置 Lightbox 查看器（因无法可靠调用 Stash 原生 lightbox，使用自建实现）
   * 支持：全屏浏览、左右切换、缩放、关闭
   */
  function openBuiltinLightbox(ids, index, type, itemData) {
    if (!ids?.length || index < 0 || type !== 'images') return;
    const getImageUrl = (id) => `/image/${id}/image`;

    let overlay = document.getElementById('enhanced-wall-lightbox-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'enhanced-wall-lightbox-overlay';
      overlay.className = 'enhanced-wall-lightbox';
      overlay.innerHTML = `
        <div class="enhanced-wall-lightbox-backdrop"></div>
        <div class="enhanced-wall-lightbox-header">
          <span class="enhanced-wall-lightbox-counter"></span>
          <button type="button" class="enhanced-wall-lightbox-close" title="关闭 (Esc)">&times;</button>
        </div>
        <button type="button" class="enhanced-wall-lightbox-prev" title="上一张 (←)">&#9664;</button>
        <div class="enhanced-wall-lightbox-content">
          <img class="enhanced-wall-lightbox-img" alt="" draggable="false">
        </div>
        <button type="button" class="enhanced-wall-lightbox-next" title="下一张 (→)">&#9654;</button>
        <div class="enhanced-wall-lightbox-footer">
          <a class="enhanced-wall-lightbox-detail" href="#" target="_blank">查看详情</a>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay._lbState = { scale: 1, translateX: 0, translateY: 0, lastX: 0, lastY: 0, isDragging: false };
      overlay._lbRaf = null;

      const imgEl = overlay.querySelector('.enhanced-wall-lightbox-img');
      const content = overlay.querySelector('.enhanced-wall-lightbox-content');
      const applyTransform = () => {
        overlay._lbRaf = null;
        const s = overlay._lbState;
        imgEl.style.transform = `translate(${s.translateX}px, ${s.translateY}px) scale(${s.scale})`;
      };
      const scheduleApply = () => {
        if (!overlay._lbRaf) overlay._lbRaf = requestAnimationFrame(applyTransform);
      };

      overlay.querySelector('.enhanced-wall-lightbox-backdrop').addEventListener('click', () => overlay.dispatchEvent(new CustomEvent('lightbox:close')));
      overlay.querySelector('.enhanced-wall-lightbox-close').addEventListener('click', () => overlay.dispatchEvent(new CustomEvent('lightbox:close')));
      overlay.querySelector('.enhanced-wall-lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:prev')); });
      overlay.querySelector('.enhanced-wall-lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); overlay.dispatchEvent(new CustomEvent('lightbox:next')); });

      content.addEventListener('wheel', (e) => {
        e.preventDefault();
        const s = overlay._lbState;
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : (e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY);
        const factor = 1 - delta * 0.002;
        const newScale = Math.max(0.2, Math.min(10, s.scale * factor));
        if (newScale === s.scale) return;
        const rect = content.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const mx = e.clientX - cx;
        const my = e.clientY - cy;
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

    let currentIndex = index;
    const total = ids.length;
    const updateContent = () => {
      const id = ids[currentIndex];
      const img = overlay.querySelector('.enhanced-wall-lightbox-img');
      const counter = overlay.querySelector('.enhanced-wall-lightbox-counter');
      const detailLink = overlay.querySelector('.enhanced-wall-lightbox-detail');
      const s = overlay._lbState || {};
      s.scale = 1; s.translateX = 0; s.translateY = 0;
      img.src = getImageUrl(id);
      img.style.transform = 'translate(0,0) scale(1)';
      counter.textContent = `${currentIndex + 1} / ${total}`;
      detailLink.href = `/${type}/${id}`;
    };
    const keyHandler = (e) => {
      if (!overlay.classList.contains('enhanced-wall-lightbox-visible')) {
        document.removeEventListener('keydown', keyHandler, true);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        overlay.dispatchEvent(new CustomEvent('lightbox:close'));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        overlay.dispatchEvent(new CustomEvent('lightbox:prev'));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        overlay.dispatchEvent(new CustomEvent('lightbox:next'));
      }
    };
    overlay.addEventListener('lightbox:close', () => {
      overlay.classList.remove('enhanced-wall-lightbox-visible');
      document.body.style.overflow = '';
      document.removeEventListener('keydown', keyHandler, true);
      if (overlay._lbMouseMove) document.removeEventListener('mousemove', overlay._lbMouseMove);
      if (overlay._lbMouseUp) document.removeEventListener('mouseup', overlay._lbMouseUp);
    });
    overlay.addEventListener('lightbox:prev', () => {
      if (currentIndex > 0) { currentIndex--; updateContent(); }
    });
    overlay.addEventListener('lightbox:next', () => {
      if (currentIndex < total - 1) { currentIndex++; updateContent(); }
    });

    document.addEventListener('keydown', keyHandler, true);

    updateContent();
    document.addEventListener('mousemove', overlay._lbMouseMove);
    document.addEventListener('mouseup', overlay._lbMouseUp);
    overlay.classList.add('enhanced-wall-lightbox-visible');
    document.body.style.overflow = 'hidden';
  }

  // ==================== 工具函数 ====================

  const GRAPHQL_TIMEOUT_MS = 30000;

  /**
   * 发送 GraphQL 请求（支持 AbortSignal 与超时，便于在 disable/refresh 时取消）
   */
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
        if (getConfig().debug) {
          console.error('完整错误:', result.errors);
          console.error('查询:', query);
          console.error('变量:', variables);
        }
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

  /**
   * 获取当前页面类型（与 isListPath 严格一致，确保不误匹配 tags/图库/演员等）
   */
  function getPageType() {
    const path = window.location.pathname;
    log('当前路径:', path);
    
    if (isExcludedPath(path)) {
      log('排除路径 (tags/图库/演员等)，跳过');
      return null;
    }
    if (!isListPath(path)) {
      log('非图片/短片列表页，跳过');
      return null;
    }
    
    const cfg = getConfig();
    const p = path.replace(/\/$/, '') || '/';
    if (p === '/images' && cfg.enableOnImages) return 'images';
    if (p === '/scenes' && cfg.enableOnScenes) return 'scenes';
    return null;
  }

  /**
   * 解析 comma-separated IDs 为数字数组
   */
  function parseIdList(val) {
    if (!val || typeof val !== 'string') return [];
    return val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  }

  /**
   * 解析 URL 参数获取过滤条件
   * 支持 Stash 原生筛选条同步到 URL 的常见参数：tags, performers, studios, galleries, q, sortby, sortdir
   * sortby=random_<seed> 为原生随机模式，支持无限滚动；GraphQL 要求 direction 为大写枚举 ASC / DESC
   */
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
      const tagIdStrs = tagIds.map(String);
      imageFilter.tags = { value: tagIdStrs, modifier: 'INCLUDES' };
      sceneFilter.tags = { value: tagIdStrs, modifier: 'INCLUDES' };
    }
    if (performerIds.length) {
      const performerIdStrs = performerIds.map(String);
      imageFilter.performers = { value: performerIdStrs, modifier: 'INCLUDES' };
      sceneFilter.performers = { value: performerIdStrs, modifier: 'INCLUDES' };
    }
    if (studioIds.length) {
      const studioIdStrs = studioIds.map(String);
      imageFilter.studios = { value: studioIdStrs, modifier: 'INCLUDES' };
      sceneFilter.studios = { value: studioIdStrs, modifier: 'INCLUDES' };
    }
    if (galleryIds.length) {
      imageFilter.galleries = { value: galleryIds.map(String), modifier: 'INCLUDES' };
    }

    return { findFilter, imageFilter, sceneFilter };
  }

  /**
   * 格式化时长
   */
  function formatDuration(seconds) {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * 格式化分辨率
   */
  function formatResolution(width, height) {
    if (!height) return '';
    if (height >= 2160) return '4K';
    if (height >= 1440) return '2K';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    return `${height}p`;
  }

  /**
   * 防抖函数
   */
  function debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // ==================== 瀑布流布局引擎 ====================
  class MasonryLayout {
    constructor(container, options = {}) {
      this.container = container;
      this.columnWidth = options.columnWidth || 280;
      this.columnGap = options.columnGap || 12;
      this.rowGap = options.rowGap || 12;
      this.columnHeights = [];
      this.columnCount = 0;
      this.items = [];
    }

    /**
     * 计算列数（使用父容器或视口宽度，确保自适应窗口）
     */
    calculateColumns() {
      const parent = this.container.parentElement;
      const containerWidth = (parent && parent.clientWidth > 0)
        ? parent.clientWidth
        : (this.container.clientWidth || window.innerWidth || document.documentElement.clientWidth);
      if (containerWidth <= 0) {
        log('容器宽度为0，使用窗口宽度');
        return;
      }

      this.columnCount = Math.max(1, Math.floor((containerWidth + this.columnGap) / (this.columnWidth + this.columnGap)));
      this.columnHeights = new Array(this.columnCount).fill(0);

      // 更新容器宽度以居中
      const totalWidth = this.columnCount * this.columnWidth + (this.columnCount - 1) * this.columnGap;
      this.container.style.width = `${totalWidth}px`;
      this.container.style.margin = '0 auto';

      log(`计算列数: ${this.columnCount}, 容器宽度: ${containerWidth}px, 瀑布流宽度: ${totalWidth}px`);
    }

    /**
     * 获取最短列的索引
     */
    getShortestColumn() {
      let minIdx = 0;
      let min = this.columnHeights[0];
      for (let i = 1; i < this.columnHeights.length; i++) {
        if (this.columnHeights[i] < min) {
          min = this.columnHeights[i];
          minIdx = i;
        }
      }
      return minIdx;
    }

    /**
     * 添加项目到布局（单次更新高度以降低 reflow）
     */
    addItem(element, itemHeight) {
      const columnIndex = this.getShortestColumn();
      const left = columnIndex * (this.columnWidth + this.columnGap);
      const top = this.columnHeights[columnIndex];

      element.style.position = 'absolute';
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.style.width = `${this.columnWidth}px`;
      element.style.height = `${itemHeight}px`;

      this.columnHeights[columnIndex] += itemHeight + this.rowGap;
      this.items.push({ element, height: itemHeight, columnIndex });
    }

    /**
     * 批量添加项目后统一更新容器高度（减少 reflow）
     */
    flushHeight() {
      let maxH = 0;
      for (let i = 0; i < this.columnHeights.length; i++) {
        if (this.columnHeights[i] > maxH) maxH = this.columnHeights[i];
      }
      this.container.style.height = `${maxH}px`;
    }

    /**
     * 重新布局所有项目（dislike 项去色显示，不参与隐藏，无需特殊布局逻辑）
     */
    relayout() {
      this.calculateColumns();
      this.columnHeights = new Array(this.columnCount).fill(0);

      for (const item of this.items) {
        const columnIndex = this.getShortestColumn();
        const left = columnIndex * (this.columnWidth + this.columnGap);
        const top = this.columnHeights[columnIndex];

        item.element.style.left = `${left}px`;
        item.element.style.top = `${top}px`;
        item.element.style.width = `${this.columnWidth}px`;
        item.element.style.height = `${item.height}px`;

        item.columnIndex = columnIndex;
        this.columnHeights[columnIndex] += item.height + this.rowGap;
      }

      let maxH = 0;
      for (let i = 0; i < this.columnHeights.length; i++) {
        if (this.columnHeights[i] > maxH) maxH = this.columnHeights[i];
      }
      this.container.style.height = `${maxH}px`;
    }

    /**
     * 清空布局
     */
    clear() {
      this.items = [];
      this.columnHeights = new Array(this.columnCount).fill(0);
      this.container.style.height = '0px';
    }
  }

  // ==================== 无限滚动管理器（IntersectionObserver 实现，性能优于 scroll 事件）====================
  class InfiniteScroller {
    constructor(options = {}) {
      this.threshold = options.threshold || 600;
      this.onLoadMore = options.onLoadMore || (() => {});
      this.isLoading = false;
      this.hasMore = true;
      this.sentinel = null;
      this.observer = null;
    }

    /**
     * 启动（使用 IntersectionObserver 替代 scroll 事件，无主线程轮询）
     */
    start(container) {
      if (!container || this.observer) return;

      this.sentinel = document.createElement('div');
      this.sentinel.className = 'enhanced-wall-sentinel';
      this.sentinel.style.cssText = 'position:absolute;left:0;bottom:0;width:1px;height:1px;pointer-events:none';
      container.appendChild(this.sentinel);

      this.observer = new IntersectionObserver(
        (entries) => {
          if (this.isLoading || !this.hasMore) return;
          const e = entries[0];
          if (e && e.isIntersecting) {
            log('触发加载更多');
            this.loadMore();
          }
        },
        { rootMargin: `${this.threshold}px 0px`, threshold: 0 }
      );
      this.observer.observe(this.sentinel);
      log('无限滚动（IntersectionObserver）已启动');
    }

    /**
     * 更新哨兵位置以触发后续加载检测
     */
    updateSentinel() {
      if (this.sentinel && this.sentinel.parentElement) {
        this.observer?.unobserve(this.sentinel);
        this.observer?.observe(this.sentinel);
      }
    }

    /**
     * 停止
     */
    stop() {
      if (this.observer && this.sentinel) {
        this.observer.unobserve(this.sentinel);
        this.observer = null;
      }
      if (this.sentinel?.parentElement) {
        this.sentinel.remove();
      }
      this.sentinel = null;
      log('无限滚动已停止');
    }

    /**
     * 触发加载更多
     */
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

    /**
     * 重置状态
     */
    reset() {
      this.isLoading = false;
      this.hasMore = true;
    }
  }

  // ==================== 视频预览管理器（事件委托，无需逐个绑定）====================
  class VideoPreviewManager {
    constructor(options = {}) {
      this.delay = options.delay || 300;
      this.hoverTimer = null;
      this.hoverTarget = null;
      this.boundHandler = null;
    }

    /**
     * 在容器上使用事件委托，无需对每个 item 单独 bind
     */
    attach(container) {
      if (!container || this.boundHandler) return;
      this.videoPreviewContainer = container;
      this.boundHandler = (e) => this.handleDelegatedEvent(e);
      container.addEventListener('mouseenter', this.boundHandler, true);
      container.addEventListener('mouseleave', this.boundHandler, true);
    }

    /**
     * 事件委托处理
     */
    handleDelegatedEvent(e) {
      const item = e.target.closest('.enhanced-wall-item');
      if (!item) return;
      const video = item.querySelector('video');
      if (!video) return;
      const img = item.querySelector('img');

      if (e.type === 'mouseenter') {
        this.onMouseEnter(item, video, img);
      } else {
        this.onMouseLeave(item, video, img);
      }
    }

    /**
     * 鼠标进入
     */
    onMouseEnter(element, video, img) {
      this.clearTimer();
      this.hoverTarget = element;

      this.hoverTimer = setTimeout(() => {
        if (video.preload === 'none') video.preload = 'auto';
        video.currentTime = 0;
        video.play().then(() => {
          video.classList.add('playing');
          if (img) img.classList.add('hidden');
        }).catch(() => {});
      }, this.delay);
    }

    /**
     * 鼠标离开
     */
    onMouseLeave(element, video, img) {
      this.clearTimer();
      this.hoverTarget = null;
      video.pause();
      video.classList.remove('playing');
      if (img) img.classList.remove('hidden');
    }

    /**
     * 清除定时器
     */
    clearTimer() {
      if (this.hoverTimer) {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
      }
    }

    /**
     * 销毁
     */
    destroy() {
      this.clearTimer();
      if (this.boundHandler && this.videoPreviewContainer) {
        this.videoPreviewContainer.removeEventListener('mouseenter', this.boundHandler, true);
        this.videoPreviewContainer.removeEventListener('mouseleave', this.boundHandler, true);
      }
      this.boundHandler = null;
      this.videoPreviewContainer = null;
    }
  }

  // ==================== 主类：增强墙视图 ====================
  class EnhancedWall {
    constructor() {
      this.container = null;
      this.masonryContainer = null;
      this.masonry = null;
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

    /**
     * 初始化 - 直接显示瀑布流，不等待原始内容
     */
    async init() {
      this.pageType = getPageType();
      log('页面类型:', this.pageType);
      
      if (!this.pageType) {
        document.documentElement.classList.remove('enhanced-wall-preload');
        return;
      }

      // 确保抢先隐藏类存在（SPA 导航时脚本不会重新加载）
      document.documentElement.classList.add('enhanced-wall-preload');
      // 立即添加激活类并创建容器
      document.body.classList.add('enhanced-wall-active');
      this.enable();
    }

    /**
     * 启用增强墙视图
     * @param {Element} [pluginMount] - 可选，供 patch 注入时的挂载点
     */
    async enable(pluginMount) {
      if (this.isEnabled) {
        log('已经启用，跳过');
        return;
      }
      this.isEnabled = true;
      this.abortController = new AbortController();

      log('🚀 启用瀑布流增强预览墙', pluginMount ? '(PluginApi 挂载)' : '');

      // 初始化组件
      const cfg = getConfig();
      this.videoPreview = new VideoPreviewManager({ delay: cfg.videoPreviewDelay });

      // 创建UI
      document.body.classList.add('enhanced-wall-active');
      if (pluginMount) pluginMount.classList.add('enhanced-wall-mount');
      this.createContainer(pluginMount);

      if (!this.masonryContainer) {
        error('创建容器失败');
        this.isEnabled = false;
        return;
      }

      // 初始化瀑布流布局（使用预设或自定义参数）
      const layout = getLayoutParams();
      this.masonry = new MasonryLayout(this.masonryContainer, {
        columnWidth: layout.columnWidth,
        columnGap: layout.columnGap,
        rowGap: layout.rowGap
      });
      this.masonry.calculateColumns();

      // 初始化无限滚动
      this.scroller = new InfiniteScroller({
        threshold: cfg.loadThreshold,
        onLoadMore: () => this.loadMore()
      });

      // 视频预览使用事件委托，一次绑定容器
      this.videoPreview.attach(this.masonryContainer);

      // Lightbox 点击委托：在内置 lightbox 中打开，而非跳转详情页
      this._boundItemClick = (e) => this.handleItemClick(e);
      this.masonryContainer.addEventListener('click', this._boundItemClick);
      
      // 加载第一批数据
      log('开始加载数据...');
      await this.loadMore();
      if (!this.isEnabled || !this.masonryContainer || !this.scroller) return;

      // 启动无限滚动（哨兵需放在瀑布流容器内）
      this.scroller.start(this.masonryContainer);
      
      // 监听窗口大小变化（rAF 批量 layout，降低卡顿）
      this.resizeHandler = debounce(() => {
        if (!this.isEnabled || !this.masonry) return;
        requestAnimationFrame(() => {
          if (this.isEnabled && this.masonry) {
            log('窗口大小变化，重新布局');
            this.masonry.relayout();
          }
        });
      }, 150);
      window.addEventListener('resize', this.resizeHandler);

      // ResizeObserver：容器尺寸变化时重新布局（侧栏折叠等场景）
      if (this.masonryContainer && typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.resizeHandler());
        this.resizeObserver.observe(this.masonryContainer.parentElement || this.masonryContainer);
      }
    }

    /**
     * 禁用增强墙视图
     */
    disable() {
      if (!this.isEnabled) return;
      this.isEnabled = false;
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }

      log('禁用瀑布流增强预览墙');

      document.body.classList.remove('enhanced-wall-active');
      document.documentElement.classList.remove('enhanced-wall-preload');

      // 清理组件
      if (this.scroller) {
        this.scroller.stop();
        this.scroller = null;
      }
      
      if (this.videoPreview) {
        this.videoPreview.destroy();
        this.videoPreview = null;
      }
      if (this.masonryContainer) {
        this.masonryContainer.removeEventListener('click', this._boundItemClick);
      }

      if (this.resizeHandler) {
        window.removeEventListener('resize', this.resizeHandler);
        this.resizeHandler = null;
      }
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }

      const mountEl = this.container?.closest?.('.enhanced-wall-mount');
      if (mountEl) mountEl.classList.remove('enhanced-wall-mount');
      if (this.regionElement) {
        this.regionElement.classList.remove('enhanced-wall-region');
        this.regionElement = null;
      }
      if (this.container) {
        this.container.remove();
        this.container = null;
        this.masonryContainer = null;
      }

      this.masonry = null;
      this.items = [];
      this.page = 1;
    }

    /**
     * 处理项目点击：启用 lightbox 时在内置 lightbox 中浏览，否则跳转详情页
     */
    handleItemClick(e) {
      const link = e.target.closest('a.enhanced-wall-link[data-lightbox="1"]');
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
        openBuiltinLightbox(ids, index, type, this.items[index]?.data);
      } else {
        window.location.href = `/${type}/${id}`;
      }
    }

    /**
     * 创建容器
     * @param {Element} [pluginMount] - 可选挂载点，无则使用主内容区
     */
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

      if (!targetContainer) {
        error('找不到容器');
        return;
      }

      log('目标容器:', targetContainer.className || targetContainer.tagName);

      this.container = document.createElement('div');
      this.container.className = 'enhanced-wall-container';

      // 工具栏
      const toolbar = document.createElement('div');
      toolbar.className = 'enhanced-wall-toolbar';
      const params = new URLSearchParams(window.location.search);
      toolbar.innerHTML = `
        <div class="enhanced-wall-toolbar-left">
          <input type="text" class="enhanced-wall-search" id="ew-toolbar-search" placeholder="关键词搜索" value="${(params.get('q') || '').replace(/"/g, '&quot;')}">
          <span class="enhanced-wall-count">加载中...</span>
        </div>
        <div class="enhanced-wall-toggle">
          <button class="enhanced-wall-toggle-btn" data-action="random" title="随机加载一批图片">🎲 随览</button>
          <button class="enhanced-wall-toggle-btn" data-action="filter" title="筛选">🔍 筛选</button>
          <button class="enhanced-wall-toggle-btn" data-action="settings" title="设置">⚙️ 设置</button>
          <button class="enhanced-wall-toggle-btn" data-action="refresh" title="刷新">🔄 刷新</button>
          <button class="enhanced-wall-toggle-btn" data-action="original" title="切换原始视图">📋 原始视图</button>
        </div>
      `;
      this.container.appendChild(toolbar);

      // 瀑布流容器
      this.masonryContainer = document.createElement('div');
      this.masonryContainer.className = 'enhanced-wall-masonry';
      this.container.appendChild(this.masonryContainer);

      // 加载指示器
      this.loadingIndicator = document.createElement('div');
      this.loadingIndicator.className = 'enhanced-wall-loading';
      this.loadingIndicator.innerHTML = '<div class="enhanced-wall-loading-spinner"></div><span>加载中...</span>';
      this.container.appendChild(this.loadingIndicator);

      if (pluginMount) {
        targetContainer.appendChild(this.container);
      } else {
        targetContainer.insertBefore(this.container, targetContainer.firstChild);
      }

      // 标记作用域，使 CSS 仅影响此区域
      // 标记作用域，使 CSS 仅影响此区域，避免影响 tags/图库等页面的原生墙视图
      this.regionElement = targetContainer;
      targetContainer.classList.add('enhanced-wall-region');

      // 绑定工具栏事件
      toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;

        const action = btn.dataset.action;
        if (action === 'settings') {
          this.openSettingsPanel();
        } else if (action === 'filter') {
          this.openFilterPanel();
        } else if (action === 'refresh') {
          this.refresh();
        } else if (action === 'random') {
          this.loadRandom();
        } else if (action === 'original') {
          this.disable();
        }
      });

      const searchInput = toolbar.querySelector('#ew-toolbar-search');
      if (searchInput) {
        const applySearch = () => {
          const q = searchInput.value.trim();
          const url = new URL(window.location.href);
          if (q) url.searchParams.set('q', q);
          else url.searchParams.delete('q');
          url.searchParams.delete('page');
          if (url.href !== window.location.href) {
            window.history.pushState({}, '', url.href);
            this.refresh();
          }
        };
        searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applySearch(); });
        searchInput.addEventListener('blur', () => applySearch());
      }

      log('容器创建完成');
    }

    /**
     * 加载更多数据
     */
    async loadMore() {
      if (!this.isEnabled || !this.scroller || !this.scroller.hasMore || !this.masonryContainer) return;

      this.showLoading(true);
      log('加载第 ' + this.page + ' 页数据...');

      try {
        const data = await this.fetchData();
        if (!this.isEnabled || !this.masonryContainer) return;

        if (data && data.items && data.items.length > 0) {
          this.totalCount = data.count;
          this.updateCount();
          log(`获取到 ${data.items.length} 条数据，总计 ${data.count} 条`);

          await this.addItemsBatch(data.items);
          if (!this.isEnabled || !this.masonryContainer || !this.scroller) return;

          this.page++;
          this.scroller.hasMore = this.items.length < this.totalCount;
        } else {
          log('没有更多数据');
          if (this.scroller) this.scroller.hasMore = false;
        }

        if (this.scroller && !this.scroller.hasMore) {
          this.showEndMessage();
        }
      } catch (err) {
        error('加载数据失败:', err);
        this.showError();
      } finally {
        this.showLoading(false);
      }
    }

    /**
     * 获取数据
     */
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

      switch (this.pageType) {
        case 'images':
          query = `
            query FindImages($filter: FindFilterType, $image_filter: ImageFilterType) {
              findImages(filter: $filter, image_filter: $image_filter) {
                count
                images {
                  id
                  title
                  rating100
                  o_counter
                  paths {
                    thumbnail
                    preview
                    image
                  }
                  visual_files {
                    ... on ImageFile {
                      width
                      height
                    }
                  }
                  tags { id name }
                  galleries { id title }
                }
              }
            }
          `;
          variables = {
            filter: baseFilter,
            image_filter: imageFilter
          };
          resultKey = 'findImages';
          break;

        case 'scenes':
          query = `
            query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
              findScenes(filter: $filter, scene_filter: $scene_filter) {
                count
                scenes {
                  id
                  title
                  details
                  rating100
                  o_counter
                  date
                  paths {
                    screenshot
                    preview
                    stream
                  }
                  files {
                    width
                    height
                    duration
                  }
                  tags { id name }
                  performers { id name }
                  studio { id name }
                }
              }
            }
          `;
          variables = {
            filter: baseFilter,
            scene_filter: sceneFilter
          };
          resultKey = 'findScenes';
          break;

        default:
          return null;
      }

      const signal = this.abortController?.signal;
      const result = await graphqlRequest(query, variables, signal ? { signal } : {});
      if (signal?.aborted) return null;

      // GraphQL 失败时，仅第一页尝试从 DOM 解析已加载的数据
      if (!result || !result[resultKey]) {
        if (this.page === 1) {
          log('GraphQL 请求失败，尝试从 DOM 解析数据...');
          const domData = this.parseDataFromDOM();
          if (domData && domData.items.length > 0) {
            return domData;
          }
        }
        return null;
      }

      const data = result[resultKey];
      return {
        count: data.count,
        items: data[this.pageType] || []
      };
    }

    /**
     * 从页面 DOM 解析已加载的数据（GraphQL 失败时的备用方案）
     */
    parseDataFromDOM() {
      const items = [];
      let count = 0;

      if (this.pageType === 'images') {
        const imgs = document.querySelectorAll('img[src*="/image/"]');
        const seen = new Set();
        imgs.forEach(img => {
          if (img.closest('.enhanced-wall-item')) return; // 排除我们自己的卡片
          const match = img.src.match(/\/image\/(\d+)/);
          if (!match || seen.has(match[1])) return;
          seen.add(match[1]);
          const previewSrc = img.src.includes('thumbnail') ? img.src.replace('thumbnail', 'preview') : img.src;
          const imageSrc = img.src.includes('thumbnail') ? img.src.replace('thumbnail', 'image') : img.src;
          items.push({
            id: match[1],
            title: img.alt || `Image ${match[1]}`,
            paths: {
              thumbnail: img.src,
              preview: previewSrc,
              image: imageSrc
            },
            rating100: null,
            o_counter: null,
            visual_files: []
          });
        });
        count = items.length;
      } else if (this.pageType === 'scenes') {
        const imgs = document.querySelectorAll('img[src*="/scene/"]');
        const seen = new Set();
        imgs.forEach(img => {
          if (img.closest('.enhanced-wall-item')) return;
          const match = img.src.match(/\/scene\/(\d+)/);
          if (!match || seen.has(match[1])) return;
          seen.add(match[1]);
          let previewSrc = img.src;
          if (img.src.includes('screenshot')) previewSrc = img.src.replace('screenshot', 'preview');
          else if (img.src.includes('thumbnail')) previewSrc = img.src.replace('thumbnail', 'preview');
          items.push({
            id: match[1],
            title: img.alt || `Scene ${match[1]}`,
            paths: {
              screenshot: img.src,
              preview: previewSrc,
              stream: null
            },
            rating100: null,
            o_counter: null,
            files: [{ width: 1920, height: 1080, duration: null }],
            tags: [],
            performers: [],
            studio: null
          });
        });
        count = items.length;
      }

      if (items.length > 0) {
        log(`从 DOM 解析到 ${items.length} 项数据`);
      }
      return { count, items };
    }

    /**
     * 批量添加项目（减少 reflow、并行处理、单次高度更新）
     */
    async addItemsBatch(itemsData) {
      const layout = getLayoutParams();
      const colWidth = layout.columnWidth;

      // 1. 并行获取所有尺寸
      const dimPromises = itemsData.map((d) => this.getImageDimensions(this.getItemThumbnail(d), d));
      const dims = await Promise.all(dimPromises);

      // 2. 创建元素并计算高度
      const prepared = [];
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < itemsData.length; i++) {
        const data = itemsData[i];
        const item = this.createItemElement(data);
        if (!item) continue;
        const { width, height } = dims[i];
        const aspectRatio = height / width;
        const itemHeight = colWidth * aspectRatio;
        prepared.push({ element: item, data, height: itemHeight });
        fragment.appendChild(item);
      }

      // 3. 一次性插入 DOM
      if (!this.masonryContainer) return;
      this.masonryContainer.appendChild(fragment);

      // 4. 布局计算（不触发 height 更新）
      for (const { element, data, height } of prepared) {
        this.masonry.addItem(element, height);
        this.items.push({ element, data, height });
      }

      // 5. 单次更新容器高度
      this.masonry.flushHeight();

      // 6. 通知 FavoriteHeart 等插件：新项已添加（支持红心收藏等）
      prepared.forEach(({ element, data }) => {
        try {
          element.dispatchEvent(new CustomEvent('enhancedWallItemAdded', { detail: { item: element, data, type: this.pageType }, bubbles: true }));
        } catch (_) {}
      });
    }

    /**
     * 创建项目元素
     */
    createItemElement(data) {
      const item = document.createElement('div');
      item.className = 'enhanced-wall-item';
      item.dataset.id = data.id;
      item.dataset.type = this.pageType;

      const thumbnail = this.getItemThumbnail(data);
      const preview = this.getItemPreview(data);
      const link = this.getItemLink(data);
      const title = this.getItemTitle(data);
      const meta = this.getItemMeta(data);
      const specs = this.getItemSpecs(data);

      const cfg = getConfig();
      const useLightbox = cfg.enableLightbox;
      item.innerHTML = `
        <a href="${link}" class="enhanced-wall-link" data-id="${data.id}" data-type="${this.pageType}" ${useLightbox ? 'data-lightbox="1"' : ''}>
          <div class="enhanced-wall-media">
            <img src="${thumbnail}" alt="${this.escapeHtml(title)}" loading="lazy">
            ${preview ? `<video src="${preview}" muted loop playsinline preload="none"></video>` : ''}
            ${this.pageType === 'scenes' ? '<div class="enhanced-wall-play-indicator"><span class="play-icon"></span></div>' : ''}
          </div>
          ${specs ? `<div class="enhanced-wall-specs">${specs}</div>` : ''}
          <div class="enhanced-wall-overlay">
            <div class="enhanced-wall-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
            <div class="enhanced-wall-meta">${meta}</div>
          </div>
        </a>
      `;

      return item;
    }

    /**
     * HTML 转义（高性能实现，避免 DOM 创建）
     */
    escapeHtml(text) {
      if (!text) return '';
      return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /**
     * 获取缩略图URL
     */
    getItemThumbnail(data) {
      switch (this.pageType) {
        case 'images':
          return data.paths?.thumbnail || data.paths?.image || '';
        case 'scenes':
          return data.paths?.screenshot || '';
        default:
          return '';
      }
    }

    /**
     * 获取预览URL
     */
    getItemPreview(data) {
      switch (this.pageType) {
        case 'images':
          return data.paths?.preview || null;
        case 'scenes':
          return data.paths?.preview || null;
        default:
          return null;
      }
    }

    /**
     * 获取链接
     */
    getItemLink(data) {
      const typeMap = {
        images: 'images',
        scenes: 'scenes',
        galleries: 'galleries'
      };
      return `/${typeMap[this.pageType]}/${data.id}`;
    }

    /**
     * 获取标题
     */
    getItemTitle(data) {
      return data.title || `#${data.id}`;
    }

    /**
     * 获取元数据HTML
     */
    getItemMeta(data) {
      const parts = [];

      if (data.rating100) {
        const stars = Math.round(data.rating100 / 20);
        parts.push(`<span class="meta-rating">⭐ ${stars}</span>`);
      }

      if (data.o_counter) {
        parts.push(`<span class="meta-views">👁 ${data.o_counter}</span>`);
      }

      if (data.performers?.length) {
        const names = data.performers.slice(0, 2).map(p => p.name).join(', ');
        const more = data.performers.length > 2 ? ` +${data.performers.length - 2}` : '';
        parts.push(`<span class="meta-performers">👤 ${names}${more}</span>`);
      }

      if (data.studio?.name) {
        parts.push(`<span class="meta-studio">🏢 ${data.studio.name}</span>`);
      }

      if (data.image_count) {
        parts.push(`<span class="meta-count">🖼 ${data.image_count}</span>`);
      }

      return parts.join('');
    }

    /**
     * 获取规格标签HTML
     */
    getItemSpecs(data) {
      const specs = [];

      let width, height;
      if (data.files?.[0]) {
        width = data.files[0].width;
        height = data.files[0].height;
      } else if (data.visual_files?.[0]) {
        width = data.visual_files[0].width;
        height = data.visual_files[0].height;
      }

      if (height) {
        const res = formatResolution(width, height);
        let resClass = '';
        if (height >= 2160) resClass = 'resolution-4k';
        else if (height >= 1080) resClass = 'resolution-hd';
        specs.push(`<span class="enhanced-wall-spec ${resClass}">${res}</span>`);
      }

      if (data.files?.[0]?.duration) {
        specs.push(`<span class="enhanced-wall-spec duration">${formatDuration(data.files[0].duration)}</span>`);
      }

      return specs.join('');
    }

    /**
     * 获取图片尺寸 - 优先使用数据，无数据时立即返回默认比例（实现瞬间布局）
     */
    getImageDimensions(src, data) {
      let width, height;
      if (data.files?.[0]) {
        width = data.files[0].width;
        height = data.files[0].height;
      } else if (data.visual_files?.[0]) {
        width = data.visual_files[0].width;
        height = data.visual_files[0].height;
      }

      if (width && height) {
        return Promise.resolve({ width, height });
      }

      // 无数据时立即使用默认 16:9，不加载图片以保持瞬间布局
      return Promise.resolve({ width: 16, height: 9 });
    }

    /**
     * 更新计数显示
     */
    updateCount() {
      const countEl = this.container?.querySelector('.enhanced-wall-count');
      if (countEl) {
        countEl.textContent = `已加载 ${this.items.length} / ${this.totalCount} 项`;
      }
    }

    /**
     * 显示/隐藏加载指示器
     */
    showLoading(show) {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = show ? 'flex' : 'none';
        this.loadingIndicator.innerHTML = '<div class="enhanced-wall-loading-spinner"></div><span>加载中...</span>';
      }
    }

    /**
     * 显示结束消息（无更多数据时在 loading 区域显示）
     */
    showEndMessage() {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = 'flex';
        this.loadingIndicator.innerHTML = '<span class="enhanced-wall-end">✨ 已加载全部内容</span>';
      }
    }

    /**
     * 显示错误消息
     */
    showError() {
      if (this.loadingIndicator) {
        this.loadingIndicator.style.display = 'flex';
        this.loadingIndicator.innerHTML = '<span class="enhanced-wall-error">❌ 加载失败，请刷新重试</span>';
      }
    }

    /**
     * 刷新
     */
    async refresh() {
      log('刷新数据...');
      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();

      this.items.forEach(item => item.element?.remove());
      this.items = [];
      this.page = 1;

      if (this.masonry) this.masonry.clear();
      if (this.scroller) this.scroller.reset();

      await this.loadMore();
    }

    /**
     * 随览：切换到 Stash 原生 random 模式（sortby=random_<seed>&z=0），支持无限滚动
     */
    loadRandom() {
      const url = new URL(window.location.href);
      url.searchParams.set('sortby', 'random_' + Date.now());
      url.searchParams.set('z', '0');
      url.searchParams.delete('page');
      window.history.pushState({}, '', url.href);
      this.refresh();
    }

    /**
     * 获取筛选选项（标签、演员、工作室、文件夹路径）
     */
    async fetchFilterOptions() {
      const per = 80;
      const folderPer = 300;
      const [tagsRes, performersRes, studiosRes, foldersRes] = await Promise.all([
        graphqlRequest(`query { findTags(filter: { per_page: ${per} }) { tags { id name } } }`),
        graphqlRequest(`query { findPerformers(filter: { per_page: ${per} }) { performers { id name } } }`),
        graphqlRequest(`query { findStudios(filter: { per_page: ${per} }) { studios { id name } } }`),
        graphqlRequest(`query { findFolders(filter: { per_page: ${folderPer} }) { folders { id path } } }`),
      ]);
      const folders = (foldersRes?.findFolders?.folders || [])
        .map((f) => (f.path || '').trim())
        .filter(Boolean)
        .sort();
      return {
        tags: tagsRes?.findTags?.tags || [],
        performers: performersRes?.findPerformers?.performers || [],
        studios: studiosRes?.findStudios?.studios || [],
        folders: [...new Set(folders)],
      };
    }

    /**
     * 打开筛选面板（每次打开从 URL 同步表单，确保清除后状态正确）
     */
    async openFilterPanel() {
      const params = new URLSearchParams(window.location.search);
      const currentQ = params.get('q') || '';
      const currentPath = params.get('path') || params.get('path_filter') || '';
      const currentTags = params.get('tags') || params.get('tag_ids') || '';
      const currentPerformers = params.get('performers') || params.get('performer_ids') || '';
      const currentStudios = params.get('studios') || params.get('studio_ids') || '';
      const sortbyParam = params.get('sortby') || params.get('sort') || 'created_at';
      const currentSort = sortbyParam.startsWith('random_') ? 'random' : sortbyParam;
      const currentSortDir = (params.get('sortdir') || params.get('direction') || 'DESC').toUpperCase();

      let modal = document.getElementById('enhanced-wall-filter-modal');
      if (modal) {
        modal.querySelector('#ew-filter-q').value = currentQ;
        const pathEl = modal.querySelector('#ew-filter-path');
        const pathCustomEl = modal.querySelector('#ew-filter-path-custom');
        if (pathEl) {
          const hasOpt = [...pathEl.options].some((o) => o.value === currentPath);
          if (currentPath && !hasOpt) {
            const opt = document.createElement('option');
            opt.value = currentPath;
            opt.textContent = currentPath;
            pathEl.appendChild(opt);
          }
          pathEl.value = currentPath || '';
        }
        if (pathCustomEl) pathCustomEl.value = '';
        modal.querySelector('#ew-filter-sortby').value = currentSort;
        modal.querySelector('#ew-filter-sortdir').value = currentSortDir === 'ASC' ? 'ASC' : 'DESC';
        this.populateFilterCheckboxes(modal, currentTags, currentPerformers, currentStudios);
        modal.style.display = 'flex';
        return;
      }

      modal = document.createElement('div');
      modal.id = 'enhanced-wall-filter-modal';
      modal.className = 'enhanced-wall-settings-modal enhanced-wall-filter-modal';
      const sortOpts = [
        ['created_at', '创建时间'],
        ['date', '日期'],
        ['title', '标题'],
        ['rating100', '评分'],
        ['updated_at', '更新时间'],
        ['random', '随机（随览）']
      ];
      modal.innerHTML = `
        <div class="enhanced-wall-settings-overlay"></div>
        <div class="enhanced-wall-settings-panel enhanced-wall-filter-panel">
          <div class="enhanced-wall-settings-header">
            <h3>🔍 筛选</h3>
            <button class="enhanced-wall-settings-close" data-action="close">&times;</button>
          </div>
          <div class="enhanced-wall-settings-body">
            <div class="enhanced-wall-settings-section">
              <h4>关键词</h4>
              <input type="text" class="enhanced-wall-filter-input" id="ew-filter-q" placeholder="搜索标题、路径等" value="${currentQ.replace(/"/g, '&quot;')}">
            </div>
            <div class="enhanced-wall-settings-section">
              <h4>路径</h4>
              <select id="ew-filter-path" class="enhanced-wall-filter-select enhanced-wall-path-select" title="选择文件夹路径过滤">
                <option value="">不限</option>
              </select>
              <input type="text" id="ew-filter-path-custom" class="enhanced-wall-filter-input enhanced-wall-path-custom" placeholder="或输入自定义路径" value="" style="margin-top:0.4rem">
            </div>
            <div class="enhanced-wall-settings-section">
              <h4>排序</h4>
              <div class="enhanced-wall-filter-row">
                <select id="ew-filter-sortby" class="enhanced-wall-filter-select">
                  ${sortOpts.map(([v, l]) => `<option value="${v}" ${currentSort === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
                <select id="ew-filter-sortdir" class="enhanced-wall-filter-select">
                  <option value="DESC" ${currentSortDir === 'DESC' ? 'selected' : ''}>降序</option>
                  <option value="ASC" ${currentSortDir === 'ASC' ? 'selected' : ''}>升序</option>
                </select>
              </div>
            </div>
            <div class="enhanced-wall-settings-section">
              <h4>标签</h4>
              <div class="enhanced-wall-filter-list" id="ew-filter-tags">加载中...</div>
            </div>
            <div class="enhanced-wall-settings-section">
              <h4>演员</h4>
              <div class="enhanced-wall-filter-list" id="ew-filter-performers">加载中...</div>
            </div>
            <div class="enhanced-wall-settings-section">
              <h4>工作室</h4>
              <div class="enhanced-wall-filter-list" id="ew-filter-studios">加载中...</div>
            </div>
          </div>
          <div class="enhanced-wall-settings-footer">
            <button class="enhanced-wall-settings-btn" data-action="clearFilter">清除筛选</button>
            <button class="enhanced-wall-settings-btn primary" data-action="applyFilter">应用</button>
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
          ? items.map((it) => `<label class="enhanced-wall-filter-item"><input type="checkbox" value="${it.id}" ${ids.has(parseInt(it.id, 10)) ? 'checked' : ''}> ${escapeFn(it[nameKey] || it.name || '')}</label>`).join('')
          : '<span class="enhanced-wall-filter-empty">无选项</span>';
      };

      this.populateFilterCheckboxes = (m, tagIds, performerIds, studioIds) => {
        const c = m.querySelector('#ew-filter-tags');
        if (c && c.querySelectorAll('input').length) {
          const ids = new Set(parseIdList(tagIds));
          c.querySelectorAll('input').forEach((cb) => { cb.checked = ids.has(parseInt(cb.value, 10)); });
        }
        const p = m.querySelector('#ew-filter-performers');
        if (p && p.querySelectorAll('input').length) {
          const ids = new Set(parseIdList(performerIds));
          p.querySelectorAll('input').forEach((cb) => { cb.checked = ids.has(parseInt(cb.value, 10)); });
        }
        const s = m.querySelector('#ew-filter-studios');
        if (s && s.querySelectorAll('input').length) {
          const ids = new Set(parseIdList(studioIds));
          s.querySelectorAll('input').forEach((cb) => { cb.checked = ids.has(parseInt(cb.value, 10)); });
        }
      };

      try {
        const opts = await this.fetchFilterOptions();
        renderCheckboxList('ew-filter-tags', opts.tags, currentTags, 'name');
        renderCheckboxList('ew-filter-performers', opts.performers, currentPerformers, 'name');
        renderCheckboxList('ew-filter-studios', opts.studios, currentStudios, 'name');
        const pathSelect = modal.querySelector('#ew-filter-path');
        if (pathSelect && opts.folders && opts.folders.length) {
          opts.folders.forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            if (p === currentPath) opt.selected = true;
            pathSelect.appendChild(opt);
          });
        }
      } catch (e) {
        log('加载筛选选项失败:', e);
        modal.querySelector('#ew-filter-tags').textContent = '加载失败';
        modal.querySelector('#ew-filter-performers').textContent = '加载失败';
        modal.querySelector('#ew-filter-studios').textContent = '加载失败';
      }

      const getSelectedIds = (containerId) => {
        const container = modal.querySelector('#' + containerId);
        if (!container) return [];
        return [...container.querySelectorAll('input[type=checkbox]:checked')].map(function(cb) { return cb.value; }).filter(Boolean);
      };

      const applyFilter = () => {
        const q = modal.querySelector('#ew-filter-q')?.value?.trim() || '';
        const pathFromSelect = modal.querySelector('#ew-filter-path')?.value?.trim() || '';
        const pathFromCustom = modal.querySelector('#ew-filter-path-custom')?.value?.trim() || '';
        const pathVal = pathFromCustom || pathFromSelect;
        let sortby = modal.querySelector('#ew-filter-sortby')?.value || 'created_at';
        const sortdir = modal.querySelector('#ew-filter-sortdir')?.value || 'DESC';
        if (sortby === 'random') {
          sortby = 'random_' + Date.now();
        }
        const tags = getSelectedIds('ew-filter-tags');
        const performers = getSelectedIds('ew-filter-performers');
        const studios = getSelectedIds('ew-filter-studios');
        const url = new URL(window.location.href);
        if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
        if (pathVal) url.searchParams.set('path', pathVal); else url.searchParams.delete('path');
        url.searchParams.set('sortby', sortby);
        if (sortby.startsWith('random_')) {
          url.searchParams.set('z', '0');
          url.searchParams.delete('sortdir');
        } else {
          url.searchParams.set('sortdir', sortdir);
        }
        if (tags.length) url.searchParams.set('tags', tags.join(',')); else url.searchParams.delete('tags');
        if (performers.length) url.searchParams.set('performers', performers.join(',')); else url.searchParams.delete('performers');
        if (studios.length) url.searchParams.set('studios', studios.join(',')); else url.searchParams.delete('studios');
        url.searchParams.delete('page');
        window.history.pushState({}, '', url.href);
        modal.style.display = 'none';
        const searchEl = document.getElementById('ew-toolbar-search');
        if (searchEl) searchEl.value = q;
        this.refresh();
      };

      const clearFilter = () => {
        const baseUrl = window.location.origin + window.location.pathname;
        window.history.pushState({}, '', baseUrl);
        modal.style.display = 'none';
        const searchEl = document.getElementById('ew-toolbar-search');
        if (searchEl) searchEl.value = '';
        this.refresh();
      };

      modal.querySelector('.enhanced-wall-settings-overlay').addEventListener('click', () => { modal.style.display = 'none'; });
      modal.querySelector('[data-action="close"]').addEventListener('click', () => { modal.style.display = 'none'; });
      modal.querySelector('[data-action="applyFilter"]').addEventListener('click', applyFilter);
      modal.querySelector('[data-action="clearFilter"]').addEventListener('click', clearFilter);

      modal.style.display = 'flex';
    }

    /**
     * 打开设置面板（简化版：布局预设 + 常用开关）
     */
    openSettingsPanel() {
      let modal = document.getElementById('enhanced-wall-settings-modal');
      if (modal) {
        modal.style.display = 'flex';
        this.populateSettingsForm(modal);
        return;
      }

      const cfg = getConfig();
      modal = document.createElement('div');
      modal.id = 'enhanced-wall-settings-modal';
      modal.className = 'enhanced-wall-settings-modal';
      modal.innerHTML = `
        <div class="enhanced-wall-settings-overlay"></div>
        <div class="enhanced-wall-settings-panel">
          <div class="enhanced-wall-settings-header">
            <h3>瀑布流设置</h3>
            <button class="enhanced-wall-settings-close" data-action="close">&times;</button>
          </div>
          <div class="enhanced-wall-settings-body">
            <div class="enhanced-wall-settings-section">
              <h4>功能开关</h4>
              <div class="enhanced-wall-settings-row enhanced-wall-settings-checkbox">
                <label><input type="checkbox" id="ew-setting-enableOnImages" ${cfg.enableOnImages ? 'checked' : ''}> 图片列表启用瀑布流</label>
              </div>
              <div class="enhanced-wall-settings-row enhanced-wall-settings-checkbox">
                <label><input type="checkbox" id="ew-setting-enableOnScenes" ${cfg.enableOnScenes ? 'checked' : ''}> 短片列表启用瀑布流</label>
              </div>
              <div class="enhanced-wall-settings-row enhanced-wall-settings-checkbox">
                <label><input type="checkbox" id="ew-setting-enableLightbox" ${cfg.enableLightbox !== false ? 'checked' : ''}> 点击图片在内置 lightbox 中浏览</label>
              </div>
            </div>
            <details class="enhanced-wall-settings-advanced">
              <summary>高级选项</summary>
              <div class="enhanced-wall-settings-section">
                <div class="enhanced-wall-settings-row">
                  <label>每页加载数量</label>
                  <input type="number" id="ew-setting-itemsPerPage" min="12" max="120" step="4" value="${cfg.itemsPerPage}">
                </div>
                <div class="enhanced-wall-settings-row enhanced-wall-settings-checkbox">
                  <label><input type="checkbox" id="ew-setting-debug" ${cfg.debug ? 'checked' : ''}> 调试模式（控制台输出）</label>
                </div>
              </div>
            </details>
          </div>
          <div class="enhanced-wall-settings-footer">
            <button class="enhanced-wall-settings-btn" data-action="reset">恢复默认</button>
            <button class="enhanced-wall-settings-btn primary" data-action="save">保存并应用</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      modal.querySelector('.enhanced-wall-settings-overlay').addEventListener('click', () => this.closeSettingsPanel());
      modal.querySelector('[data-action="close"]').addEventListener('click', () => this.closeSettingsPanel());
      modal.querySelector('[data-action="save"]').addEventListener('click', () => this.saveSettings());
      modal.querySelector('[data-action="reset"]').addEventListener('click', () => this.resetSettings());

      modal.style.display = 'flex';
    }

    /**
     * 填充设置表单（用于重新打开时同步最新值）
     */
    populateSettingsForm(modal) {
      if (!modal) return;
      const cfg = getConfig();
      const itemsEl = modal.querySelector('#ew-setting-itemsPerPage');
      if (itemsEl) itemsEl.value = cfg.itemsPerPage;
      ['enableOnImages', 'enableOnScenes', 'enableLightbox', 'debug'].forEach(id => {
        const el = modal.querySelector(`#ew-setting-${id}`);
        if (el) el.checked = cfg[id];
      });
    }

    /**
     * 关闭设置面板
     */
    closeSettingsPanel() {
      const modal = document.getElementById('enhanced-wall-settings-modal');
      if (modal) modal.style.display = 'none';
    }

    /**
     * 保存设置并刷新
     */
    saveSettings() {
      const preset = LAYOUT_PRESETS.compact;
      const updates = {
        layoutPreset: 'compact',
        columnWidth: preset.columnWidth,
        columnGap: preset.columnGap,
        rowGap: preset.rowGap,
        enableLightbox: document.getElementById('ew-setting-enableLightbox')?.checked ?? true,
        enableOnImages: document.getElementById('ew-setting-enableOnImages')?.checked ?? true,
        enableOnScenes: document.getElementById('ew-setting-enableOnScenes')?.checked ?? true,
        itemsPerPage: parseInt(document.getElementById('ew-setting-itemsPerPage')?.value, 10) || DEFAULT_CONFIG.itemsPerPage,
        debug: document.getElementById('ew-setting-debug')?.checked ?? false,
      };
      saveConfig(updates);
      this.closeSettingsPanel();
      this.disable();
      this.enable();
      log('设置已保存并应用');
    }

    /**
     * 重置设置为默认值
     */
    resetSettings() {
      resetConfig();
      this.populateSettingsForm(document.getElementById('enhanced-wall-settings-modal'));
      log('已恢复默认设置');
    }
  }

  // ==================== 初始化 ====================
  let enhancedWall = null;

  function init() {
    log('开始初始化...');
    
    const pageType = getPageType();
    if (!pageType) {
      log('不是目标页面，跳过初始化');
      return;
    }

    // 立即初始化，直接显示瀑布流
    if (enhancedWall) {
      enhancedWall.disable();
    }
    enhancedWall = new EnhancedWall();
    enhancedWall.init();
  }

  /**
   * PluginApi 挂载/卸载（供 patch 注入的 React 组件调用）
   */
  function mountEnhancedWall(container) {
    if (!container || enhancedWall) return;
    enhancedWall = new EnhancedWall();
    enhancedWall.enable(container);
  }
  function unmountEnhancedWall() {
    if (enhancedWall) {
      enhancedWall.disable();
      enhancedWall = null;
    }
    // 确保离开列表页时移除所有相关类，避免影响 tags/图库等页面的原生墙视图
    document.body.classList.remove('enhanced-wall-active');
    document.documentElement.classList.remove('enhanced-wall-preload');
    // 若 lightbox 打开则关闭并恢复滚动
    const overlay = document.getElementById('enhanced-wall-lightbox-overlay');
    if (overlay?.classList.contains('enhanced-wall-lightbox-visible')) {
      overlay.classList.remove('enhanced-wall-lightbox-visible');
      document.body.style.overflow = '';
    }
  }

  function setupPluginApi() {
    const api = window.PluginApi;
    if (!api || !api.Event) return false;

    api.Event.addEventListener('stash:location', (e) => {
      const path = e.detail?.data?.location?.pathname || window.location.pathname;
      unmountEnhancedWall();
      if (!isExcludedPath(path) && isListPath(path)) {
        setTimeout(init, 300);
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
      log('URL变化 (fallback):', location.href);
      if (initTimeout) clearTimeout(initTimeout);
      unmountEnhancedWall();
      initTimeout = setTimeout(() => {
        initTimeout = null;
        init();
      }, 300);
    };
    window.addEventListener('popstate', checkUrl);
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    if (origPush) {
      history.pushState = function(...args) {
        origPush.apply(this, args);
        setTimeout(checkUrl, 50);
      };
    }
    if (origReplace) {
      history.replaceState = function(...args) {
        origReplace.apply(this, args);
        setTimeout(checkUrl, 50);
      };
    }
    let urlDebounceTimer = null;
    const urlObserver = new MutationObserver(() => {
      if (urlDebounceTimer) clearTimeout(urlDebounceTimer);
      urlDebounceTimer = setTimeout(() => { urlDebounceTimer = null; checkUrl(); }, 200);
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 优先使用 PluginApi；若不可用或 patch 失败，则用 MutationObserver 备用
  function bootstrap() {
    if (setupPluginApi()) {
      log('已使用 PluginApi.Event 监听路由');
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    } else {
      setupFallback();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    }
  }

  // PluginApi 可能晚于脚本加载，稍候再试
  if (window.PluginApi) {
    bootstrap();
  } else {
    const tryBootstrap = () => {
      if (window.PluginApi) {
        bootstrap();
        return;
      }
      setTimeout(tryBootstrap, 50);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(tryBootstrap, 100));
    } else {
      setTimeout(tryBootstrap, 100);
    }
  }

  log('Stash 瀑布流增强预览墙插件已加载');
})();
