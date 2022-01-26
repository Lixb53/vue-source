/* @flow */

import VNode from './vnode'
import { resolveConstructorOptions } from 'core/instance/init'
import { queueActivatedComponent } from 'core/observer/scheduler'
import { createFunctionalComponent } from './create-functional-component'

import {
  warn,
  isDef,
  isUndef,
  isTrue,
  isObject
} from '../util/index'

import {
  resolveAsyncComponent,
  createAsyncPlaceholder,
  extractPropsFromVNodeData
} from './helpers/index'

import {
  callHook,
  activeInstance,
  updateChildComponent,
  activateChildComponent,
  deactivateChildComponent
} from '../instance/lifecycle'

import {
  isRecyclableComponent,
  renderRecyclableComponentTemplate
} from 'weex/runtime/recycle-list/render-component-template'

// path 期间在组件 vnode 上调用内联钩子
// inline hooks to be invoked on component VNodes during patch
const componentVNodeHooks = {
  // 初始化
  init (vnode: VNodeWithData, hydrating: boolean): ?boolean {
    if (
      vnode.componentInstance &&
      !vnode.componentInstance._isDestroyed &&
      vnode.data.keepAlive
    ) {
      // 将 keep-alive 包裹的组件
      // kept-alive components, treat as a patch
      const mountedNode: any = vnode // work around flow
      componentVNodeHooks.prepatch(mountedNode, mountedNode)
    } else {
      // 创建组件实例, 即 new Vnode.componentOptions.Ctor(optiosn) => 得到 Vue 组件实例
      const child = vnode.componentInstance = createComponentInstanceForVnode(
        vnode,
        activeInstance
      )
      // 执行组件的 $mount 方法, 进入挂载阶段, 接下来就是通过编译器得到 render 函数, 接着走挂载, patch 这条路, 知道组件渲染到页面
      child.$mount(hydrating ? vnode.elm : undefined, hydrating)
    }
  },

  // 更新 Vnode, 用新的 Vnode 配置更新旧的 Vnode 上的各种属性
  prepatch (oldVnode: MountedComponentVNode, vnode: MountedComponentVNode) {
    // 新配置项
    const options = vnode.componentOptions
    // 老的配置项
    const child = vnode.componentInstance = oldVnode.componentInstance
    // 用 vnode 上的属性更新 child 上的各种属性
    updateChildComponent(
      child,
      options.propsData, // updated props
      options.listeners, // updated listeners
      vnode, // new parent vnode
      options.children // new children
    )
  },

  // 执行组件的 mounted 生命周期钩子
  insert (vnode: MountedComponentVNode) {
    const { context, componentInstance } = vnode
    // 如果组件为挂载, 则调用 mounted 生命周期钩子
    if (!componentInstance._isMounted) {
      componentInstance._isMounted = true
      callHook(componentInstance, 'mounted')
    }
    // 处理 keep-alive 组件的异常情况
    if (vnode.data.keepAlive) {
      if (context._isMounted) {
        // vue-router#1212
        // During updates, a kept-alive component's child components may
        // change, so directly walking the tree here may call activated hooks
        // on incorrect children. Instead we push them into a queue which will
        // be processed after the whole patch process ended.
        queueActivatedComponent(componentInstance)
      } else {
        activateChildComponent(componentInstance, true /* direct */)
      }
    }
  },

  /**
   * 销毁组件
   * 1. 如果组件被 keep-alive 包裹, 则使组件失活, 不销毁组件实例, 从而缓存组件的状态
   * 2. 如果组件没有被 keep-alive 包裹, 则直接调用实例的 $destroy 方法销毁㢟
   * @param {*} vnode 
   */
  destroy (vnode: MountedComponentVNode) {
    // 从 Vnode 上获取组件实例
    const { componentInstance } = vnode
    if (!componentInstance._isDestroyed) {
      // 如果组件实例没有被销毁
      if (!vnode.data.keepAlive) {
        // 组件没有被 keep-alive 包裹, 则直接调用 $destroy 销毁组件
        componentInstance.$destroy()
      } else {
        // 负责让组件失活, 不销毁组件实例, 从而缓存组件的方法
        deactivateChildComponent(componentInstance, true /* direct */)
      }
    }
  }
}

