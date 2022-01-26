/* @flow */

import config from '../config'
import { initUse } from './use'
import { initMixin } from './mixin'
import { initExtend } from './extend'
import { initAssetRegisters } from './assets'
import { set, del } from '../observer/index'
import { ASSET_TYPES } from 'shared/constants'
import builtInComponents from '../components/index'
import { observe } from 'core/observer/index'

import {
  warn,
  extend,
  nextTick,
  mergeOptions,
  defineReactive
} from '../util/index'

// 初始化 vue 的全局 API 
export function initGlobalAPI (Vue: GlobalAPI) {
  // config
  const configDef = {}
  // vue 的众多默认配置项
  configDef.get = () => config
  if (process.env.NODE_ENV !== 'production') {
    configDef.set = () => {
      warn(
        'Do not replace the Vue.config object, set individual fields instead.'
      )
    }
  }
  // 将默认配置映射到 vue 上, vue.config
  Object.defineProperty(Vue, 'config', configDef)

  // exposed util methods.
  // NOTE: these are not considered part of the public API - avoid relying on
  // them unless you are aware of the risk.
  // 暴露一些工具方法, 轻易不要使用这些工具方法, 除非很清楚这些工具方法, 以及知道使用的风险
  Vue.util = {
    // 警告
    warn,
    // 类似选项合并
    extend,
    // 选项合并
    mergeOptions,
    // 设置响应式
    defineReactive
  }

  Vue.set = set
  Vue.delete = del
  Vue.nextTick = nextTick

  // 2.6 explicit observable API
  // 响应式方法
  Vue.observable = <T>(obj: T): T => {
    observe(obj)
    return obj
  }

  Vue.options = Object.create(null)
  // vue.options.components|directives|filters
  ASSET_TYPES.forEach(type => {
    Vue.options[type + 's'] = Object.create(null)
  })

  // this is used to identify the "base" constructor to extend all plain-object
  // components with in Weex's multi-instance scenarios.
  // 将 Vue 构造函数挂载到 Vue.options._base 上
  Vue.options._base = Vue

  // 在 Vue.options.components 中添加内置组件, 比如keep-alive
  extend(Vue.options.components, builtInComponents)

  initUse(Vue)
  initMixin(Vue)
  initExtend(Vue)
  initAssetRegisters(Vue)
}
