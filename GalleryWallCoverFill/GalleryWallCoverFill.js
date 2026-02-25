/**
 * GalleryWallCoverFill — Galleries 墙视图封面填充
 *
 * 仅在 /galleries 页面为图库墙卡片的封面图应用 object-fit: cover，
 * 使首张图片填满固定比例区域(3:2 横向 / 3:4 纵向)，消除空缺，不改变布局与其它特性。
 *
 * 执行策略：
 * - 延迟到下一 tick 初始化，避免与主应用 setupReplaceUnsafeHeader 等只可执行一次的代码冲突
 * - 仅注册一次 history 与事件监听，避免重复调用
 * - updateBodyClass 使用 classList.toggle 避免冗余 DOM 写入
 * - PluginApi 轮询设上限，防止无限重试
 */
(function() {
  'use strict';

  const BODY_CLASS = 'gallery-wall-coverfill-active';
  const PLUGINAPI_MAX_RETRY = 40; // 50ms * 40 ≈ 2s 后放弃

  function isGalleriesPath(pathname) {
    const raw = pathname != null ? pathname : (window.location && window.location.pathname);
    const p = (String(raw || '').replace(/\/$/, '') || '/');
    return p === '/galleries' || p.startsWith('/galleries/');
  }

  function updateBodyClass(pathname) {
    const body = document.body;
    if (!body) return;
    const active = isGalleriesPath(pathname);
    body.classList.toggle(BODY_CLASS, active);
  }

  let installed = false;

  function installOnce() {
    if (installed) return;
    installed = true;

    if (window.PluginApi && window.PluginApi.Event) {
      window.PluginApi.Event.addEventListener('stash:location', (e) => {
        const path = e.detail?.data?.location?.pathname;
        updateBodyClass(path);
      });
    }

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    if (typeof origPush === 'function') {
      history.pushState = function(...args) {
        origPush.apply(this, args);
        updateBodyClass();
      };
    }
    if (typeof origReplace === 'function') {
      history.replaceState = function(...args) {
        origReplace.apply(this, args);
        updateBodyClass();
      };
    }
    window.addEventListener('popstate', () => updateBodyClass());

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => updateBodyClass());
    } else {
      updateBodyClass();
    }
  }

  function bootstrap() {
    installOnce();
  }

  function tryBootstrap(retryCount) {
    if (window.PluginApi) {
      setTimeout(bootstrap, 0);
      return;
    }
    if (retryCount >= PLUGINAPI_MAX_RETRY) return;
    setTimeout(() => tryBootstrap(retryCount + 1), 50);
  }

  if (window.PluginApi) {
    setTimeout(bootstrap, 0);
  } else {
    const scheduleRetry = () => setTimeout(() => tryBootstrap(0), 50);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scheduleRetry);
    } else {
      scheduleRetry();
    }
  }
})();
