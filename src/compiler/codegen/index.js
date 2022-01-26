/* @flow */

import { genHandlers } from './events'
import baseDirectives from '../directives/index'
import { camelize, no, extend } from 'shared/util'
import { baseWarn, pluckModuleFunction } from '../helpers'
import { emptySlotScopeToken } from '../parser/index'

type TransformFunction = (el: ASTElement, code: string) => string;
type DataGenFunction = (el: ASTElement) => string;
type DirectiveFunction = (el: ASTElement, dir: ASTDirective, warn: Function) => boolean;

export class CodegenState {
  options: CompilerOptions;
  warn: Function;
  transforms: Array<TransformFunction>;
  dataGenFns: Array<DataGenFunction>;
  directives: { [key: string]: DirectiveFunction };
  maybeComponent: (el: ASTElement) => boolean;
  onceId: number;
  staticRenderFns: Array<string>;
  pre: boolean;

  constructor (options: CompilerOptions) {
    this.options = options
    this.warn = options.warn || baseWarn
    this.transforms = pluckModuleFunction(options.modules, 'transformCode')
    this.dataGenFns = pluckModuleFunction(options.modules, 'genData')
    this.directives = extend(extend({}, baseDirectives), options.directives)
    const isReservedTag = options.isReservedTag || no
    this.maybeComponent = (el: ASTElement) => !!el.component || !isReservedTag(el.tag)
    this.onceId = 0
    this.staticRenderFns = []
    this.pre = false
  }
}

export type CodegenResult = {
  render: string,
  staticRenderFns: Array<string>
};

/**
 * 从 AST 生成渲染函数
 */
export function generate (
  ast: ASTElement | void,
  options: CompilerOptions
): CodegenResult {
  // 实例化 CodegenState, 最终得到跟 options 类似的对象, 生成代码的时候需要用到中的一些东西
  const state = new CodegenState(options)
  // fix #11483, Root level <script> tags should not be rendered.
  const code = ast ? (ast.tag === 'script' ? 'null' : genElement(ast, state)) : '_c("div")'
  return {
    render: `with(this){return ${code}}`,
    staticRenderFns: state.staticRenderFns
  }
}

// returns: _c(tag, data, children, nomalizationsType)
export function  genElement (el: ASTElement, state: CodegenState): string {
  if (el.parent) {
    el.pre = el.pre || el.parent.pre
  }

  if (el.staticRoot && !el.staticProcessed) {
    /**
     * 生成静态节点, 生成节点的渲染函数
     *  1. 将当前静态节点的渲染函数放到 staticRenderFns 数组中
     *  2. 返回一个可执行函数 _m(idx, true or '')
     */
    return genStatic(el, state)
  } else if (el.once && !el.onceProcessed) {
    /**
     * 处理带有 v-once 指令的节点, 结果会有三中:
     *  1. 当前节点存在 v-if 指令, 得到一个三元表达式: condition ? render1 : render2
     *  2. 当前节点是一个包含在 v-for 指令内部的静态节点, 得到 _o(_c(tag, data, children, nomalizationsType), number, key)
     *  3. 当前节点就是一个单纯的 v-once 节点, 得到 _m(idx, true or '')
     */
    return genOnce(el, state)
  } else if (el.for && !el.forProcessed) {
    /**
     * 处理节点上的 v-for 指令, 得到:
     * _l((exp), funciton(alias, iterator1, ...){ return _c(tag, data, children)})
     */
    return genFor(el, state)
  } else if (el.if && !el.ifProcessed) {
    return genIf(el, state)
  } else if (el.tag === 'template' && !el.slotTarget && !state.pre) {
    // [_c(tag, data, children, nomalizationType), ...]
    return genChildren(el, state) || 'void 0'
  } else if (el.tag === 'slot') {
    /**
     * 生成插槽的渲染函数, 得到 _t(slotName, children, attrs, bind)
     */
    return genSlot(el, state)
  } else {
    // 自定义组件和原生标签走这里
    // component or element
    let code
    if (el.component) {
      // 处理动态组件，生成动态组件的渲染函数
      // 得到: _c(compName, data, children)
      code = genComponent(el.component, el, state)
    } else {
      let data
      if (!el.plain || (el.pre && state.maybeComponent(el))) {
        // 最终结果是一个 JSON 字符串
        data = genData(el, state)
      }

      // 处理子节点, 将得到的所有子节点字符串格式的代码组成的数组, 格式:
      // `['_c(tag, data, children)', ...],normalizatioinType`
      // 最后的nomalizationType 表示节点的规范化类型(0 | 1 | 2)
      const children = el.inlineTemplate ? null : genChildren(el, state, true)
      // 得到最终的字符串格式的代码: 格式:
      // '_c(tag, data, children, normalizationType)'
      code = `_c('${el.tag}'${
        data ? `,${data}` : '' // data
      }${
        children ? `,${children}` : '' // children
      })`
    }
    // 如果提供了 transformCode 方法, 则最终的 code 会经过各个模块 (module) 该方法处理
    // 不过框架最终没有提供该方法, 不过即使处理了, 最终的格式也是 _c(tag, data, children)
    // module transforms
    for (let i = 0; i < state.transforms.length; i++) {
      code = state.transforms[i](el, code)
    }
    return code
  }
}