const hooksToMerge = Object.keys(componentVNodeHooks)


/**
 * 创建组建的 Vnode
 * 1. 函数式组件通过执行其 render 函数生成 Vnode
 * 2. 普通组件通过 new Vnode() 生成其 Vnode, 但是普通组件有一个重要操作是在 data.hook 对象中添加 4 个钩子函数, 分别是 init, prepath, insert, destroy, 在组件的 patch 阶段会被调用
 * 比如 init 方法, 调用时会进入子组件实例的创建挂载阶段, 知道完成渲染
 * @param {*} Ctor 组件构造函数
 * @param {*} data 属性组成的 JSON 字符串
 * @param {*} context 上下文
 * @param {*} children 子节点数组
 * @param {*} tag 标签名
 * @returns Vnode or Array<Vnode>
 */
export function createComponent (
  Ctor: Class<Component> | Function | Object | void,
  data: ?VNodeData,
  context: Component,
  children: ?Array<VNode>,
  tag?: string
): VNode | Array<VNode> | void {
  // 组件构造函数不存在, 直接返回
  if (isUndef(Ctor)) {
    return
  }

  // Vue.extend()
  const baseCtor = context.$options._base

  // 当 Ctor 为配置对象时, 通过 Vue.exted 将其转为构造函数
  // plain options object: turn it into a constructor
  if (isObject(Ctor)) {
    Ctor = baseCtor.extend(Ctor)
  }

  // 如果到这里 Ctor 还不是一个函数, 表示这是一个无效的组件
  // if at this stage it's not a constructor or an async component factory,
  // reject.
  if (typeof Ctor !== 'function') {
    if (process.env.NODE_ENV !== 'production') {
      warn(`Invalid Component definition: ${String(Ctor)}`, context)
    }
    return
  }

  // async component
  // 动态组件
  let asyncFactory
  if (isUndef(Ctor.cid)) {
    asyncFactory = Ctor
    Ctor = resolveAsyncComponent(asyncFactory, baseCtor)
    if (Ctor === undefined) {
      // return a placeholder node for async component, which is rendered
      // as a comment node but preserves all the raw information for the node.
      // the information will be used for async server-rendering and hydration.
      // 为异步组件返回一个占位符节点, 组件被渲染为注释节点, 但保留了节点的所有原始信息, 这些信息昂用于异步服务器渲染和 hydration
      return createAsyncPlaceholder(
        asyncFactory,
        data,
        context,
        children,
        tag
      )
    }
  }

  data = data || {}

  // 这里其实就是做组件选项合并的地方, 即编译器将组件编译为渲染函数, 渲染时执行 render 函数, 然后执行其中的 _c, 就会走到这里
  // 如果创建组件构造函数后应用全局minxin, 则解析构造函数选项
  // resolve constructor options in case global mixins are applied after
  // component constructor creation
  resolveConstructorOptions(Ctor)

  // 将组件的 v-mode 的信息(值和回调) 转换为 data.attrs 对象的属性、值和 data.on 对象上的时事件、回调
  // transform component v-model data into props & events
  if (isDef(data.model)) {
    transformModel(Ctor.options, data)
  }

  // 抽取 props 数据, 得到 propsData 对象, propsData[key] = val
  // 已组建 props 配置中的属性为 key, 父组件中对应的数据为 val
  // extract props
  const propsData = extractPropsFromVNodeData(data, Ctor, tag)

  // 函数式组件
  // functional component
  if (isTrue(Ctor.options.functional)) {
    return createFunctionalComponent(Ctor, propsData, data, context, children)
  }

  // 提取事件监听器对象 data.on, 因为这些监听器需要作为子组件监听器处理, 而不是 DOM 监听器
  // extract listeners, since these needs to be treated as
  // child component listeners instead of DOM listeners
  const listeners = data.on
  // replace with listeners with .native modifier
  // so it gets processed during parent component patch.
  // 用 .natvie 修饰符替换监听器, 以便在父组件补丁期间处理它
  // 将带有 .native 修饰符的事件对象赋值给 data.on
  data.on = data.nativeOn

  if (isTrue(Ctor.options.abstract)) {
    // 如果是抽象组件, 则只保留 props, listeners, slot
    // abstract components do not keep anything
    // other than props & listeners & slot

    // work around flow
    const slot = data.slot
    data = {}
    if (slot) {
      data.slot = slot
    }
  }

  /**
   * 在组件的 data 对象上设置 hook 对象, 
   * hook 对象增加四个属性, init, prepatch, insert, destroy
   * 负责组建的创建, 更新, 销毁, 这些方法在组件的 patch 阶段被调用
   */
  // install component management hooks onto the placeholder node
  installComponentHooks(data)

  // return a placeholder vnode
  const name = Ctor.options.name || tag
  // 实例化组件的 Vnode, 对于普通组件的标签名会比较特殊, vue-component-${cid}-${name}
  const vnode = new VNode(
    `vue-component-${Ctor.cid}${name ? `-${name}` : ''}`,
    data, undefined, undefined, undefined, context,
    { Ctor, propsData, listeners, tag, children },
    asyncFactory
  )

  // Weex specific: invoke recycle-list optimized @render function for
  // extracting cell-slot template.
  // https://github.com/Hanks10100/weex-native-directive/tree/master/component
  /* istanbul ignore if */
  if (__WEEX__ && isRecyclableComponent(vnode)) {
    return renderRecyclableComponentTemplate(vnode)
  }

  return vnode
}

