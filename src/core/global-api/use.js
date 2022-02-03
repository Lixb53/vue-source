/* @flow */

import { toArray } from '../util/index'

/**
 * 定义 Vue.use, 负责为 Vue 安装插件, 做了一下两件事:
 *  1. 判断插件是否已经安装,如果安装直接结束
 *  2. 安装插件, 执行插件的 install 方法
 */
export function initUse (Vue: GlobalAPI) {
  Vue.use = function (plugin: Function | Object) {
    const installedPlugins = (this._installedPlugins || (this._installedPlugins = []))
    // 如果已经存在, 则直接返回 this(Vue)
    if (installedPlugins.indexOf(plugin) > -1) {
      return this
    }

    // additional parameters
    // 额外的参数
    const args = toArray(arguments, 1)
    // 把 this(Vue) 作为数组的第一项
    args.unshift(this)
    // 如果插件的 install 属性是函数, 调用它
    if (typeof plugin.install === 'function') {
      plugin.install.apply(plugin, args)
    } else if (typeof plugin === 'function') {
      // 如果插件是函数, 则调用它
      // apply(null) 严格模式下, plugin 插件函数的 this 是null
      plugin.apply(null, args)
    }
    // 添加到已安装的插件
    installedPlugins.push(plugin)
    return this
  }
}