// hoist static sub-trees out
// returns: _m(idx, true or '')
function genStatic (el: ASTElement, state: CodegenState): string {
  el.staticProcessed = true
  // Some elements (templates) need to behave differently inside of a v-pre
  // node.  All pre nodes are static roots, so we can use this as a location to
  // wrap a state change and reset it upon exiting the pre node.
  const originalPreState = state.pre
  if (el.pre) {
    state.pre = el.pre
  }
  state.staticRenderFns.push(`with(this){return ${genElement(el, state)}}`)
  state.pre = originalPreState
  return `_m(${
    state.staticRenderFns.length - 1
  }${
    el.staticInFor ? ',true' : ''
  })`
}

// v-once
// returns: 
//  1. el.if && !el.ifProcessed  返回 _m(idx, true or '') || _e()
//  2. el.staticInfor == true  && key ? _o(_c(tag, data, children, nomalizatinosType)) : _c(tag, data, children, nomalizationsType)
//  3. 1 & 2 都不满足, 直接返回 _m(idx, true or '')
function genOnce (el: ASTElement, state: CodegenState): string {
  el.onceProcessed = true
  if (el.if && !el.ifProcessed) {
    // _m(idx, true or '')
    return genIf(el, state)
  } else if (el.staticInFor) { 
    let key = ''
    let parent = el.parent
    while (parent) {
      if (parent.for) {
        key = parent.key
        break
      }
      parent = parent.parent
    }
    if (!key) {
      process.env.NODE_ENV !== 'production' && state.warn(
        `v-once can only be used inside v-for that is keyed. `,
        el.rawAttrsMap['v-once']
      )
      return genElement(el, state)
    }
    return `_o(${genElement(el, state)},${state.onceId++},${key})`
  } else {
    return genStatic(el, state)
  }
}

export function genIf (
  el: any,
  state: CodegenState,
  altGen?: Function,
  altEmpty?: string
): string {
  el.ifProcessed = true // avoid recursion
  return genIfConditions(el.ifConditions.slice(), state, altGen, altEmpty)
}

// returns _e() || _m() || _c()
function genIfConditions (
  conditions: ASTIfConditions,
  state: CodegenState,
  altGen?: Function,
  altEmpty?: string
): string {
  if (!conditions.length) {
    return altEmpty || '_e()'
  }

  const condition = conditions.shift()
  if (condition.exp) {
    return `(${condition.exp})?${
      genTernaryExp(condition.block)
    }:${
      genIfConditions(conditions, state, altGen, altEmpty)
    }`
  } else {
    return `${genTernaryExp(condition.block)}`
  }

  // v-if with v-once should generate code like (a)?_m(0):_m(1)
  function genTernaryExp (el) {
    return altGen
      ? altGen(el, state)
      : el.once
        ? genOnce(el, state)
        : genElement(el, state) //_c(tag, data, children)
  }
}

