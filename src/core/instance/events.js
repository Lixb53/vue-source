/* @flow */

import {
  tip,
  toArray,
  hyphenate,
  formatComponentName,
  invokeWithErrorHandling
} from '../util/index'
import { updateListeners } from '../vdom/helpers/index'

export function initEvents (vm: Component) {
  vm._events = Object.create(null)
  vm._hasHookEvent = false
  // init parent attached events
  const listeners = vm.$options._parentListeners
  if (listeners) {
    updateComponentListeners(vm, listeners)
  }
}

let target: any

function add (event, fn) {
  target.$on(event, fn)
}

function remove (event, fn) {
  target.$off(event, fn)
}

function createOnceHandler (event, fn) {
  const _target = target
  return function onceHandler () {
    const res = fn.apply(null, arguments)
    if (res !== null) {
      _target.$off(event, onceHandler)
    }
  }
}

export function updateComponentListeners (
  vm: Component,
  listeners: Object,
  oldListeners: ?Object
) {
  target = vm
  updateListeners(listeners, oldListeners || {}, add, remove, createOnceHandler, vm)
  target = undefined
}

export function eventsMixin (Vue: Class<Component>) {
  const hookRE = /^hook:/
  /**
   * 监听实例上的自定义事件: vm._event = { eventName: [fn1, fn2, ...], ....}
   * @param {*} event 单个事件名称或者有多个事件名组成的数组
   * @param {*} fn 当 event 被触发时执行的回调函数
   * @returns 
   */
  Vue.prototype.$on = function (event: string | Array<string>, fn: Function): Component {
    const vm: Component = this
    if (Array.isArray(event)) {
      // 如果 event 是由多个事件名组成的数组, 则遍历这些事件, 依次递归调用 $on
      for (let i = 0, l = event.length; i < l; i++) {
        vm.$on(event[i], fn)
      }
    } else {
      // 将注册的事件和回调以键值对的形式存储到 vm._events 对象中, vm._events = {eventName: [fn1, fn2,....]}
      (vm._events[event] || (vm._events[event] = [])).push(fn)
      // optimize hook:event cost by using a boolean flag marked at registration
      // instead of a hash lookup
      // hookEvent, 提供从外部为组件实例注入声明周期方法的机会
      // 比如从外部为组件的 mounted 方法注入额外的逻辑
      // 该能力是结合 callhook 方法实现的
      if (hookRE.test(event)) {
        vm._hasHookEvent = true
      }
    }
    return vm
  }

  /**
   * 监听一个自定义事件, 但是只触发一次. 一旦触发之后, 监听器就会移除
   * @param {*} event 
   * @param {*} fn 
   * @returns 
   */
  Vue.prototype.$once = function (event: string, fn: Function): Component {
    const vm: Component = this
    // 调用 $on, 只是 $on 的回调函数被特殊处理了, 触发时, 执行回调函数, 先移除事件监听, 然后执行你设置的回调函数
    function on () {
      vm.$off(event, on)
      fn.apply(vm, arguments)
    }
    on.fn = fn
    vm.$on(event, on)
    return vm
  }

  // 移除自定义事件监听器, 即从 vm._even 对象中找到对应的事件, 移除所有事件 或者 移除指定时间的回调函数
  Vue.prototype.$off = function (event?: string | Array<string>, fn?: Function): Component {
    const vm: Component = this
    // all vm.$off() 移除实例上所有监听器 => vm._events = {}
    if (!arguments.length) {
      vm._events = Object.create(null)
      return vm
    }
    // array of events
    // 如果event 是一个数组, 遍历event数组, 递归调用$off
    if (Array.isArray(event)) {
      for (let i = 0, l = event.length; i < l; i++) {
        vm.$off(event[i], fn)
      }
      return vm
    }
    // specific event
    // 除了 vm.$off()外, 最终都会走到这里, 移除指定事件
    const cbs = vm._events[event]
    if (!cbs) {
      // 表示没有注册过事件
      return vm
    }
    if (!fn) {
      // 没有提供 fn 回调函数, 则移除该事件的所有回调函数, vm._events[event] = null
      vm._events[event] = null
      return vm
    }
    // specific handler
    // 移除指定事件的指定回调函数, 就是从事件的回调函数数组中找到该回调函数, 然后删除
    let cb
    let i = cbs.length
    while (i--) {
      cb = cbs[i]
      if (cb === fn || cb.fn === fn) {
        cbs.splice(i, 1)
        break
      }
    }
    return vm
  }

  /**
   * 触发 Vue 实例上的指定事件, vm._events[event] => cbs => look cbs => cbs(args)
   * @param {*} event 事件名
   * @returns 
   */
  Vue.prototype.$emit = function (event: string): Component {
    const vm: Component = this
    if (process.env.NODE_ENV !== 'production') {
      const lowerCaseEvent = event.toLowerCase()
      // 将事件名转换为小写
      if (lowerCaseEvent !== event && vm._events[lowerCaseEvent]) {
        // 意思是说, HTML 属性不区分大小写, 所以你不能使用 v-on 监听小驼峰形式的事件名(eventName), 更应该使用连字符形式的事件名(event-name)
        tip(
          `Event "${lowerCaseEvent}" is emitted in component ` +
          `${formatComponentName(vm)} but the handler is registered for "${event}". ` +
          `Note that HTML attributes are case-insensitive and you cannot use ` +
          `v-on to listen to camelCase events when using in-DOM templates. ` +
          `You should probably use "${hyphenate(event)}" instead of "${event}".`
        )
      }
    }
    // 从 vm._events 对象上拿到当前事件的回调函数数组, 并依次调用数组中的回调函数, 并且传递提供的参数
    let cbs = vm._events[event]
    if (cbs) {
      cbs = cbs.length > 1 ? toArray(cbs) : cbs
      const args = toArray(arguments, 1)
      const info = `event handler for "${event}"`
      for (let i = 0, l = cbs.length; i < l; i++) {
        invokeWithErrorHandling(cbs[i], vm, args, vm, info)
      }
    }
    return vm
  }
}