/**
 * new vnode.componentOptions.Ctor(options) => 得到 Vue 组件实例 
 */
export function createComponentInstanceForVnode (
  // we know it's MountedComponentVNode but flow doesn't
  vnode: any,
  // activeInstance in lifecycle state
  parent: any
): Component {
  const options: InternalComponentOptions = {
    _isComponent: true,
    _parentVnode: vnode,
    parent
  }
  // check inline-template render functions
  // 检查内联模板渲染函数
  const inlineTemplate = vnode.data.inlineTemplate
  if (isDef(inlineTemplate)) {
    options.render = inlineTemplate.render
    options.staticRenderFns = inlineTemplate.staticRenderFns
  }
  return new vnode.componentOptions.Ctor(options)
}

/**
 * 在组件的 data 对象上设置 hook 对象
 * hook 对象增加四个属性, init, prepatch, insert, destroy
 * 负责组件的创建, 更新, 销毁
 * @param {*} data 
 */
function installComponentHooks (data: VNodeData) {
  const hooks = data.hook || (data.hook = {})
  //  遍历 hooksToMerge 数组，hooksToMerge = ['init', 'prepatch', 'insert' 'destroy']
  for (let i = 0; i < hooksToMerge.length; i++) {
    const key = hooksToMerge[i]
    const existing = hooks[key]
    const toMerge = componentVNodeHooks[key]
    // 合并用户传递的 hook 方法和框架自带的 hook 方法，其实就是分别执行两个方法
    if (existing !== toMerge && !(existing && existing._merged)) {
      hooks[key] = existing ? mergeHook(toMerge, existing) : toMerge
    }
  }
}

function mergeHook (f1: any, f2: any): Function {
  const merged = (a, b) => {
    // flow complains about extra args which is why we use any
    f1(a, b)
    f2(a, b)
  }
  merged._merged = true
  return merged
}

// transform component v-model info (value and callback) into
// prop and event handler respectively.
/**
 * 将组件 v-model 的信息(值和回调) 转换为 data.attrs 对象的属性, 值 和 data.on 对象上的事件, 回调
 * @param {*} options 
 * @param {*} data 
 */
function transformModel (options, data: any) {
  // model 的属性和事件, 默认为 value 和 input
  const prop = (options.model && options.model.prop) || 'value'
  const event = (options.model && options.model.event) || 'input'
  // 在 data.attrs 对象上存储 v-model 的值
  ;(data.attrs || (data.attrs = {}))[prop] = data.model.value
  //  在 data.on 对象上存储 v-model 的事件
  const on = data.on || (data.on = {})
  // 已存在的事件回调函数
  const existing = on[event]
  // v-model 中对应的事件回调函数
  const callback = data.model.callback
  // 合并回调函数
  if (isDef(existing)) {
    if (
      Array.isArray(existing)
        ? existing.indexOf(callback) === -1
        : existing !== callback
    ) {
      on[event] = [callback].concat(existing)
    }
  } else {
    on[event] = callback
  }
}