// returns _l((exp), function(alias, iterator1, ...) {return _c(tag, data, children, nomalizationsType)})
export function genFor (
  el: any,
  state: CodegenState,
  altGen?: Function,
  altHelper?: string
): string {
  const exp = el.for
  const alias = el.alias
  const iterator1 = el.iterator1 ? `,${el.iterator1}` : ''
  const iterator2 = el.iterator2 ? `,${el.iterator2}` : ''

  if (process.env.NODE_ENV !== 'production' &&
    state.maybeComponent(el) &&
    el.tag !== 'slot' &&
    el.tag !== 'template' &&
    !el.key
  ) {
    state.warn(
      `<${el.tag} v-for="${alias} in ${exp}">: component lists rendered with ` +
      `v-for should have explicit keys. ` +
      `See https://vuejs.org/guide/list.html#key for more info.`,
      el.rawAttrsMap['v-for'],
      true /* tip */
    )
  }

  el.forProcessed = true // avoid recursion
  return `${altHelper || '_l'}((${exp}),` +
    `function(${alias}${iterator1}${iterator2}){` +
      `return ${(altGen || genElement)(el, state)}` +
    '})'
}

export function genData (el: ASTElement, state: CodegenState): string {
  let data = '{'

  // 首先是指令。
  // 指令可能会在生成el的其他属性之前对其进行改动。
  // directives first.
  // directives may mutate the el's other properties before they are generated.
  // 得到: data = '{directives: [{name, rawName, value, expression, arg, modifiers}],}'
  const dirs = genDirectives(el, state)
  if (dirs) data += dirs + ','

  // key
  if (el.key) {
    data += `key:${el.key},`
  }
  // ref
  if (el.ref) {
    data += `ref:${el.ref},`
  }
  // 带有 ref 属性的节点如果被包裹在带有 v-for 指令的节点的内部时, 得到 data = { refInFor: true }
  if (el.refInFor) {
    data += `refInFor:true,`
  }
  // pre
  if (el.pre) {
    data += `pre:true,`
  }
  // record original tag name for components using "is" attribute
  if (el.component) {
    data += `tag:"${el.tag}",`
  }
  // module data generation functions
  // 为节点执行模块(class, style)的genData 方法
  // 得到: data = { staticStyle: {\"color\":\"red\"}", style: "{width: '100px',height: '100px', background: 'blue'}"}
  for (let i = 0; i < state.dataGenFns.length; i++) {
    data += state.dataGenFns[i](el)
  }
  // attributes
  // 其它属性, 得到: data = { attrs: 静态属性字符串 }
  // || data = { atts: '_d(静态属性字符串, 动态属性字符串)'}
  if (el.attrs) {
    data += `attrs:${genProps(el.attrs)},`
  }
  // DOM props, 同 attrs
  if (el.props) {
    data += `domProps:${genProps(el.props)},`
  }
  // event handlers
  // 动态: 'on:_d("click:handleClick,[input, function($event){events[name].value}, change, function($evnet){events[name].value}]")
  // 静态: 'on:"click":handleClick'
  if (el.events) {
    data += `${genHandlers(el.events, false)},`
  }
  // 带原生修饰符的事件: 同 events
  if (el.nativeEvents) {
    data += `${genHandlers(el.nativeEvents, true)},`
  }
  // slot target
  // only for non-scoped slots
  // 非作用域插槽: 得到 data = { slot: slotName }
  if (el.slotTarget && !el.slotScope) {
    data += `slot:${el.slotTarget},`
  }
  // scoped slots
  // 作用域插槽: 得到 data = {scopedSlots: '_u(xxx)' }
  if (el.scopedSlots) {
    data += `${genScopedSlots(el, el.scopedSlots, state)},`
  }
  // component v-model
  // 带有 v-model 指令的组件, 结果为: model: {value, callback, expression }
  if (el.model) {
    data += `model:{value:${
      el.model.value
    },callback:${
      el.model.callback
    },expression:${
      el.model.expression
    }},`
  }
  // inline-template 处理内联模板
  // 返回: {inlineTemplate:{render, staticRenderFns}}
  if (el.inlineTemplate) {
    const inlineTemplate = genInlineTemplate(el, state)
    if (inlineTemplate) {
      data += `${inlineTemplate},`
    }
  }
  // 去掉末尾的逗号 && 加上 }结尾
  data = data.replace(/,$/, '') + '}'
  // v-bind dynamic argument wrap
  // v-bind with dynamic arguments must be applied using the same v-bind object
  // merge helper so that class/style/mustUseProp attrs are handled correctly.
  if (el.dynamicAttrs) {
    data = `_b(${data},"${el.tag}",${genProps(el.dynamicAttrs)})`
  }
  // v-bind data wrap
  if (el.wrapData) {
    data = el.wrapData(data)
  }
  // v-on data wrap
  if (el.wrapListeners) {
    data = el.wrapListeners(data)
  }
  return data
}
/**
 * 编译指令, 如果指令存在运行时任务, 则 return 指令信息出去
 * res = 'directives: [{name, rawName, value, expression, arg, modifiers}]'
 */
