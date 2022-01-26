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
    if (installedPlugins.indexOf(plugin) > -1) {
      return this
    }

    // additional parameters
    const args = toArray(arguments, 1)
    args.unshift(this)
    if (typeof plugin.install === 'function') {
      plugin.install.apply(plugin, args)
    } else if (typeof plugin === 'function') {
      plugin.apply(null, args)
    }
    installedPlugins.push(plugin)
    return this
  }
}
