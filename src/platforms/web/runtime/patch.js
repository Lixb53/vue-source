/* @flow */

import * as nodeOps from 'web/runtime/node-ops'
import { createPatchFunction } from 'core/vdom/patch'
import baseModules from 'core/vdom/modules/index'
import platformModules from 'web/runtime/modules/index'

// the directive module should be applied last, after all
// built-in modules have been applied.

// 指令模块应该在所有模块被应用后最后应用
const modules = platformModules.concat(baseModules)

// patch 工厂函数, 为其传入平台特有的一些操作, 然后返回一个 patch 函数
/**
 * nodeOps: dom 的一些 api 操作
 * modules: attrs|class|styles 等等的一些处理方法
 */
export const patch: Function = createPatchFunction({ nodeOps, modules })