function genDirectives (el: ASTElement, state: CodegenState): string | void {
  // 得到所有的指令数组 [{name: 'text', rawName: 'v-text', val: 'text', arg: null, isDynamicArg: false, modifiers: undefined, start, end}]
  const dirs = el.directives
  if (!dirs) return
  // 最终处理得到的结果
  let res = 'directives:['
  let hasRuntime = false
  let i, l, dir, needRuntime
  for (i = 0, l = dirs.length; i < l; i++) {
    dir = dirs[i]
    needRuntime = true
    // 拿到指令对应的方法 dir.name = text v-text
    const gen: DirectiveFunction = state.directives[dir.name]
    if (gen) {
      // compile-time directive that manipulates AST.
      // returns true if it also needs a runtime counterpart.
      // 指令 gen 方法, 编译当前指令 v-text || v-model
      // 返回结果 boolean, 赋值给 needRuntime, 标记当前指令是否存在运行时的任务
      needRuntime = !!gen(el, dir, state.warn)
    }
    if (needRuntime) {
      // 表示存在运行时的任务
      // res = 'directives: [{name, rawName, value, expression, arg, modifiers}]'
      hasRuntime = true
      res += `{name:"${dir.name}",rawName:"${dir.rawName}"${
        dir.value ? `,value:(${dir.value}),expression:${JSON.stringify(dir.value)}` : ''
      }${
        dir.arg ? `,arg:${dir.isDynamicArg ? dir.arg : `"${dir.arg}"`}` : ''
      }${
        dir.modifiers ? `,modifiers:${JSON.stringify(dir.modifiers)}` : ''
      }},`
    }
  }
  if (hasRuntime) {
    // 指令存在运行时任务, 则 return 结果
    return res.slice(0, -1) + ']'
  }
}

function genInlineTemplate (el: ASTElement, state: CodegenState): ?string {
  const ast = el.children[0]
  if (process.env.NODE_ENV !== 'production' && (
    el.children.length !== 1 || ast.type !== 1
  )) {
    state.warn(
      'Inline-template components must have exactly one child element.',
      { start: el.start }
    )
  }
  if (ast && ast.type === 1) {
    const inlineRenderFns = generate(ast, state.options)
    return `inlineTemplate:{render:function(){${
      inlineRenderFns.render
    }},staticRenderFns:[${
      inlineRenderFns.staticRenderFns.map(code => `function(){${code}}`).join(',')
    }]}`
  }
}

