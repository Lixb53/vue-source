/* @flow */

import config from '../config'
import { initProxy } from './proxy'
import { initState } from './state'
import { initRender } from './render'
import { initEvents } from './events'
import { mark, measure } from '../util/perf'
import { initLifecycle, callHook } from './lifecycle'
import { initProvide, initInjections } from './inject'
import { extend, mergeOptions, formatComponentName } from '../util/index'

let uid = 0

export function initMixin (Vue: Class<Component>) {
  // vue 的初始化过程
  Vue.prototype._init = function (options?: Object) {
    const vm: Component = this
    // a uid
    vm._uid = uid++

    let startTag, endTag
    // 初始化过程中的性能测量

    // 开始初始化的位置
    /* istanbul ignore if */
    if (process.env.NODE_ENV !== 'production' && config.performance && mark) {
      startTag = `vue-perf-start:${vm._uid}`
      endTag = `vue-perf-end:${vm._uid}`
      mark(startTag)
    }

    // a flag to avoid this being observed
    // 一个避免被观察到的标志
    vm._isVue = true
    // merge options
    if (options && options._isComponent) {
      // optimize internal component instantiation
      // since dynamic options merging is pretty slow, and none of the
      // internal component options needs special treatment.
      /**
       * 每个子组件初始化时走这里, 这里只做了一些性能优化
       * 将组件配置对象上的一些深层次属性放到 vm.$options 选项中, 以提高代码的执行率, 避免了原型链的动态查找
       */
      initInternalComponent(vm, options)
    } else {
      // 根组件走这里, 进行选项合并, 将全局配置选项合并到根组件的局部配置上
      // 组件选项合并, 发生在三个地方
      //    1. Vue.component(CompName, Comp), 做了选项合并, 合并的 Vue 内置的全局组件和用户自己注册的全局组件, 最终都会放到全局的components 选项中
      //    2. { components: { xxx } }, 子组件内部注册的组件, 局部注册, 执行编译器生成的 render 函数时做了选项合并, 会合并全局配置项到组件局部配置项上
      //    3. 这里的根组件的情况
      vm.$options = mergeOptions(
        resolveConstructorOptions(vm.constructor),
        options || {},
        vm
      )
    }
    /* istanbul ignore else */
    if (process.env.NODE_ENV !== 'production') {
      // 设置代理，将 vm 实例上的属性代理到 vm._renderProxy
      initProxy(vm)
    } else {
      vm._renderProxy = vm
    }
    // expose real self
    vm._self = vm
    // 组件关系属性的初始化, 比如: $parent, $root, $children
    initLifecycle(vm)
    // 初始化自定义事件
    initEvents(vm)
    // 初始化插槽, 获取this.$slots, 定义this._c 即createElement方法, 平时使用的  h 函数
    initRender(vm)
    // 执行beforeCreate 生命周期函数
    callHook(vm, 'beforeCreate')
    // 初始化 inject 选项, 得到 result[key] = val 形式的配置对象, 并做响应式处理, 并代理每个 key 到 vm 实例上
    initInjections(vm) // resolve injections before data/props
    // 响应式原理的核心, 处理 props methods computed data watch 等选项
    initState(vm)
    // 处理 provide 选项    
    initProvide(vm) // resolve provide after data/props
    callHook(vm, 'created')

    // 结束初始化
    /* istanbul ignore if */
    if (process.env.NODE_ENV !== 'production' && config.performance && mark) {
      vm._name = formatComponentName(vm, false)
      mark(endTag)
      measure(`vue ${vm._name} init`, startTag, endTag)
    }

    // 如果存在 el 选项, 则自动执行$mount
    if (vm.$options.el) {
      vm.$mount(vm.$options.el)
    }
  }
}

// 性能优化, 打平配置对象上的属性, 减少运行时原型链的查找, 提高效率
export function initInternalComponent (vm: Component, options: InternalComponentOptions) {
  // 基于 构造函数上的配置对象 创建 vm.$options
  const opts = vm.$options = Object.create(vm.constructor.options)
  // doing this because it's faster than dynamic enumeration.

  // 把配置对象上的属性拿出来赋值到 $options 上, 避免了原型链上的动态查找
  const parentVnode = options._parentVnode
  opts.parent = options.parent
  opts._parentVnode = parentVnode

  const vnodeComponentOptions = parentVnode.componentOptions
  opts.propsData = vnodeComponentOptions.propsData
  opts._parentListeners = vnodeComponentOptions.listeners
  opts._renderChildren = vnodeComponentOptions.children
  opts._componentTag = vnodeComponentOptions.tag

  // 如果有render函数, 将其赋值到$options
  if (options.render) {
    opts.render = options.render
    opts.staticRenderFns = options.staticRenderFns
  }
}

// 从构造函数上解析配置项
export function resolveConstructorOptions (Ctor: Class<Component>) {
  console.log(Ctor,'ctor')
  let options = Ctor.options
  // 如果构造函数上有super, 表示含有基类
  if (Ctor.super) {
    // 以递归的方式获取基类上的选项
    const superOptions = resolveConstructorOptions(Ctor.super)
    // 缓存
    const cachedSuperOptions = Ctor.superOptions
    if (superOptions !== cachedSuperOptions) {
      // 说明基类的配置项发生了更改
      // super option changed,
      // need to resolve new options.
      Ctor.superOptions = superOptions
      // check if there are any late-modified/attached options (#4976)
      // 找到更改的选项
      const modifiedOptions = resolveModifiedOptions(Ctor)
      // update base extend options
      if (modifiedOptions) {
        // 将更改的选项 和 extend 选项合并
        extend(Ctor.extendOptions, modifiedOptions)
      }
      // 将新的选项赋值给options
      options = Ctor.options = mergeOptions(superOptions, Ctor.extendOptions)
      if (options.name) {
        options.components[options.name] = Ctor
      }
    }
  }
  return options
}

function resolveModifiedOptions (Ctor: Class<Component>): ?Object {
  let modified
  const latest = Ctor.options
  const sealed = Ctor.sealedOptions
  for (const key in latest) {
    if (latest[key] !== sealed[key]) {
      if (!modified) modified = {}
      modified[key] = latest[key]
    }
  }
  return modified
}
