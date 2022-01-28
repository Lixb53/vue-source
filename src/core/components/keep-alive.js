/* @flow */

import { isRegExp, remove } from 'shared/util'
import { getFirstComponentChild } from 'core/vdom/helpers/index'

type CacheEntry = {
  name: ?string;
  tag: ?string;
  componentInstance: Component;
};

type CacheEntryMap = { [key: string]: ?CacheEntry };

function getComponentName (opts: ?VNodeComponentOptions): ?string {
  return opts && (opts.Ctor.options.name || opts.tag)
}

function matches (pattern: string | RegExp | Array<string>, name: string): boolean {
  if (Array.isArray(pattern)) {
    return pattern.indexOf(name) > -1
  } else if (typeof pattern === 'string') {
    return pattern.split(',').indexOf(name) > -1
  } else if (isRegExp(pattern)) {
    return pattern.test(name)
  }
  /* istanbul ignore next */
  return false
}

function pruneCache (keepAliveInstance: any, filter: Function) {
  const { cache, keys, _vnode } = keepAliveInstance
  for (const key in cache) {
    // 从缓存对象中拿到对应的缓存组件对象
    const entry: ?CacheEntry = cache[key]
    if (entry) {
      const name: ?string = entry.name
      if (name && !filter(name)) {
        // 如果当前缓存组件对象不存在 include/exclude 中, 则删除
        pruneCacheEntry(cache, key, keys, _vnode)
      }
    }
  }
}

function pruneCacheEntry (
  cache: CacheEntryMap,
  key: string,
  keys: Array<string>,
  current?: VNode
) {
  const entry: ?CacheEntry = cache[key]
  if (entry && (!current || entry.tag !== current.tag)) {
    entry.componentInstance.$destroy()
  }
  cache[key] = null
  remove(keys, key)
}

const patternTypes: Array<Function> = [String, RegExp, Array]

export default {
  name: 'keep-alive',
  abstract: true,

  props: {
    include: patternTypes,
    exclude: patternTypes,
    max: [String, Number]
  },

  methods: {
    cacheVNode() {
      const { cache, keys, vnodeToCache, keyToCache } = this
      if (vnodeToCache) {
        const { tag, componentInstance, componentOptions } = vnodeToCache
        // 缓存组件对象
        cache[keyToCache] = {
          name: getComponentName(componentOptions),
          tag,
          componentInstance,
        }
        keys.push(keyToCache)
        // prune oldest entry
        if (this.max && keys.length > parseInt(this.max)) {
          // 超过缓存限制, 将第一个删除
          pruneCacheEntry(cache, keys[0], keys, this._vnode)
        }
        this.vnodeToCache = null
      }
    }
  },

  created () {
    // 缓存 Vnode
    this.cache = Object.create(null)
    // 缓存的 Vnode 的 key的集合
    this.keys = []
  },

  destroyed () {
    for (const key in this.cache) {
      // 循环调用 pruneCacheEntry函数删除所有缓存的 key
      pruneCacheEntry(this.cache, key, this.keys)
    }
  },

  mounted () {
    this.cacheVNode()
    // 实时监听 黑/白 名单的变动
    this.$watch('include', val => {
      // pruneCache 的 核心也是调用 pruneCacheEntry
      pruneCache(this, name => matches(val, name))
    })
    this.$watch('exclude', val => {
      pruneCache(this, name => !matches(val, name))
    })
  },

  updated () {
    this.cacheVNode()
  },

  /**
   * 1. 获取 keep-alive 包裹着的第一个子组件对象及其名
   * 2. 根据设定的 黑/白 名单(如果有)进行条件匹配, 决定是否缓存, 不匹配, 直接返回 Vnode, 否则执行第三步
   * 3. 根据组件 ID 和 tag 生成缓存 key, 并在缓存对象中查找是否已经缓存过该组件实例, 如果存在, 直接去除缓存值并更新该 key 在 this.keys 中的位置(更新 key 的位置是实现 LRU 置换策略的关键), 否则执行第四步
   * 4. 在 this.keys 中存储该组件实例并保存 key 值, 之后检查缓存的实例数量是否超过 max 值, 超过则根据 LRU 置换策略删除最近最久未使用的实例
   * 5. 将该组件实例的 KeepAlive 设为 true
   * @returns 
   */
  render () {
    const slot = this.$slots.default
    // 找打第一个子组件对象
    const vnode: VNode = getFirstComponentChild(slot)
    // 拿到组件参数
    const componentOptions: ?VNodeComponentOptions = vnode && vnode.componentOptions
    if (componentOptions) {
      // check pattern
      // 拿到组件参数中组件的名称
      const name: ?string = getComponentName(componentOptions)
      const { include, exclude } = this
      // 如果 include 中不存在 || exclude 中存在, 则直接返回 Vnode, 不缓存
      if (
        // not included
        (include && (!name || !matches(include, name))) ||
        // excluded
        (exclude && name && matches(exclude, name))
      ) {
        return vnode
      }

      const { cache, keys } = this
      // 定义组件的缓存 key
      const key: ?string = vnode.key == null
        // same constructor may get registered as different local components
        // so cid alone is not enough (#3269)
        ? componentOptions.Ctor.cid + (componentOptions.tag ? `::${componentOptions.tag}` : '')
        : vnode.key
      // 如果组件已经缓存过
      if (cache[key]) {
        vnode.componentInstance = cache[key].componentInstance
        // make current key freshest
        remove(keys, key)
        // 调整 key 排序
        keys.push(key)
      } else {
        // delay setting the cache until update
        this.vnodeToCache = vnode
        this.keyToCache = key
      }

      // 将组件实例的 keepAlive 设置为 true
      vnode.data.keepAlive = true
    }
    return vnode || (slot && slot[0])
  }
}