function genScopedSlots (
  el: ASTElement,
  slots: { [key: string]: ASTElement },
  state: CodegenState
): string {
  // by default scoped slots are considered "stable", this allows child
  // components with only scoped slots to skip forced updates from parent.
  // but in some cases we have to bail-out of this optimization
  // for example if the slot contains dynamic names, has v-if or v-for on them...
  let needsForceUpdate = el.for || Object.keys(slots).some(key => {
    const slot = slots[key]
    return (
      slot.slotTargetDynamic ||
      slot.if ||
      slot.for ||
      containsSlotChild(slot) // is passing down slot from parent which may be dynamic
    )
  })

  // #9534: if a component with scoped slots is inside a conditional branch,
  // it's possible for the same component to be reused but with different
  // compiled slot content. To avoid that, we generate a unique key based on
  // the generated code of all the slot contents.
  let needsKey = !!el.if

  // OR when it is inside another scoped slot or v-for (the reactivity may be
  // disconnected due to the intermediate scope variable)
  // #9438, #9506
  // TODO: this can be further optimized by properly analyzing in-scope bindings
  // and skip force updating ones that do not actually use scope variables.
  if (!needsForceUpdate) {
    let parent = el.parent
    while (parent) {
      if (
        (parent.slotScope && parent.slotScope !== emptySlotScopeToken) ||
        parent.for
      ) {
        needsForceUpdate = true
        break
      }
      if (parent.if) {
        needsKey = true
      }
      parent = parent.parent
    }
  }

  const generatedSlots = Object.keys(slots)
    .map(key => genScopedSlot(slots[key], state))
    .join(',')

  return `scopedSlots:_u([${generatedSlots}]${
    needsForceUpdate ? `,null,true` : ``
  }${
    !needsForceUpdate && needsKey ? `,null,false,${hash(generatedSlots)}` : ``
  })`
}

function hash(str) {
  let hash = 5381
  let i = str.length
  while(i) {
    hash = (hash * 33) ^ str.charCodeAt(--i)
  }
  return hash >>> 0
}

function containsSlotChild (el: ASTNode): boolean {
  if (el.type === 1) {
    if (el.tag === 'slot') {
      return true
    }
    return el.children.some(containsSlotChild)
  }
  return false
}

function genScopedSlot (
  el: ASTElement,
  state: CodegenState
): string {
  const isLegacySyntax = el.attrsMap['slot-scope']
  if (el.if && !el.ifProcessed && !isLegacySyntax) {
    return genIf(el, state, genScopedSlot, `null`)
  }
  if (el.for && !el.forProcessed) {
    return genFor(el, state, genScopedSlot)
  }
  const slotScope = el.slotScope === emptySlotScopeToken
    ? ``
    : String(el.slotScope)
  const fn = `function(${slotScope}){` +
    `return ${el.tag === 'template'
      ? el.if && isLegacySyntax
        ? `(${el.if})?${genChildren(el, state) || 'undefined'}:undefined`
        : genChildren(el, state) || 'undefined'
      : genElement(el, state)
    }}`
  // reverse proxy v-slot without scope on this.$slots
  const reverseProxy = slotScope ? `` : `,proxy:true`
  return `{key:${el.slotTarget || `"default"`},fn:${fn}${reverseProxy}}`
}

// 生成所有子节点的渲染函数, 返回一个数组, 格式如:
// [_c(tag, data, children, nomalizationType), ...]
export function genChildren (
  el: ASTElement,
  state: CodegenState,
  checkSkip?: boolean,
  altGenElement?: Function,
  altGenNode?: Function
): string | void {
  const children = el.children
  if (children.length) {
    const el: any = children[0]
    // optimize single v-for
    if (children.length === 1 &&
      el.for &&
      el.tag !== 'template' &&
      el.tag !== 'slot'
    ) {
      // 优化, 只有一个子节点 && 子节点上有 v-for 指令 && (子节点的标签不为 template && slot)
      // 优化的方式是直接调用 genElement 生成该节点的渲染函数, 不需要走下面的循环调用 genNode 最后得到渲染函数
      const normalizationType = checkSkip
        ? state.maybeComponent(el) ? `,1` : `,0`
        : ``
      return `${(altGenElement || genElement)(el, state)}${normalizationType}`
    }
    // 获取节点规范化类型, 返回一个 number 0, 1, 2, 不是重点
    const normalizationType = checkSkip
      ? getNormalizationType(children, state.maybeComponent)
      : 0
    // 函数, 生成代码的一个函数
    const gen = altGenNode || genNode
    // 返回一个数组, 数组的每个元素都是一个子节点的渲染函数
    // 格式: ['_c(tag, data, children, nomalizationType)',...]
    return `[${children.map(c => gen(c, state)).join(',')}]${
      normalizationType ? `,${normalizationType}` : ''
    }`
  }
}

