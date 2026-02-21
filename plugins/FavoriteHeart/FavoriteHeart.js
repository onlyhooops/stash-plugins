/**
 * Stash 红心收藏功能插件 - JavaScript实现
 * Favorite Heart Plugin for Stash
 * 
 * 功能：为图片/图库/短片/演员/Group添加红心收藏按钮，点击后自动添加指定标签
 * 兼容：网格视图 & 预览墙视图 & 瀑布流增强视图
 * 
 * 参考文档：https://docs.stashapp.cc/in-app-manual/plugins/ui-plugin-api/
 */

(function() {
  'use strict';

  // 从 Stash 插件系统获取配置
  const getPluginConfig = () => {
    const defaultConfig = {
      favoriteTagName: '精选集',
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
        body: JSON.stringify({ query, variables }),
      });
      
      const result = await response.json();
      if (result.errors) {
        console.error('GraphQL错误:', result.errors);
        return null;
      }
      return result.data;
    } catch (error) {
      console.error('请求失败:', error);
      return null;
    }
  }

  /**
   * 获取或创建"精选集"标签
   */
  async function getFavoriteTag() {
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
   * 检查是否已收藏
   */
  async function checkIfFavorited(type, id) {
    let query;
    switch(type) {
      case 'scenes':
        query = `
          query FindScene($id: ID!) {
            findScene(id: $id) {
              tags { name }
            }
          }
        `;
        break;
      case 'images':
        query = `
          query FindImage($id: ID!) {
            findImage(id: $id) {
              tags { name }
            }
          }
        `;
        break;
      case 'galleries':
        query = `
          query FindGallery($id: ID!) {
            findGallery(id: $id) {
              tags { name }
            }
          }
        `;
        break;
      default:
        return false;
    }
    
    const result = await graphqlRequest(query, { id });
    const tags = result?.[`find${type.slice(0, -1).charAt(0).toUpperCase() + type.slice(1, -1)}`]?.tags || [];
    return tags.some(tag => tag.name === CONFIG.FAVORITE_TAG_NAME);
  }

  /**
   * 处理红心点击
   */
  async function handleHeartClick(event, button, card, cardInfo = null) {
    event.preventDefault();
    event.stopPropagation();
    
    const isFavorited = button.classList.contains('favorited');
    
    // 如果没有传入cardInfo，尝试提取
    if (!cardInfo) {
      cardInfo = extractIdFromCard(card);
    }
    
    if (!cardInfo) {
      console.error('无法提取卡片ID');
      return;
    }
    
    button.classList.add('loading');
    
    try {
      const tagId = await getFavoriteTag();
      if (!tagId) {
        alert('无法创建或获取"精选集"标签');
        return;
      }
      
      let success = false;
      
      if (!isFavorited) {
        // 添加收藏
        switch(cardInfo.type) {
          case 'scenes':
            success = await addTagToScene(cardInfo.id, tagId);
            break;
          case 'images':
            success = await addTagToImage(cardInfo.id, tagId);
            break;
          case 'galleries':
            success = await addTagToGallery(cardInfo.id, tagId);
            break;
        }
        
        if (success) {
          button.classList.add('favorited');
          // console.log('已添加到精选集:', cardInfo);
        }
      } else {
        // 取消收藏 - 移除标签
        switch(cardInfo.type) {
          case 'scenes':
            success = await removeTagFromScene(cardInfo.id, tagId);
            break;
          case 'images':
            success = await removeTagFromImage(cardInfo.id, tagId);
            break;
          case 'galleries':
            success = await removeTagFromGallery(cardInfo.id, tagId);
            break;
        }
        
        if (success) {
          button.classList.remove('favorited');
          // console.log('已从精选集移除:', cardInfo);
        }
      }
    } catch (error) {
      console.error('操作失败:', error);
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
    
    // 如果在"精选集"tag页面，直接标记为已收藏，不发送请求
    if (isInFavoriteTagPage()) {
      heartButton.classList.add('favorited');
    } else {
      // 延迟检查收藏状态，避免阻塞UI
      setTimeout(async () => {
        const isFavorited = await checkIfFavorited(cardInfo.type, cardInfo.id);
        if (isFavorited) {
          heartButton.classList.add('favorited');
        }
      }, 100);
    }
    
    // 添加点击事件
    heartButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleHeartClick(e, heartButton, wrapper, cardInfo);
    });
    
    wrapper.appendChild(heartButton);
  }

  /**
   * 为卡片添加红心按钮（延迟检查收藏状态）
   */
  async function addHeartButton(card) {
    if (processedCards.has(card)) return;
    processedCards.add(card);
    
    // 查找缩略图容器
    let thumbnailSection = card.querySelector('.thumbnail-section, .wall-item-container');
    
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
    
    // 检查是否已经添加过按钮
    if (thumbnailSection.querySelector('.favorite-heart-btn')) return;
    
    // 创建红心按钮
    const heartButton = document.createElement('button');
    heartButton.className = 'favorite-heart-btn';
    heartButton.title = '添加到精选集';
    heartButton.setAttribute('aria-label', '收藏');
    
    // 提取卡片信息
    const cardInfo = extractIdFromCard(card);
    
    // 如果在"精选集"tag页面，直接标记为已收藏
    if (isInFavoriteTagPage()) {
      heartButton.classList.add('favorited');
    } else if (cardInfo) {
      // 延迟检查收藏状态，避免阻塞UI
      setTimeout(async () => {
        const isFavorited = await checkIfFavorited(cardInfo.type, cardInfo.id);
        if (isFavorited) {
          heartButton.classList.add('favorited');
        }
      }, 100);
    }
    
    // 添加点击事件
    heartButton.addEventListener('click', (e) => handleHeartClick(e, heartButton, card));
    
    // 插入按钮 - 确保容器有正确的定位
    const currentPosition = window.getComputedStyle(thumbnailSection).position;
    if (currentPosition === 'static') {
      thumbnailSection.style.position = 'relative';
    }
    thumbnailSection.appendChild(heartButton);
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
            // 排除网格卡片和瀑布流增强视图中的图片（由 addHeartButton 处理 enhanced-wall-item）
            if (!img.closest('.scene-card, .image-card, .gallery-card, .enhanced-wall-item')) {
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

  // 监听瀑布流增强插件添加的新卡片
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
