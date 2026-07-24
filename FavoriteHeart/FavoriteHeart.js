/**
 * Stash 红心收藏功能插件 - JavaScript实现
 * Favorite Heart Plugin for Stash
 * 
 * 功能：为图片/图库/短片/演员/Group添加红心收藏按钮，点击后自动添加指定标签
 * 兼容：网格视图 & 预览墙视图 & 瀑布流增强视图 (EnhancedWallView) & 砌墙视图 (PowerWall)
 * 
 * 参考文档：https://docs.stashapp.cc/in-app-manual/plugins/ui-plugin-api/
 */

(function() {
  'use strict';

  // 从 Stash 插件系统获取配置
  const getPluginConfig = () => {
    const defaultConfig = {
      favoriteTagName: '精选集',
      dislikeTagName: 'Dislike',
      checkInterval: 3000,
      enableOnScenes: true,
      enableOnImages: true,
      enableOnGalleries: true,
      enableOnPerformers: true,
      enableOnGroups: true,
      heartColor: '#ff7373',
    };

    try {
      if (window.PluginApi && window.PluginApi.getPluginConfig) {
        const pluginConfig = window.PluginApi.getPluginConfig('FavoriteHeart');
        return { ...defaultConfig, ...pluginConfig };
      }
    } catch (e) {
      console.warn('[FavoriteHeart] 无法获取插件配置，使用默认值:', e);
    }

    return defaultConfig;
  };

  const pluginSettings = getPluginConfig();

  // 配置项（兼容旧格式）
  const CONFIG = {
    FAVORITE_TAG_NAME: pluginSettings.favoriteTagName,
    DISLIKE_TAG_NAME: pluginSettings.dislikeTagName || 'Dislike',
    CHECK_INTERVAL: pluginSettings.checkInterval,
    GRAPHQL_ENDPOINT: '/graphql',
    DEBOUNCE_DELAY: 800,
    BATCH_SIZE: 5,
    BATCH_DELAY: 100,
    ENABLE_ON_SCENES: pluginSettings.enableOnScenes,
    ENABLE_ON_IMAGES: pluginSettings.enableOnImages,
    ENABLE_ON_GALLERIES: pluginSettings.enableOnGalleries,
    ENABLE_ON_PERFORMERS: pluginSettings.enableOnPerformers,
    ENABLE_ON_GROUPS: pluginSettings.enableOnGroups,
    HEART_COLOR: pluginSettings.heartColor,
  };

  // 动态设置红心颜色
  if (CONFIG.HEART_COLOR !== '#ff7373') {
    const style = document.createElement('style');
    style.textContent = `.favorite-heart-btn.favorited::before { color: ${CONFIG.HEART_COLOR} !important; }`;
    document.head.appendChild(style);
  }

  // 存储已处理的卡片
  const processedCards = new WeakSet();
  
  // 防止重复扫描的标志
  let isScanning = false;
  let scanTimeout = null;
  let batchProcessTimeout = null;

  /**
   * 发送GraphQL请求
   */
  async function graphqlRequest(query, variables = {}) {
    try {
      const response = await fetch(CONFIG.GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) {
        console.error('[FavoriteHeart] GraphQL HTTP ' + response.status + ': ' + response.statusText);
        return null;
      }
      const result = await response.json();
      if (result.errors) {
        const firstMsg = result.errors[0]?.message || '';
        console.error('[FavoriteHeart] GraphQL ' + result.errors.length + ' errors. First: ' + firstMsg);
        return null;
      }
      return result.data;
    } catch (error) {
      console.error('[FavoriteHeart] 请求失败:', error);
      return null;
    }
  }

  /**
   * 获取或创建"精选集"标签（带 ID 缓存与并发去重）
   */
  let favoriteTagIdCache = null;
  let favoriteTagPromise = null;
  async function getFavoriteTag() {
    if (favoriteTagIdCache) return favoriteTagIdCache;
    if (favoriteTagPromise) return favoriteTagPromise;
    favoriteTagPromise = (async () => {
      // 先查找标签是否存在
      const findQuery = `
        query FindTags($filter: String!) {
          findTags(tag_filter: { name: { value: $filter, modifier: EQUALS } }) {
            tags {
              id
              name
            }
          }
        }
      `;
      const findResult = await graphqlRequest(findQuery, { filter: CONFIG.FAVORITE_TAG_NAME });
      if (findResult?.findTags?.tags?.length > 0) {
        return findResult.findTags.tags[0].id;
      }
      // 如果不存在，创建新标签
      const createQuery = `
        mutation TagCreate($input: TagCreateInput!) {
          tagCreate(input: $input) {
            id
            name
          }
        }
      `;
      const createResult = await graphqlRequest(createQuery, {
        input: { name: CONFIG.FAVORITE_TAG_NAME }
      });
      return createResult?.tagCreate?.id;
    })().then(id => {
      if (id) favoriteTagIdCache = id;
      favoriteTagPromise = null;
      return id;
    });
    return favoriteTagPromise;
  }

  /**
   * 获取或创建「不喜欢」标签（带 ID 缓存与并发去重）
   */
  let dislikeTagIdCache = null;
  let dislikeTagPromise = null;
  async function getDislikeTag() {
    if (dislikeTagIdCache) return dislikeTagIdCache;
    if (dislikeTagPromise) return dislikeTagPromise;
    dislikeTagPromise = (async () => {
      const findQuery = `
        query FindTags($filter: String!) {
          findTags(tag_filter: { name: { value: $filter, modifier: EQUALS } }) {
            tags {
              id
              name
            }
          }
        }
      `;
      const findResult = await graphqlRequest(findQuery, { filter: CONFIG.DISLIKE_TAG_NAME });
      if (findResult?.findTags?.tags?.length > 0) {
        return findResult.findTags.tags[0].id;
      }
      const createQuery = `
        mutation TagCreate($input: TagCreateInput!) {
          tagCreate(input: $input) {
            id
            name
          }
        }
      `;
      const createResult = await graphqlRequest(createQuery, {
        input: { name: CONFIG.DISLIKE_TAG_NAME }
      });
      return createResult?.tagCreate?.id;
    })().then(id => {
      if (id) dislikeTagIdCache = id;
      dislikeTagPromise = null;
      return id;
    });
    return dislikeTagPromise;
  }

  /**
   * 为场景移除标签
   */
  async function removeTagFromScene(sceneId, tagId) {
    const getSceneQuery = `
      query FindScene($id: ID!) {
        findScene(id: $id) {
          tags {
            id
          }
        }
      }
    `;
    
    const sceneData = await graphqlRequest(getSceneQuery, { id: sceneId });
    const currentTagIds = sceneData?.findScene?.tags?.map(t => t.id) || [];
    
    // 移除指定标签
    const tagIds = currentTagIds.filter(id => id !== tagId);
    
    const query = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
        }
      }
    `;
    
    return await graphqlRequest(query, {
      input: { id: sceneId, tag_ids: tagIds }
    });
  }

  /**
   * 为图片移除标签
   */
  async function removeTagFromImage(imageId, tagId) {
    const getImageQuery = `
      query FindImage($id: ID!) {
        findImage(id: $id) {
          tags {
            id
          }
        }
      }
    `;
    
    const imageData = await graphqlRequest(getImageQuery, { id: imageId });
    const currentTagIds = imageData?.findImage?.tags?.map(t => t.id) || [];
    
    // 移除指定标签
    const tagIds = currentTagIds.filter(id => id !== tagId);
    
    const query = `
      mutation ImageUpdate($input: ImageUpdateInput!) {
        imageUpdate(input: $input) {
          id
        }
      }
    `;
    
    return await graphqlRequest(query, {
      input: { id: imageId, tag_ids: tagIds }
    });
  }

  /**
   * 为图库移除标签
   */
  async function removeTagFromGallery(galleryId, tagId) {
    const getGalleryQuery = `
      query FindGallery($id: ID!) {
        findGallery(id: $id) {
          tags {
            id
          }
        }
      }
    `;
    
    const galleryData = await graphqlRequest(getGalleryQuery, { id: galleryId });
    const currentTagIds = galleryData?.findGallery?.tags?.map(t => t.id) || [];
    
    // 移除指定标签
    const tagIds = currentTagIds.filter(id => id !== tagId);
    
    const query = `
      mutation GalleryUpdate($input: GalleryUpdateInput!) {
        galleryUpdate(input: $input) {
          id
        }
      }
    `;
    
    return await graphqlRequest(query, {
      input: { id: galleryId, tag_ids: tagIds }
    });
  }

  /**
   * 为场景添加标签
   */
  async function addTagToScene(sceneId, tagId) {
    const query = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
        }
      }
    `;
    
    // 先获取当前场景的标签
    const getSceneQuery = `
      query FindScene($id: ID!) {
        findScene(id: $id) {
          tags {
            id
          }
        }
      }
    `;
    
    const sceneData = await graphqlRequest(getSceneQuery, { id: sceneId });
    const currentTagIds = sceneData?.findScene?.tags?.map(t => t.id) || [];
    
    // 如果已经有这个标签，不重复添加
    if (currentTagIds.includes(tagId)) {
      return true;
    }
    
    // 添加新标签
    const tagIds = [...currentTagIds, tagId];
    return await graphqlRequest(query, {
      input: { id: sceneId, tag_ids: tagIds }
    });
  }

  /**
   * 为图片添加标签
   */
  async function addTagToImage(imageId, tagId) {
    const query = `
      mutation ImageUpdate($input: ImageUpdateInput!) {
        imageUpdate(input: $input) {
          id
        }
      }
    `;
    
    const getImageQuery = `
      query FindImage($id: ID!) {
        findImage(id: $id) {
          tags {
            id
          }
        }
      }
    `;
    
    const imageData = await graphqlRequest(getImageQuery, { id: imageId });
    const currentTagIds = imageData?.findImage?.tags?.map(t => t.id) || [];
    
    if (currentTagIds.includes(tagId)) {
      return true;
    }
    
    const tagIds = [...currentTagIds, tagId];
    return await graphqlRequest(query, {
      input: { id: imageId, tag_ids: tagIds }
    });
  }

  /**
   * 为图库添加标签
   */
  async function addTagToGallery(galleryId, tagId) {
    const query = `
      mutation GalleryUpdate($input: GalleryUpdateInput!) {
        galleryUpdate(input: $input) {
          id
        }
      }
    `;
    
    const getGalleryQuery = `
      query FindGallery($id: ID!) {
        findGallery(id: $id) {
          tags {
            id
          }
        }
      }
    `;
    
    const galleryData = await graphqlRequest(getGalleryQuery, { id: galleryId });
    const currentTagIds = galleryData?.findGallery?.tags?.map(t => t.id) || [];
    
    if (currentTagIds.includes(tagId)) {
      return true;
    }
    
    const tagIds = [...currentTagIds, tagId];
    return await graphqlRequest(query, {
      input: { id: galleryId, tag_ids: tagIds }
    });
  }

  /**
   * 从卡片中提取ID
   */
  function extractIdFromCard(card) {
    // 尝试从链接中提取ID
    let link = card.querySelector('a[href*="/scenes/"], a[href*="/images/"], a[href*="/galleries/"]');
    
    // 如果是wall-item，尝试从父元素或兄弟元素查找链接
    if (!link && card.classList.contains('wall-item')) {
      link = card.querySelector('a') || card.closest('a');
    }
    
    if (link) {
      const match = link.href.match(/\/(scenes|images|galleries)\/(\d+)/);
      if (match) {
        return { type: match[1], id: match[2] };
      }
    }
    
    // 尝试从图片src中提取ID（wall视图特有）
    const img = card.querySelector('img[src*="/image/"], img[src*="/scene/"], img[src*="/gallery/"]');
    if (img) {
      const srcMatch = img.src.match(/\/(image|scene|gallery)\/(\d+)/);
      if (srcMatch) {
        const typeMap = { image: 'images', scene: 'scenes', gallery: 'galleries' };
        return { type: typeMap[srcMatch[1]], id: srcMatch[2] };
      }
    }
    
    // 尝试从data属性中提取
    const dataId = card.dataset.id || card.querySelector('[data-id]')?.dataset.id;
    const dataType = card.dataset.type || card.querySelector('[data-type]')?.dataset.type;
    if (dataId && dataType && (dataType === 'images' || dataType === 'scenes' || dataType === 'galleries')) {
      return { type: dataType, id: dataId };
    }
    if (dataId) {
      if (card.classList.contains('scene-card')) return { type: 'scenes', id: dataId };
      if (card.classList.contains('image-card')) return { type: 'images', id: dataId };
      if (card.classList.contains('gallery-card')) return { type: 'galleries', id: dataId };
    }
    
    return null;
  }

  /**
   * 批量查询卡片收藏/不喜欢状态
   * 逐卡查询会产生 2N 条 GraphQL 请求（N=卡片数），
   * 这里按类型聚合成队列，150ms 窗口内每类型只发 1 条 HTTP 请求。
   * 注意：部分 Stash 版本的 FindFilterType 不支持 ids 过滤，
   * 因此使用 GraphQL 别名在单请求内并发多个 findXxx(id:...) 字段。
   */
  const CARD_TYPES = ['scenes', 'images', 'galleries'];
  // 单数实体名显式映射（不能靠 slice 推导：galleries → Gallery，而非 Gallerie）
  const TYPE_ENTITY = { scenes: 'Scene', images: 'Image', galleries: 'Gallery' };
  const statusQueues = { scenes: new Map(), images: new Map(), galleries: new Map() };
  let statusFlushTimer = null;
  const STATUS_FLUSH_DELAY = 150;
  const STATUS_BATCH_CHUNK = 200; // 单请求别名上限，防止超长查询
  const STATUS_FALLBACK_CONCURRENCY = 5; // 批量查询失败时，降级为每 N 个 ID 单独发请求的并发上限

  function requestCardStatus(type, id) {
    return new Promise((resolve) => {
      const queue = statusQueues[type];
      // ID 仅允许数字（别名内联进查询字符串，防注入）
      if (!queue || !/^\d+$/.test(String(id))) {
        resolve({ favorited: false, disliked: false });
        return;
      }
      queue.set(String(id), resolve);
      if (!statusFlushTimer) {
        statusFlushTimer = setTimeout(flushStatusQueues, STATUS_FLUSH_DELAY);
      }
    });
  }

  async function flushStatusQueues() {
    statusFlushTimer = null;
    await Promise.all(CARD_TYPES.map(async (type) => {
      const queue = statusQueues[type];
      if (!queue.size) return;
      const entries = [...queue.entries()];
      queue.clear();
      const entity = TYPE_ENTITY[type];
      for (let start = 0; start < entries.length; start += STATUS_BATCH_CHUNK) {
        const chunk = entries.slice(start, start + STATUS_BATCH_CHUNK);
        // Map.entries() → [key(id字符串), value(resolve函数)], 取第一个元素即 ID
        const fields = chunk.map(([idStr], i) => `c${i}: find${entity}(id: "${idStr}") { tags { name } }`).join(' ');
        let result = await graphqlRequest(`query { ${fields} }`);
        // 批量查询失败时，降级为逐 ID 单独查询（限并发）
        if (!result && chunk.length > 1) {
          console.warn('[FavoriteHeart] 批量查询降级: ' + type + ' x' + chunk.length);
          // 先发一条探针验证单独查询是否可行
          const probeKey = `find${entity}`;
          const probeId = chunk[0][0];  // Map.entries() 第一个元素为 ID 字符串
          const probe = await graphqlRequest(`query { ${probeKey}(id: "${probeId}") { tags { name } } }`);
          if (!probe) {
            // 单独查询同样失败，批量降级无效，全部按无标记处理
            chunk.forEach(([, resolve]) => resolve({ favorited: false, disliked: false }));
            continue;
          }
          result = { c0: { tags: probe[probeKey]?.tags || [] } };
          if (chunk.length > 1) {
            for (let i = 1; i < chunk.length; i += STATUS_FALLBACK_CONCURRENCY) {
              const slice = chunk.slice(i, i + STATUS_FALLBACK_CONCURRENCY);
              const partial = await Promise.all(slice.map(async ([idStr], j) => {
                const single = await graphqlRequest(`query { ${probeKey}(id: "${idStr}") { tags { name } } }`);
                return [i + j, single?.[probeKey]?.tags || []];
              }));
              partial.forEach(([idx, tags]) => { result['c' + idx] = { tags }; });
            }
          }
        }
        chunk.forEach(([, resolve], i) => {
          const tags = result?.[`c${i}`]?.tags || [];
          resolve({
            favorited: tags.some(t => t.name === CONFIG.FAVORITE_TAG_NAME),
            disliked: tags.some(t => t.name === CONFIG.DISLIKE_TAG_NAME),
          });
        });
      }
    }));
  }

  /**
   * 处理红心点击（like/dislike 互斥：同一项只能 like 或 dislike 或不标记）
   */
  async function handleHeartClick(event, button, card, cardInfo = null) {
    event.preventDefault();
    event.stopPropagation();
    
    const isFavorited = button.classList.contains('favorited');
    
    if (!cardInfo) cardInfo = extractIdFromCard(card);
    if (!cardInfo) {
      console.error('无法提取卡片ID');
      return;
    }
    
    button.classList.add('loading');
    
    try {
      const favoriteTagId = await getFavoriteTag();
      if (!favoriteTagId) {
        alert('无法创建或获取"精选集"标签');
        return;
      }
      
      let success = false;
      
      if (!isFavorited) {
        // 添加收藏前先移除 dislike 标签，保证互斥
        const dislikeTagId = await getDislikeTag();
        if (dislikeTagId) {
          switch (cardInfo.type) {
            case 'scenes': await removeTagFromScene(cardInfo.id, dislikeTagId); break;
            case 'images': await removeTagFromImage(cardInfo.id, dislikeTagId); break;
            case 'galleries': await removeTagFromGallery(cardInfo.id, dislikeTagId); break;
          }
        }
        switch (cardInfo.type) {
          case 'scenes': success = await addTagToScene(cardInfo.id, favoriteTagId); break;
          case 'images': success = await addTagToImage(cardInfo.id, favoriteTagId); break;
          case 'galleries': success = await addTagToGallery(cardInfo.id, favoriteTagId); break;
        }
        if (success) {
          button.classList.add('favorited');
          const dislikeBtn = card.querySelector('.favorite-dislike-btn');
          if (dislikeBtn) dislikeBtn.classList.remove('disliked');
        }
      } else {
        switch (cardInfo.type) {
          case 'scenes': success = await removeTagFromScene(cardInfo.id, favoriteTagId); break;
          case 'images': success = await removeTagFromImage(cardInfo.id, favoriteTagId); break;
          case 'galleries': success = await removeTagFromGallery(cardInfo.id, favoriteTagId); break;
        }
        if (success) button.classList.remove('favorited');
      }
    } catch (error) {
      console.error('操作失败:', error);
      alert('操作失败，请查看控制台');
    } finally {
      button.classList.remove('loading');
    }
  }

  /**
   * 处理心碎（不喜欢）点击（like/dislike 互斥：同一项只能 like 或 dislike 或不标记）
   */
  async function handleDislikeClick(event, button, card, cardInfo = null) {
    event.preventDefault();
    event.stopPropagation();
    const isDisliked = button.classList.contains('disliked');
    if (!cardInfo) cardInfo = extractIdFromCard(card);
    if (!cardInfo) {
      console.error('[FavoriteHeart] 无法提取卡片ID');
      return;
    }
    button.classList.add('loading');
    try {
      const dislikeTagId = await getDislikeTag();
      if (!dislikeTagId) {
        alert('无法创建或获取「' + CONFIG.DISLIKE_TAG_NAME + '」标签');
        return;
      }
      let success = false;
      if (!isDisliked) {
        // 添加不喜欢前先移除 like 标签，保证互斥
        const favoriteTagId = await getFavoriteTag();
        if (favoriteTagId) {
          switch (cardInfo.type) {
            case 'scenes': await removeTagFromScene(cardInfo.id, favoriteTagId); break;
            case 'images': await removeTagFromImage(cardInfo.id, favoriteTagId); break;
            case 'galleries': await removeTagFromGallery(cardInfo.id, favoriteTagId); break;
          }
        }
        switch (cardInfo.type) {
          case 'scenes': success = await addTagToScene(cardInfo.id, dislikeTagId); break;
          case 'images': success = await addTagToImage(cardInfo.id, dislikeTagId); break;
          case 'galleries': success = await addTagToGallery(cardInfo.id, dislikeTagId); break;
        }
        if (success) {
          button.classList.add('disliked');
          const heartBtn = card.querySelector('.favorite-heart-btn');
          if (heartBtn) heartBtn.classList.remove('favorited');
        }
      } else {
        switch (cardInfo.type) {
          case 'scenes': success = await removeTagFromScene(cardInfo.id, dislikeTagId); break;
          case 'images': success = await removeTagFromImage(cardInfo.id, dislikeTagId); break;
          case 'galleries': success = await removeTagFromGallery(cardInfo.id, dislikeTagId); break;
        }
        if (success) {
          button.classList.remove('disliked');
        }
      }
    } catch (error) {
      console.error('[FavoriteHeart] 不喜欢操作失败:', error);
      alert('操作失败，请查看控制台');
    } finally {
      button.classList.remove('loading');
    }
  }

  /**
   * 检查当前是否在"精选集"tag页面
   */
  function isInFavoriteTagPage() {
    // 检查URL中是否包含tag ID，并且页面标题或内容包含"精选集"
    const path = window.location.pathname;
    if (path.includes('/tags/')) {
      // 检查页面标题
      const pageTitle = document.querySelector('h2, h1');
      if (pageTitle && pageTitle.textContent.includes(CONFIG.FAVORITE_TAG_NAME)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查当前是否在「不喜欢」tag 页面（带 dislike 标记的照片/视频仅在此页可见）
   */
  function isInDislikeTagPage() {
    const path = window.location.pathname;
    if (path.includes('/tags/')) {
      const pageTitle = document.querySelector('h2, h1');
      if (pageTitle && pageTitle.textContent.includes(CONFIG.DISLIKE_TAG_NAME)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 是否为照片/视频（仅对 scenes/images 隐藏 dislike，图库等不隐藏）
   */
  function isSceneOrImage(typeOrCard) {
    if (typeof typeOrCard === 'string') {
      return typeOrCard === 'scenes' || typeOrCard === 'images';
    }
    const el = typeOrCard;
    return el && (el.classList.contains('scene-card') || el.classList.contains('image-card') || el.classList.contains('enhanced-wall-item'));
  }

  /**
   * 为wall视图的图片添加包装容器和红心按钮（不检查收藏状态，延迟加载）
   */
  async function addHeartToWallImage(img) {
    // 检查是否已处理
    if (processedCards.has(img)) return;
    processedCards.add(img);
    
    // 检查图片是否已经有包装容器
    if (img.parentElement?.classList.contains('wall-image-wrapper')) return;
    
    // 提取图片ID
    const srcMatch = img.src.match(/\/(image|scene|gallery)\/(\d+)/);
    if (!srcMatch) return;
    
    const typeMap = { image: 'images', scene: 'scenes', gallery: 'galleries' };
    const cardInfo = { type: typeMap[srcMatch[1]], id: srcMatch[2] };
    
    // 保存原始样式值
    const originalLeft = img.style.left;
    const originalTop = img.style.top;
    const originalMargin = img.style.margin;
    const originalWidth = img.width;
    const originalHeight = img.height;
    
    // 创建包装容器
    const wrapper = document.createElement('div');
    wrapper.className = 'wall-image-wrapper';
    wrapper.style.cssText = `
      position: absolute;
      left: ${originalLeft};
      top: ${originalTop};
      width: ${originalWidth}px;
      height: ${originalHeight}px;
      margin: ${originalMargin};
    `;
    
    // 将图片包装起来
    const parent = img.parentElement;
    parent.insertBefore(wrapper, img);
    wrapper.appendChild(img);
    
    // 重置图片的定位（因为现在由wrapper控制）
    img.style.position = 'relative';
    img.style.left = '0';
    img.style.top = '0';
    img.style.margin = '0';
    img.style.width = '100%';
    img.style.height = '100%';
    
    // 创建红心按钮
    const heartButton = document.createElement('button');
    heartButton.className = 'favorite-heart-btn';
    heartButton.title = '添加到精选集';
    heartButton.setAttribute('aria-label', '收藏');
    
    // 心碎（不喜欢）按钮 - 红心正下方，与红心互斥
    const dislikeButton = document.createElement('button');
    dislikeButton.className = 'favorite-dislike-btn';
    dislikeButton.title = '标记为不喜欢';
    dislikeButton.setAttribute('aria-label', '不喜欢');

    // like/dislike 互斥：只检查一次，至多显示其一；仅照片/视频参与“隐藏 dislike”逻辑
    const markDisliked = () => {
      dislikeButton.classList.add('disliked');
    };
    if (isInFavoriteTagPage()) {
      heartButton.classList.add('favorited');
    } else if (isInDislikeTagPage()) {
      markDisliked();
    } else {
      requestCardStatus(cardInfo.type, cardInfo.id).then(({ favorited, disliked }) => {
        if (favorited) {
          heartButton.classList.add('favorited');
        } else if (disliked) {
          markDisliked();
        }
      });
    }
    
    heartButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleHeartClick(e, heartButton, wrapper, cardInfo);
    });
    dislikeButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleDislikeClick(e, dislikeButton, wrapper, cardInfo);
    });
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'favorite-heart-actions';
    actionsWrap.appendChild(heartButton);
    actionsWrap.appendChild(dislikeButton);
    wrapper.appendChild(actionsWrap);
  }

  /**
   * 为卡片添加红心按钮（延迟检查收藏状态）
   */
  async function addHeartButton(card) {
    if (processedCards.has(card)) return;
    processedCards.add(card);
    
    // 查找缩略图容器
    let thumbnailSection = card.querySelector('.thumbnail-section, .wall-item-container');

    // PowerWall 砌墙视图：使用 .power-wall-media 作为红心挂载点
    if (!thumbnailSection && card.classList.contains('power-wall-item')) {
      thumbnailSection = card.querySelector('.power-wall-media') || card;
    }
    // 瀑布流增强视图：使用 .enhanced-wall-media 作为红心挂载点
    if (!thumbnailSection && card.classList.contains('enhanced-wall-item')) {
      thumbnailSection = card.querySelector('.enhanced-wall-media') || card;
    }
    
    // 如果是wall视图的图片元素本身
    if (!thumbnailSection && card.classList.contains('wall-item')) {
      thumbnailSection = card;
    }
    
    // 如果card本身就是容器（针对wall视图的父div）
    if (!thumbnailSection && card.querySelector('img[src*="/image/"], img[src*="/scene/"], img[src*="/gallery/"]')) {
      thumbnailSection = card;
    }
    
    if (!thumbnailSection) return;
    
    // 检查是否已经添加过按钮（红心或心碎任一存在即已处理）
    if (thumbnailSection.querySelector('.favorite-heart-btn') || thumbnailSection.querySelector('.favorite-dislike-btn')) return;

    // 创建红心按钮与心碎按钮（红心正下方，互斥）
    const heartButton = document.createElement('button');
    heartButton.className = 'favorite-heart-btn';
    heartButton.title = '添加到精选集';
    heartButton.setAttribute('aria-label', '收藏');
    const dislikeButton = document.createElement('button');
    dislikeButton.className = 'favorite-dislike-btn';
    dislikeButton.title = '标记为不喜欢';
    dislikeButton.setAttribute('aria-label', '不喜欢');
    
    // 提取卡片信息
    const cardInfo = extractIdFromCard(card);

    // like/dislike 互斥：只检查一次，至多显示其一；仅照片/视频参与“隐藏 dislike”逻辑
    const markDisliked = () => {
      dislikeButton.classList.add('disliked');
    };
    if (isInFavoriteTagPage()) {
      heartButton.classList.add('favorited');
    } else if (isInDislikeTagPage()) {
      markDisliked();
    } else if (cardInfo) {
      requestCardStatus(cardInfo.type, cardInfo.id).then(({ favorited, disliked }) => {
        if (favorited) {
          heartButton.classList.add('favorited');
        } else if (disliked) {
          markDisliked();
        }
      });
    }
    
    heartButton.addEventListener('click', (e) => handleHeartClick(e, heartButton, card));
    dislikeButton.addEventListener('click', (e) => handleDislikeClick(e, dislikeButton, card));

    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'favorite-heart-actions';
    actionsWrap.appendChild(heartButton);
    actionsWrap.appendChild(dislikeButton);
    const currentPosition = window.getComputedStyle(thumbnailSection).position;
    if (currentPosition === 'static') {
      thumbnailSection.style.position = 'relative';
    }
    thumbnailSection.appendChild(actionsWrap);
  }

  /**
   * 检查当前页面是否需要红心功能
   */
  function shouldEnableHearts() {
    const path = window.location.pathname;
    
    // 在tags列表页面（不是tag详情页）不启用
    if (path === '/tags' || path === '/tags/') {
      return false;
    }
    
    // 在performers、studios等页面不启用
    if (path.includes('/performers') || path.includes('/studios') || path.includes('/movies')) {
      return false;
    }
    
    return true;
  }

  /**
   * 扫描并处理所有卡片（带节流控制）
   */
  function scanAndProcessCards() {
    // 如果正在扫描，跳过
    if (isScanning) return;
    
    // 检查是否需要启用红心功能
    if (!shouldEnableHearts()) {
      return;
    }
    
    isScanning = true;
    
    // 清除之前的批处理定时器
    if (batchProcessTimeout) {
      clearTimeout(batchProcessTimeout);
    }
    
    // 使用requestAnimationFrame确保在浏览器空闲时执行
    requestAnimationFrame(() => {
      try {
        // 网格视图的卡片（排除tag卡片）
        const gridCards = document.querySelectorAll('.scene-card, .image-card, .gallery-card');
        gridCards.forEach(card => addHeartButton(card));
        
        // 瀑布流增强视图的卡片（与 EnhancedWallView 兼容）
        const enhancedWallItems = document.querySelectorAll('.enhanced-wall-item');
        enhancedWallItems.forEach(card => addHeartButton(card));
        
        // 墙视图的卡片 - 查找所有包含图片的容器
        // 方法1: 通过.wall-item类
        const wallItems = document.querySelectorAll('.wall-item, .wall-item-media');
        wallItems.forEach(item => addHeartButton(item));
        
        // 方法2: 直接处理wall视图中的每个图片（为每个图片创建独立的包装容器）
        const wallImages = document.querySelectorAll('img[src*="/image/"][src*="thumbnail"][style*="position: absolute"], img[src*="/scene/"][src*="thumbnail"][style*="position: absolute"], img[src*="/gallery/"][src*="thumbnail"][style*="position: absolute"]');
        
        // 批量处理，避免一次性处理太多
        let index = 0;
        const processBatch = () => {
          const batch = Array.from(wallImages).slice(index, index + CONFIG.BATCH_SIZE);
          batch.forEach(img => {
            // 排除网格卡片、墙视图、瀑布流增强视图和 Flexbin 图库中的图片
            //（这些容器已由 addHeartButton 处理，再次包装会破坏布局）
            if (!img.closest('.scene-card, .image-card, .gallery-card, .enhanced-wall-item, .wall-item, .flexbin')) {
              addHeartToWallImage(img);
            }
          });
          
          index += CONFIG.BATCH_SIZE;
          
          // 如果还有未处理的图片，继续下一批
          if (index < wallImages.length) {
            batchProcessTimeout = setTimeout(processBatch, CONFIG.BATCH_DELAY);
          } else {
            isScanning = false;
          }
        };
        
        if (wallImages.length > 0) {
          processBatch();
        } else {
          isScanning = false;
        }
      } catch (error) {
        console.error('扫描卡片时出错:', error);
        isScanning = false;
      }
    });
  }

  /**
   * 初始化
   */
  function init() {
    console.log('红心收藏功能已启动');
    
    // 延迟初始扫描，让页面先加载完成
    setTimeout(() => {
      scanAndProcessCards();
    }, 1000);
    
    // 定期扫描新卡片
    setInterval(scanAndProcessCards, CONFIG.CHECK_INTERVAL);
    
    // 使用MutationObserver监听DOM变化 - 优化配置减少触发
    const observer = new MutationObserver((mutations) => {
      // 忽略插件自身插入的按钮/包装容器引起的回调，避免无谓的重复扫描
      const hasRelevantAdd = mutations.some(m => {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList.contains('favorite-heart-actions')) continue;
          if (node.querySelector && node.querySelector('.scene-card, .image-card, .gallery-card, .wall-item, .wall-item-media, .enhanced-wall-item, .power-wall-item, img[src*="thumbnail"]')) return true;
          if (node.matches && node.matches('.scene-card, .image-card, .gallery-card, .wall-item, .wall-item-media, .enhanced-wall-item, .power-wall-item, img[src*="thumbnail"]')) return true;
        }
        return false;
      });
      if (!hasRelevantAdd) return;
      
      // 清除之前的定时器
      if (scanTimeout) {
        clearTimeout(scanTimeout);
      }
      
      // 如果正在批处理，先停止
      if (batchProcessTimeout) {
        clearTimeout(batchProcessTimeout);
        isScanning = false;
      }
      
      // 使用防抖，避免频繁触发
      scanTimeout = setTimeout(() => {
        scanAndProcessCards();
      }, CONFIG.DEBOUNCE_DELAY);
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // 监听瀑布流/砌墙插件添加的新卡片（EnhancedWallView / PowerWall 均派发此事件）
  document.addEventListener('enhancedWallItemAdded', (e) => {
    const { item, data, type } = e.detail;
    if (item && !processedCards.has(item)) {
      addHeartButton(item);
    }
  });

  // 等待页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('❤️ [FavoriteHeart] Stash 红心收藏功能插件已加载');
})();