// determine the normalization needed for the children array.
// 0: no normalization needed
// 1: simple normalization needed (possible 1-level deep nested array)
// 2: full normalization needed
function getNormalizationType (
  children: Array<ASTNode>,
  maybeComponent: (el: ASTElement) => boolean
): number {
  let res = 0
  for (let i = 0; i < children.length; i++) {
    const el: ASTNode = children[i]
    if (el.type !== 1) {
      continue
    }
    if (needsNormalization(el) ||
        (el.ifConditions && el.ifConditions.some(c => needsNormalization(c.block)))) {
      res = 2
      break
    }
    if (maybeComponent(el) ||
        (el.ifConditions && el.ifConditions.some(c => maybeComponent(c.block)))) {
      res = 1
    }
  }
  return res
}

function needsNormalization (el: ASTElement): boolean {
  return el.for !== undefined || el.tag === 'template' || el.tag === 'slot'
}

function genNode (node: ASTNode, state: CodegenState): string {
  if (node.type === 1) {
    return genElement(node, state)
  } else if (node.type === 3 && node.isComment) {
    return genComment(node)
  } else {
    return genText(node)
  }
}

export function genText (text: ASTText | ASTExpression): string {
  return `_v(${text.type === 2
    ? text.expression // no need for () because already wrapped in _s()
    : transformSpecialNewlines(JSON.stringify(text.text))
  })`
}

export function genComment (comment: ASTText): string {
  return `_e(${JSON.stringify(comment.text)})`
}

function genSlot (el: ASTElement, state: CodegenState): string {
  const slotName = el.slotName || '"default"'
  const children = genChildren(el, state)
  let res = `_t(${slotName}${children ? `,function(){return ${children}}` : ''}`
  const attrs = el.attrs || el.dynamicAttrs
    ? genProps((el.attrs || []).concat(el.dynamicAttrs || []).map(attr => ({
        // slot props are camelized
        name: camelize(attr.name),
        value: attr.value,
        dynamic: attr.dynamic
      })))
    : null
  const bind = el.attrsMap['v-bind']
  if ((attrs || bind) && !children) {
    res += `,null`
  }
  if (attrs) {
    res += `,${attrs}`
  }
  if (bind) {
    res += `${attrs ? '' : ',null'},${bind}`
  }
  return res + ')'
}

// componentName is el.component, take it as argument to shun flow's pessimistic refinement
function genComponent (
  componentName: string,
  el: ASTElement,
  state: CodegenState
): string {
  const children = el.inlineTemplate ? null : genChildren(el, state, true)
  return `_c(${componentName},${genData(el, state)}${
    children ? `,${children}` : ''
  })`
}

/**
 * 遍历属性数组 props, 得到所有属性组成的字符串
 * 如果不存在动态属性, 得到:
 *  'attrName, attrVal,...'
 * 如果存在, 得到:
 * '_d(静态属性字符串, 动态属性字符串)'
 * @param {*} props 
 * @returns 
 */
function genProps (props: Array<ASTAttr>): string {
  // 静态属性
  let staticProps = ``
  // 动态属性
  let dynamicProps = ``
  for (let i = 0; i < props.length; i++) {
    const prop = props[i]
    const value = __WEEX__
      ? generateValue(prop.value)
      : transformSpecialNewlines(prop.value)
    if (prop.dynamic) {
      dynamicProps += `${prop.name},${value},`
    } else {
      staticProps += `"${prop.name}":${value},`
    }
  }
  staticProps = `{${staticProps.slice(0, -1)}}`
  if (dynamicProps) {
    return `_d(${staticProps},[${dynamicProps.slice(0, -1)}])`
  } else {
    return staticProps
  }
}

/* istanbul ignore next */
function generateValue (value) {
  if (typeof value === 'string') {
    return transformSpecialNewlines(value)
  }
  return JSON.stringify(value)
}

// #3895, #4268
function transformSpecialNewlines (text: string): string {
  return text
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
