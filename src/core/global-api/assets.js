/* @flow */

import { ASSET_TYPES } from 'shared/constants'
import { isPlainObject, validateComponentName } from '../util/index'

/*
 * 定义 Vue.component, Vue.directive, Vue.filter 三个方法
 * 这三个方法都是在 this.options.xx 上存放对应的配置
 * 例: Vue.component(compName, {xx}) 结果是: this.options.components.compName = 组件构造函数
 */
export function initAssetRegisters (Vue: GlobalAPI) {
  /**
   * Create asset registration methods.
   */
  ASSET_TYPES.forEach(type => {
    Vue[type] = function (
      id: string,
      definition: Function | Object
    ): Function | Object | void {
      if (!definition) {
        return this.options[type + 's'][id]
      } else {
        /* istanbul ignore if */
        if (process.env.NODE_ENV !== 'production' && type === 'component') {
          validateComponentName(id)
        }
        if (type === 'component' && isPlainObject(definition)) {
          // 如果组件中存在 name 就使用 name, 否则使用 id
          definition.name = definition.name || id
          // extend 就是 Vue.extend, 所以这时的 definition 就变成了 组件构造函数, 使用时可直接 new Definition()
          definition = this.options._base.extend(definition)
        }
        if (type === 'directive' && typeof definition === 'function') {
          definition = { bind: definition, update: definition }
        }
        // this.options.components[id] = definition
        // 在实例化时通过 mergeOptions 将全局注册的组件合并到每个组件的配置对象的 components 中
        this.options[type + 's'][id] = definition
        return definition
      }
    }
  })
}
