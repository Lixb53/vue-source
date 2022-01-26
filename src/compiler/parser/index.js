/* @flow */

import he from 'he'
import { parseHTML } from './html-parser'
import { parseText } from './text-parser'
import { parseFilters } from './filter-parser'
import { genAssignmentCode } from '../directives/model'
import { extend, cached, no, camelize, hyphenate } from 'shared/util'
import { isIE, isEdge, isServerRendering } from 'core/util/env'

import {
  addProp,
  addAttr,
  baseWarn,
  addHandler,
  addDirective,
  getBindingAttr,
  getAndRemoveAttr,
  getRawBindingAttr,
  pluckModuleFunction,
  getAndRemoveAttrByRegex
} from '../helpers'

export const onRE = /^@|^v-on:/
export const dirRE = process.env.VBIND_PROP_SHORTHAND
  ? /^v-|^@|^:|^\.|^#/
  : /^v-|^@|^:|^#/
export const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
export const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g
const dynamicArgRE = /^\[.*\]$/

const argRE = /:(.*)$/
export const bindRE = /^:|^\.|^v-bind:/
const propBindRE = /^\./
const modifierRE = /\.[^.\]]+(?=[^\]]*$)/g

const slotRE = /^v-slot(:|$)|^#/

const lineBreakRE = /[\r\n]/
const whitespaceRE = /[ \f\t\r\n]+/g

const invalidAttributeRE = /[\s"'<>\/=]/

const decodeHTMLCached = cached(he.decode)

export const emptySlotScopeToken = `_empty_`

// configurable state
export let warn: any
let delimiters
let transforms
let preTransforms                   // 处理包含 v-mode 指令的 input 标签
let postTransforms
let platformIsPreTag
let platformMustUseProp
let platformGetTagNamespace
let maybeComponent

export function createASTElement (
  tag: string,
  attrs: Array<ASTAttr>,
  parent: ASTElement | void
): ASTElement {
  return {
    type: 1,
    tag,
    // 属性数组
    attrsList: attrs,
    // 将属性数组变成对象的形式: {attrName: attrVal}
    attrsMap: makeAttrsMap(attrs),
    rawAttrsMap: {},
    // 标记父元素
    parent,
    // 存放所有子元素
    children: []
  }
}

/**
 * Convert HTML string to AST.
 * 将 html 字符串转换为 AST
 */
export function parse (
  template: string,
  options: CompilerOptions
): ASTElement | void {
  // 日志
  console.log(options)
  warn = options.warn || baseWarn

  // 是否为 pre 标签
  platformIsPreTag = options.isPreTag || no
  // 必须使用 props 进行绑定的属性
  platformMustUseProp = options.mustUseProp || no
  // 获取标签的命名空间
  platformGetTagNamespace = options.getTagNamespace || no
  // 是否保留标签 html svg
  const isReservedTag = options.isReservedTag || no
  // 判断一个元素是否为一个组件
  maybeComponent = (el: ASTElement) => !!(
    el.component ||
    el.attrsMap[':is'] ||
    el.attrsMap['v-bind:is'] ||
    !(el.attrsMap.is ? isReservedTag(el.attrsMap.is) : isReservedTag(el.tag))
  )
  // 三个数组, 数组中每个元素都是一个函数
  transforms = pluckModuleFunction(options.modules, 'transformNode')
  preTransforms = pluckModuleFunction(options.modules, 'preTransformNode')
  postTransforms = pluckModuleFunction(options.modules, 'postTransformNode')

  // 界定符   如: {{}}
  delimiters = options.delimiters

  // 存放标签的 ast 对象
  const stack = []
  // 空格选项
  const preserveWhitespace = options.preserveWhitespace !== false
  const whitespaceOption = options.whitespace
  // 根节点, 以 root 为根, 处理后的节点都会按照层级挂载到 root 下, 最后 return 的就是一个 root, 一个 ast 语法树
  let root
  // 当前元素的父元素
  let currentParent
  let inVPre = false
  let inPre = false
  let warned = false

  function warnOnce (msg, range) {
    if (!warned) {
      warned = true
      warn(msg, range)
    }
  }

  /**
   * 主要做了 3 件事
   *  1. 如果元素没有被处理过, 即 el.processed 为 false, 则 调用 processElement 方法处理节点上的众多属性
   *  2. 让自己和父元素产生关系, 将自己放到父元素的 children 数组中, 并设置自己的 parent 属性为 currentParent
   *  3. 设置自己的子元素, 将自己所有非插槽的子元素放到自己的 children 数组中
   * @param {*} element 当前元素对应的ast 对象
   */
  function closeElement (element) {
    // 移除节点末尾的空格, 当前 pre 标签内的元素除外
    trimEndingWhitespace(element)
    // 当前元素不在 pre 节点内, 并且也没有被处理过
    if (!inVPre && !element.processed) {
      // 分别处理元素节点的 key, ref, 插槽, 自闭合的 slot 标签, 动态组件, class, style, v-bind, v-on 其它指令和一些原生属性
      element = processElement(element, options)
    }

    // 处理节点上存在 v-if, v-else-if, v-else 指令的情况
    // 如果根节点存在 v-if 指令, 则必须提供一个 v-else-if || v-else 的同级别节点, 防止根元素不存在
    // tree management
    if (!stack.length && element !== root) {
      // allow root elements with v-if, v-else-if and v-else
      if (root.if && (element.elseif || element.else)) {
        if (process.env.NODE_ENV !== 'production') {
          // 检查根元素
          checkRootConstraints(element)
        }
        // 给根元素设置 ifConditions 属性, root.ifConditions = [{exp: element.elseif, block: element }, ...]
        addIfCondition(root, {
          exp: element.elseif,
          block: element
        })
      } else if (process.env.NODE_ENV !== 'production') {
        // 提示, 表示不应该在 根元素 上只是用 v-if, 应该将 v-if, v-else-if 一起使用, 保证组件只有一个根元素
        warnOnce(
          `Component template should contain exactly one root element. ` +
          `If you are using v-if on multiple elements, ` +
          `use v-else-if to chain them instead.`,
          { start: element.start }
        )
      }
    }
    // 让自己和父元素产生关系
    // 将自己放到父元素的 children 数组中, 然后设置自己的 parent 属性为 currentParent
    if (currentParent && !element.forbidden) {
      if (element.elseif || element.else) {
        processIfConditions(element, currentParent)
      } else {
        if (element.slotScope) {
          // scoped slot
          // keep it in the children list so that v-else(-if) conditions can
          // find it as the prev node.
          const name = element.slotTarget || '"default"'
          ;(currentParent.scopedSlots || (currentParent.scopedSlots = {}))[name] = element
        }
        currentParent.children.push(element)
        element.parent = currentParent
      }
    }

    // 设置自己的子元素
    // 将自己的所有非插槽的子元素设置到 element.children 数组中
    // final children cleanup
    // filter out scoped slots
    element.children = element.children.filter(c => !(c: any).slotScope)
    // remove trailing whitespace node again
    trimEndingWhitespace(element)

    // check pre state
    if (element.pre) {
      inVPre = false
    }
    if (platformIsPreTag(element.tag)) {
      inPre = false
    }
    // 分别为 element 执行 model, class, style 三个模块的 postTransform 方法
    // 但是 web 平台没有提供该方法
    // apply post-transforms
    for (let i = 0; i < postTransforms.length; i++) {
      postTransforms[i](element, options)
    }
  }

  function trimEndingWhitespace (el) {
    // remove trailing whitespace node
    if (!inPre) {
      let lastNode
      while (
        (lastNode = el.children[el.children.length - 1]) &&
        lastNode.type === 3 &&
        lastNode.text === ' '
      ) {
        el.children.pop()
      }
    }
  }

  function checkRootConstraints (el) {
    if (el.tag === 'slot' || el.tag === 'template') {
      warnOnce(
        `Cannot use <${el.tag}> as component root element because it may ` +
        'contain multiple nodes.',
        { start: el.start }
      )
    }
    if (el.attrsMap.hasOwnProperty('v-for')) {
      warnOnce(
        'Cannot use v-for on stateful component root element because ' +
        'it renders multiple elements.',
        el.rawAttrsMap['v-for']
      )
    }
  }

  // 解析 html 模板字符串, 处理所有标签 以及 标签上的属性
  parseHTML(template, {
    warn,
    expectHTML: options.expectHTML,
    isUnaryTag: options.isUnaryTag,
    canBeLeftOpenTag: options.canBeLeftOpenTag,
    shouldDecodeNewlines: options.shouldDecodeNewlines,
    shouldDecodeNewlinesForHref: options.shouldDecodeNewlinesForHref,
    shouldKeepComment: options.comments,
    outputSourceRange: options.outputSourceRange,
    /**
     * 主要做了一下 6件事
     *  1. 创建 AST 对象
     *  2. 处理存在 v-model 指令的 input 标签, 分别处理 input 为 checkbox, radio, 其它的情况
     *  3. 处理标签上的众多指令, 比如 v-pre, v-if, v-once
     *  4. 如果根节点 root 不存在则设置当前元素为根节点
     *  5. 如果当前元素为非自闭合标签则将自己 push 到 stack 数组, 并记录 currentParent, 在接下来处理子元素时用来告诉子元素自己的父节点是谁
     *  6. 如果当前元素为自闭合标签, 则表示该标签要处理结束了, 让自己和父元素产生关系, 以及设置自己的子元素
     * @param {*} tag 标签名
     * @param {*} attrs 属性数组
     * @param {*} unary 是否为自闭合标签
     * @param {*} start 标签的开始索引位置
     * @param {*} end 结束索引位置
     */
    start (tag, attrs, unary, start, end) {
      // 检查命名空间, 如果存在, 则继承父命名空间
      // check namespace.
      // inherit parent ns if there is one
      const ns = (currentParent && currentParent.ns) || platformGetTagNamespace(tag)

      // handle IE svg bug
      /* istanbul ignore if */
      // ie的处理
      if (isIE && ns === 'svg') {
        attrs = guardIESVGBug(attrs)
      }

      // 生成当前标签的 ast 对象
      let element: ASTElement = createASTElement(tag, attrs, currentParent)
      // 如果存在命名空间, 则将 ns 添加到 element 对象上,
      if (ns) {
        element.ns = ns
      }

      // 非生产环境下, 在 ast 对象上添加一些 属性, 比如 start, end
      if (process.env.NODE_ENV !== 'production') {
        if (options.outputSourceRange) {
          element.start = start
          element.end = end
          // 将属性解析成 { attrName: {name: attrName, value: attrVal, start, end}} 形式的对象
          element.rawAttrsMap = element.attrsList.reduce((cumulated, attr) => {
            cumulated[attr.name] = attr
            return cumulated
          }, {})
        }
        // 遍历属性数组, 对属性有效性进行校验
        attrs.forEach(attr => {
          if (invalidAttributeRE.test(attr.name)) {
            warn(
              `Invalid dynamic argument expression: attribute names cannot contain ` +
              `spaces, quotes, <, >, / or =.`,
              {
                start: attr.start + attr.name.indexOf(`[`),
                end: attr.start + attr.name.length
              }
            )
          }
        })
      }

      // 非服务端渲染的情况下, 模板中不应该出现 stye script 标签
      if (isForbiddenTag(element) && !isServerRendering()) {
        element.forbidden = true
        process.env.NODE_ENV !== 'production' && warn(
          'Templates should only be responsible for mapping the state to the ' +
          'UI. Avoid placing tags with side-effects in your templates, such as ' +
          `<${tag}>` + ', as they will not be parsed.',
          { start: element.start }
        )
      }

      /**
       * 为 element 对象分别执行 calss, style, model 模块中的 preTransform 方法
       * 不过 web 平台 只有 model 模块有 preTransforms 方法
       * 用来处理存在 v-model 的 input 标签, 但没处理 v-model 属性
       * 分别处理了 input 为 checkbox, radio 和 其它的情况
       * input 具体是哪种情况由 el.ifConditions 中的条件来判断
       * 
       */
      // apply pre-transforms
      // 处理带有 v-model 指令的 input 标签, 处理标签上的众多属性, e.g. v-for/v-if/:type/其它指令属性==, 最后将结果都记录在element(ast)对象上
      for (let i = 0; i < preTransforms.length; i++) {
        element = preTransforms[i](element, options) || element
      }

      if (!inVPre) {
        // 表示 element 是否存在 v-pre 指令, 存在则设置 element.pre = true
        processPre(element)
        if (element.pre) {
          // 存在 v-pre 指令, 则设置 inVpre 为 true
          inVPre = true
        }
      }
      // 如果 pre 标签, 则设置 inPre 为 true
      if (platformIsPreTag(element.tag)) {
        inPre = true
      }

      if (inVPre) {
        // 说明标签上存在 v-pre 指令, 这样的节点只会渲染一次, 将节点上的属性都设置到 el.attrs 数组对象中, 作为静态属性, 数组更新时不会渲染这部分内容
        // 设置 el.attrs 数组对象, 每个元素都是一个属性对象 { name: attrName, value: attrValue, start, end }
        processRawAttrs(element)
      } else if (!element.processed) {
        // structural directives
        // 处理 v-for 属性, 得到 element.for = '可迭代对象(iterable)' element.alia = 别名
        processFor(element)
        /**
         * 处理 v-if v-else-if v-else
         * 得到 element.if = 'exp', element.elseif = exp, element.else = true
         * v-if 属性会额外在 elent.ifConditions 数组中添加 { exp, block } 对象
         */
        processIf(element)
        // 处理 v-once 指令, 得到 elemnt.once = true
        processOnce(element)
      }

      // 根
      if (!root) {
        root = element
        if (process.env.NODE_ENV !== 'production') {
          checkRootConstraints(root)
        }
      }

      if (!unary) {
        // 如果不是自闭合标签, 标记父元素
        // <div ...>child</div> 处理完开始标签后, 开始处理child
        currentParent = element
        // 将 element 对象 push 到 stack 数组
        stack.push(element)
      } else {
        closeElement(element)
      }
    },

    /**
     * 处理结束标签
     * @param {*} tag 结束标签的名称 
     * @param {*} start 结束标签的开始索引
     * @param {*} end 结束标签的结束索引
     */
    end (tag, start, end) {
      // 结束标签对应的开始标签的 ast 对象
      const element = stack[stack.length - 1]
      // pop stack
      stack.length -= 1
      currentParent = stack[stack.length - 1]
      if (process.env.NODE_ENV !== 'production' && options.outputSourceRange) {
        element.end = end
      }
      closeElement(element)
    },

    // 处理文本, 基于文本生成 ast 对象, 然后将该 ast 放到 它的父元素的肚子里, 即 currentParent.children 数组中
    chars (text: string, start: number, end: number) {
      // 异常处理, currentParent 不存在说明这段文本没有父元素
      if (!currentParent) {
        if (process.env.NODE_ENV !== 'production') {
          if (text === template) {
            // 文本不能作为组件的根元素
            warnOnce(
              'Component template requires a root element, rather than just text.',
              { start }
            )
          } else if ((text = text.trim())) {
            // 放在根元素之外的文本会被忽略
            warnOnce(
              `text "${text}" outside root element will be ignored.`,
              { start }
            )
          }
        }
        return
      }
      // IE textarea placeholder bug
      /* istanbul ignore if */
      if (isIE &&
        currentParent.tag === 'textarea' &&
        currentParent.attrsMap.placeholder === text
      ) {
        return
      }
      // 当前元素的所有孩子节点
      const children = currentParent.children
      // 对 text 进行一系列的处理, 比如删除空白字符, 或者存在 whitespaceOptions 选项, 则 text 直接置为 空 或 空格
      if (inPre || text.trim()) {
        text = isTextTag(currentParent) ? text : decodeHTMLCached(text)
      } else if (!children.length) {
        // 说明文本不在 pre 标签内而且 text.trim() 为空, 而且当前父元素也没有子节点, 则将 text 置为空
        // remove the whitespace-only node right after an opening tag
        text = ''
      } else if (whitespaceOption) {
        // 压缩处理
        if (whitespaceOption === 'condense') {
          // in condense mode, remove the whitespace node if it contains
          // line break, otherwise condense to a single space
          text = lineBreakRE.test(text) ? '' : ' '
        } else {
          text = ' '
        }
      } else {
        text = preserveWhitespace ? ' ' : ''
      }
      // 如果经过处理后 text 还存在
      if (text) {
        if (!inPre && whitespaceOption === 'condense') {
          // 不在 pre 节点中, 并且配置选项中存在压缩选项, 则将多个连续空格压缩为单个
          // condense consecutive whitespaces into single space
          text = text.replace(whitespaceRE, ' ')
        }
        let res
        // 基于 text 生成 AST 对象
        let child: ?ASTNode
        if (!inVPre && text !== ' ' && (res = parseText(text, delimiters))) {
          // 文本中存在表达式(即有界定符)
          child = {
            type: 2,
            // 表达式
            expression: res.expression,
            tokens: res.tokens,
            // 文本
            text
          }
        } else if (text !== ' ' || !children.length || children[children.length - 1].text !== ' ') {
          // 纯文本节点
          child = {
            type: 3,
            text
          }
        }
        // child 存在, 则将 child 放到父元素的肚子里, 即 currentParent.children 数组中
        if (child) {
          if (process.env.NODE_ENV !== 'production' && options.outputSourceRange) {
            child.start = start
            child.end = end
          }
          children.push(child)
        }
      }
    },
    comment (text: string, start, end) {
      // adding anything as a sibling to the root node is forbidden
      // 禁止将任何内容作为兄弟节点添加到根节点
      // comments should still be allowed, but ignored
      // 注释仍然是允许的, 但可以忽略

      // 判断父级元素是否存在, 不存在的话, 就是最开始
      if (currentParent) {
        // 如果存在父级元素, 则将注释内容作为文本节点, 放到当前父元素的children中
        const child: ASTText = {
          type: 3,
          text,
          isComment: true
        }
        if (process.env.NODE_ENV !== 'production' && options.outputSourceRange) {
          child.start = start
          child.end = end
        }
        currentParent.children.push(child)
      }
    }
  })

  // 返回生成的 ast 对象
  return root
}

function processPre (el) {
  if (getAndRemoveAttr(el, 'v-pre') != null) {
    el.pre = true
  }
}

function processRawAttrs (el) {
  const list = el.attrsList
  const len = list.length
  if (len) {
    const attrs: Array<ASTAttr> = el.attrs = new Array(len)
    for (let i = 0; i < len; i++) {
      attrs[i] = {
        name: list[i].name,
        value: JSON.stringify(list[i].value)
      }
      if (list[i].start != null) {
        attrs[i].start = list[i].start
        attrs[i].end = list[i].end
      }
    }
  } else if (!el.pre) {
    // non root node in pre blocks with no attributes
    el.plain = true
  }
}

/**
 * 分别处理元素节点的 key, ref, 插槽, 自闭合的 slot 标签, 动态组件, class, style, v-bind, v-on, 其它指令和一些原生属性
 * 然后再 el 对象上添加如下属性
 * el.key, ref, refInFor, scopedSlot, slotName, component, inlineTemplate, staticClass, bindingClass, staticStyle, biindingStyle, attrs
 * @param {*} element 被处理元素的 ast 对象
 * @param {*} options 
 * @returns 
 */
export function processElement (
  element: ASTElement,
  options: CompilerOptions
) {
  // 处理:key 得到 el.key = val
  processKey(element)

  // determine whether this is a plain element after
  // removing structural attributes
  // 是不是普通元素
  element.plain = (
    !element.key &&
    !element.scopedSlots &&
    !element.attrsList.length
  )

  // 处理 ref
  processRef(element)
  // 插槽
  processSlotContent(element)
  // 具名插槽
  processSlotOutlet(element)
  // 动态组件
  processComponent(element)
  // 分别为 element 执行 class, style 这两个模块中的 transformNode 方法
  for (let i = 0; i < transforms.length; i++) {
    element = transforms[i](element, options) || element
  }
  // 处理标签上的所有属性, 事件/指令/其它属性
  processAttrs(element)
  // 返回 ast 对象
  return element
}

function processKey (el) {
  const exp = getBindingAttr(el, 'key')
  if (exp) {
    if (process.env.NODE_ENV !== 'production') {
      if (el.tag === 'template') {
        warn(
          `<template> cannot be keyed. Place the key on real elements instead.`,
          getRawBindingAttr(el, 'key')
        )
      }
      if (el.for) {
        const iterator = el.iterator2 || el.iterator1
        const parent = el.parent
        if (iterator && iterator === exp && parent && parent.tag === 'transition-group') {
          warn(
            `Do not use v-for index as key on <transition-group> children, ` +
            `this is the same as not using keys.`,
            getRawBindingAttr(el, 'key'),
            true /* tip */
          )
        }
      }
    }
    el.key = exp
  }
}

function processRef (el) {
  const ref = getBindingAttr(el, 'ref')
  if (ref) {
    el.ref = ref
    el.refInFor = checkInFor(el)
  }
}

/**
 * 处理 v-for, 将结果设置到 el 对象上, 得到:
 *  el.for = 可迭代对象, 比如: arr
 *  el.alias = 别名, 比如: item
 * @param {*} el el 元素的 ast 对象
 */
export function processFor (el: ASTElement) {
  let exp
  if ((exp = getAndRemoveAttr(el, 'v-for'))) {
    // 拿到 v-for 对应的 '(item, idx) in items'
    const res = parseFor(exp)
    if (res) {
      extend(el, res)
    } else if (process.env.NODE_ENV !== 'production') {
      warn(
        `Invalid v-for expression: ${exp}`,
        el.rawAttrsMap['v-for']
      )
    }
  }
}

type ForParseResult = {
  for: string;
  alias: string;
  iterator1?: string;
  iterator2?: string;
};

/**
 * 最终返回 { for: 'items', alias: 'item', iterator1: 'idx' }
 * @param {*} exp 
 * @returns 
 */
export function parseFor (exp: string): ?ForParseResult {
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return
  const res = {}
  res.for = inMatch[2].trim()
  const alias = inMatch[1].trim().replace(stripParensRE, '')
  const iteratorMatch = alias.match(forIteratorRE)
  if (iteratorMatch) {
    res.alias = alias.replace(forIteratorRE, '').trim()
    res.iterator1 = iteratorMatch[1].trim()
    if (iteratorMatch[2]) {
      res.iterator2 = iteratorMatch[2].trim()
    }
  } else {
    res.alias = alias
  }
  return res
}

function processIf (el) {
  const exp = getAndRemoveAttr(el, 'v-if')
  if (exp) {
    el.if = exp
    addIfCondition(el, {
      exp: exp,
      block: el
    })
  } else {
    if (getAndRemoveAttr(el, 'v-else') != null) {
      el.else = true
    }
    const elseif = getAndRemoveAttr(el, 'v-else-if')
    if (elseif) {
      el.elseif = elseif
    }
  }
}

function processIfConditions (el, parent) {
  const prev = findPrevElement(parent.children)
  if (prev && prev.if) {
    addIfCondition(prev, {
      exp: el.elseif,
      block: el
    })
  } else if (process.env.NODE_ENV !== 'production') {
    warn(
      `v-${el.elseif ? ('else-if="' + el.elseif + '"') : 'else'} ` +
      `used on element <${el.tag}> without corresponding v-if.`,
      el.rawAttrsMap[el.elseif ? 'v-else-if' : 'v-else']
    )
  }
}

function findPrevElement (children: Array<any>): ASTElement | void {
  let i = children.length
  while (i--) {
    if (children[i].type === 1) {
      return children[i]
    } else {
      if (process.env.NODE_ENV !== 'production' && children[i].text !== ' ') {
        warn(
          `text "${children[i].text.trim()}" between v-if and v-else(-if) ` +
          `will be ignored.`,
          children[i]
        )
      }
      children.pop()
    }
  }
}

export function addIfCondition (el: ASTElement, condition: ASTIfCondition) {
  if (!el.ifConditions) {
    el.ifConditions = []
  }
  el.ifConditions.push(condition)
}

function processOnce (el) {
  const once = getAndRemoveAttr(el, 'v-once')
  if (once != null) {
    el.once = true
  }
}

/**
 * 处理插槽传递给组件的内容, 得到:
 *  slotTaget => 插槽明
 *  slotTargetDynamic => 是否为动态插槽
 *  slotScope => 作用域插槽的值
 * 直接在 <comp> 标签上使用 v-slot 语法时, 将上述属性放到 el.scopedSlots 对象上, 其它情况直接放到 el 对象上
 */
// handle content being passed to a component as slot,
// e.g. <template slot="xxx">, <div slot-scope="xxx">
function processSlotContent (el) {
  let slotScope
  if (el.tag === 'template') {
    // templat 标签上使用 scope 属性的提示
    // scope 已经弃用, 并在 2.5 之后使用 slot-scope 代替
    // slot-scope 即可以用在 template 标签 也 可以用在普通标签上
    slotScope = getAndRemoveAttr(el, 'scope')
    /* istanbul ignore if */
    if (process.env.NODE_ENV !== 'production' && slotScope) {
      warn(
        `the "scope" attribute for scoped slots have been deprecated and ` +
        `replaced by "slot-scope" since 2.5. The new "slot-scope" attribute ` +
        `can also be used on plain elements in addition to <template> to ` +
        `denote scoped slots.`,
        el.rawAttrsMap['scope'],
        true
      )
    }
    // el.slotScope = val
    el.slotScope = slotScope || getAndRemoveAttr(el, 'slot-scope')
  } else if ((slotScope = getAndRemoveAttr(el, 'slot-scope'))) {
    /* istanbul ignore if */
    if (process.env.NODE_ENV !== 'production' && el.attrsMap['v-for']) {
      // 元素不能同时使用 slot-scope 和 v-for, v-for 具有更高的优先级
      // 应该用 template 标签作为容器, 将 slot-scope 放到 template 标签上
      warn(
        `Ambiguous combined usage of slot-scope and v-for on <${el.tag}> ` +
        `(v-for takes higher priority). Use a wrapper <template> for the ` +
        `scoped slot to make it clearer.`,
        el.rawAttrsMap['slot-scope'],
        true
      )
    }
    el.slotScope = slotScope
  }

  // slot="xxx"  老旧的具名插槽的写法
  // 获取 slot 属性的值
  const slotTarget = getBindingAttr(el, 'slot')
  if (slotTarget) {
    el.slotTarget = slotTarget === '""' ? '"default"' : slotTarget
    el.slotTargetDynamic = !!(el.attrsMap[':slot'] || el.attrsMap['v-bind:slot'])
    // preserve slot as an attribute for native shadow DOM compat
    // only for non-scoped slots.
    if (el.tag !== 'template' && !el.slotScope) {
      addAttr(el, 'slot', slotTarget, getRawBindingAttr(el, 'slot'))
    }
  }

  // 2.6 v-slot syntax
  if (process.env.NEW_SLOT_SYNTAX) {
    if (el.tag === 'template') {
      // v-slot on <template>
      // slotBinding = { name: 'v-slot:header', val: '', start, end}
      const slotBinding = getAndRemoveAttrByRegex(el, slotRE)
      if (slotBinding) {
        if (process.env.NODE_ENV !== 'production') {
          if (el.slotTarget || el.slotScope) {
            // 不同插槽语法禁止混合使用
            warn(
              `Unexpected mixed usage of different slot syntaxes.`,
              el
            )
          }
          if (el.parent && !maybeComponent(el.parent)) {
            // <template v-slot> 只能出现在组件的根位置，比如：
            // <comp>
            //   <template v-slot>xx</template>
            // </comp>
            // 而不能是
            // <comp>
            //   <div>
            //     <template v-slot>xxx</template>
            //   </div>
            // </comp>
            warn(
              `<template v-slot> can only appear at the root level inside ` +
              `the receiving component`,
              el
            )
          }
        }
        // 得到插槽名称
        const { name, dynamic } = getSlotName(slotBinding)
        // 插槽名
        el.slotTarget = name
        // 是否为动态插槽
        el.slotTargetDynamic = dynamic
        // 作用域插槽的值
        el.slotScope = slotBinding.value || emptySlotScopeToken // force it into a scoped slot for perf
      }
    } else {
      // v-slot on component, denotes default slot
      const slotBinding = getAndRemoveAttrByRegex(el, slotRE)
      if (slotBinding) {
        if (process.env.NODE_ENV !== 'production') {
          // el 不是组件的话, 提示, v-slot 只能出现在组件上或 template 标签上
          if (!maybeComponent(el)) {
            warn(
              `v-slot can only be used on components or <template>.`,
              slotBinding
            )
          }
          // 语法混用
          if (el.slotScope || el.slotTarget) {
            warn(
              `Unexpected mixed usage of different slot syntaxes.`,
              el
            )
          }
          // 为了避免作用域歧义, 当存在其他命名槽时, 默认槽额应该使用<template>语法
          if (el.scopedSlots) {
            warn(
              `To avoid scope ambiguity, the default slot should also use ` +
              `<template> syntax when there are other named slots.`,
              slotBinding
            )
          }
        }

        // 将组件的孩子添加到它的默认插槽内
        // add the component's children to its default slot
        const slots = el.scopedSlots || (el.scopedSlots = {})
        // 获取插槽名称以及是否为动态插槽
        const { name, dynamic } = getSlotName(slotBinding)
        // 创建一个 template 标签的 ast 对象, 用于容纳插槽内容, 父级是 el
        const slotContainer = slots[name] = createASTElement('template', [], el)
        // 插槽名
        slotContainer.slotTarget = name
        // 是否为动态插槽
        slotContainer.slotTargetDynamic = dynamic
        // 所有的孩子, 将每一个孩子的 parent 属性都设置为 slotContainer
        slotContainer.children = el.children.filter((c: any) => {
          if (!c.slotScope) {
            // 给插槽内元素设置 parent 属性为 slotContainer, 也就是 template 元素
            c.parent = slotContainer
            return true
          }
        })
        slotContainer.slotScope = slotBinding.value || emptySlotScopeToken
        // remove children as they are returned from scopedSlots now
        el.children = []
        // mark el non-plain so data gets generated
        el.plain = false
      }
    }
  }
}

function getSlotName (binding) {
  let name = binding.name.replace(slotRE, '')
  if (!name) {
    if (binding.name[0] !== '#') {
      name = 'default'
    } else if (process.env.NODE_ENV !== 'production') {
      warn(
        `v-slot shorthand syntax requires a slot name.`,
        binding
      )
    }
  }
  return dynamicArgRE.test(name)
    // dynamic [name]
    ? { name: name.slice(1, -1), dynamic: true }
    // static name
    : { name: `"${name}"`, dynamic: false }
}

// handle <slot/> outlets, 处理自闭合 slot 标签
// 得到 插槽名称, el.slotName
function processSlotOutlet (el) {
  if (el.tag === 'slot') {
    el.slotName = getBindingAttr(el, 'name')
    if (process.env.NODE_ENV !== 'production' && el.key) {
      warn(
        `\`key\` does not work on <slot> because slots are abstract outlets ` +
        `and can possibly expand into multiple elements. ` +
        `Use the key on a wrapping element instead.`,
        getRawBindingAttr(el, 'key')
      )
    }
  }
}

/**
 * 处理动态组件: <component :is="compName"></component>
 * 得到 el.component = compName
 * @param {*} el 
 */
function processComponent (el) {
  let binding
  // 解析 is 属性, 得到属性值, 即组件名称, el.component = compName
  if ((binding = getBindingAttr(el, 'is'))) {
    el.component = binding
  }
  // <component :is="compName" inline-template>xx</component>
  // 组件上存在 inline-template 属性, 进行标记: el.innerTemplate = true
  // 表示组件开始和结束标签内的内容作为组件模板出现, 而不是作为插槽被分发, 方便定义组件模板
  if (getAndRemoveAttr(el, 'inline-template') != null) {
    el.inlineTemplate = true
  }
}

/**
 * 处理元素上的所有属性:
 * v-bind 指令变成: el.attrs 或 el.dynamicAttrs = [{ name, value, start, end, dynamic }, ....] 
 * 或者是必须使用 props 的属性, 变成了 el.props = [{ name, value, start, end, dynamic }, ...]
 * v-on 指令变成: el.events 或 el.nativeEvents = { name: [{value, start, end, modifilers, dynamic }, ...]}
 * 其它指令: el.directives = [{name, rawName, value, arg, isDynamicArg, modifilers, start, end}, ...]
 * 其它属性: el.attrs = [{name, value, start, end, dynamic}], 或者一些必须使用props = [{ name, value, start, end, dynamic}]
 * @param {*} el 
 */
function processAttrs (el) {
  // list = [{ name, vlaue, start, end }]
  const list = el.attrsList
  let i, l, name, rawName, value, modifiers, syncGen, isDynamic
  for (i = 0, l = list.length; i < l; i++) {
    // 属性名称
    name = rawName = list[i].name
    // 属性值
    value = list[i].value
    if (dirRE.test(name)) {
      // 说明属性是一个指令
      
      // mark element as dynamic
      // 将元素标记为动态属性
      el.hasBindings = true
      // 修饰符
      // modifiers, 在属性名上解析修饰符
      // {name: 'v-bind:test.sync', val: 'foo' }
      // modifiers = { sync: true, ... }
      modifiers = parseModifiers(name.replace(dirRE, ''))
      // support .foo shorthand syntax for the .prop modifier
      // 支持 .prop 修饰符的 .foo 简写语法
      /**
       * 两种写法:
       *  1. <span v-bind:text-content.prop="foo"></span> 正常写法
       *  2. <span .text-content="foo"></span>  缩写
       */
      if (process.env.VBIND_PROP_SHORTHAND && propBindRE.test(name)) {
        (modifiers || (modifiers = {})).prop = true
        name = `.` + name.slice(1).replace(modifierRE, '')
      } else if (modifiers) {
        // 将属性名的修饰符去掉
        // name = 'v-bind:test'
        name = name.replace(modifierRE, '')
      }
      if (bindRE.test(name)) { // v-bind
        // 得到一个干净的属性名称
        // name = 'test'
        name = name.replace(bindRE, '')
        value = parseFilters(value)
        // 判断是不是动态属性
        isDynamic = dynamicArgRE.test(name)
        if (isDynamic) {
          // 截取[xxx]中的值
          name = name.slice(1, -1)
        }
        // 提示, 动态属性值不能为空字符串
        if (
          process.env.NODE_ENV !== 'production' &&
          value.trim().length === 0
        ) {
          warn(
            `The value for a v-bind expression cannot be empty. Found in "v-bind:${name}"`
          )
        }
        // 存在修饰符
        // modifiiers = { sync:true }
        if (modifiers) {
          if (modifiers.prop && !isDynamic) {
            // 将prop-name => propName
            name = camelize(name)
            if (name === 'innerHtml') name = 'innerHTML'
          }
          if (modifiers.camel && !isDynamic) {
            name = camelize(name)
          }
          if (modifiers.sync) {
            // 生成 value = "$event"
            syncGen = genAssignmentCode(value, `$event`)
            if (!isDynamic) {
              addHandler(
                el,
                `update:${camelize(name)}`,
                syncGen,
                null,
                false,
                warn,
                list[i]
              )
              if (hyphenate(name) !== camelize(name)) {
                addHandler(
                  el,
                  `update:${hyphenate(name)}`,
                  syncGen,
                  null,
                  false,
                  warn,
                  list[i]
                )
              }
            } else {
              // handler w/ dynamic event name
              addHandler(
                el,
                `"update:"+(${name})`,
                syncGen,
                null,
                false,
                warn,
                list[i],
                true // dynamic
              )
            }
          }
        }
        if ((modifiers && modifiers.prop) || (
          !el.component && platformMustUseProp(el.tag, el.attrsMap.type, name)
        )) {
          // 将属性对象添加到 el.props 数组中, 表示这些属性必须通过 props 设置
          // el.props = [{name, value, start, end, dynamic}, ...]
          addProp(el, name, value, list[i], isDynamic)
        } else {
          // 将属性添加到 el.attrs 数组或者 el.dynamicAttrs 数组
          addAttr(el, name, value, list[i], isDynamic)
        }
      } else if (onRE.test(name)) { // v-on, 处理事件
        name = name.replace(onRE, '')
        isDynamic = dynamicArgRE.test(name)
        if (isDynamic) {
          name = name.slice(1, -1)
        }
        // 处理事件, 将属性的信息添加到 el.events 或者 el.nativeEvents 对象上, 格式:
        // el.events = [{value, start, end, modifiers, dynamic}]
        addHandler(el, name, value, modifiers, false, warn, list[i], isDynamic)
      } else { // normal directives 其它的普通指令
        // 得到 el.directives = [{ name, rawName, value, arg, isDynamicArg, modifier, start, end }]
        name = name.replace(dirRE, '')
        // parse arg
        const argMatch = name.match(argRE)
        let arg = argMatch && argMatch[1]
        isDynamic = false
        if (arg) {
          name = name.slice(0, -(arg.length + 1))
          if (dynamicArgRE.test(arg)) {
            arg = arg.slice(1, -1)
            isDynamic = true
          }
        }
        addDirective(el, name, rawName, value, arg, isDynamic, modifiers, list[i])
        if (process.env.NODE_ENV !== 'production' && name === 'model') {
          checkForAliasModel(el, value)
        }
      }
    } else {
      // 当前属性不是指令
      // literal attribute
      if (process.env.NODE_ENV !== 'production') {
        const res = parseText(value, delimiters)
        if (res) {
          warn(
            `${name}="${value}": ` +
            'Interpolation inside attributes has been removed. ' +
            'Use v-bind or the colon shorthand instead. For example, ' +
            'instead of <div id="{{ val }}">, use <div :id="val">.',
            list[i]
          )
        }
      }
      addAttr(el, name, JSON.stringify(value), list[i])
      // #6887 firefox doesn't update muted state if set via attribute
      // even immediately after element creation
      if (!el.component &&
          name === 'muted' &&
          platformMustUseProp(el.tag, el.attrsMap.type, name)) {
        addProp(el, name, 'true', list[i])
      }
    }
  }
}

function checkInFor (el: ASTElement): boolean {
  let parent = el
  while (parent) {
    if (parent.for !== undefined) {
      return true
    }
    parent = parent.parent
  }
  return false
}

function parseModifiers (name: string): Object | void {
  const match = name.match(modifierRE)
  if (match) {
    const ret = {}
    match.forEach(m => { ret[m.slice(1)] = true })
    return ret
  }
}

function makeAttrsMap (attrs: Array<Object>): Object {
  const map = {}
  for (let i = 0, l = attrs.length; i < l; i++) {
    if (
      process.env.NODE_ENV !== 'production' &&
      map[attrs[i].name] && !isIE && !isEdge
    ) {
      warn('duplicate attribute: ' + attrs[i].name, attrs[i])
    }
    map[attrs[i].name] = attrs[i].value
  }
  return map
}

// for script (e.g. type="x/template") or style, do not decode content
function isTextTag (el): boolean {
  return el.tag === 'script' || el.tag === 'style'
}

function isForbiddenTag (el): boolean {
  return (
    el.tag === 'style' ||
    (el.tag === 'script' && (
      !el.attrsMap.type ||
      el.attrsMap.type === 'text/javascript'
    ))
  )
}

const ieNSBug = /^xmlns:NS\d+/
const ieNSPrefix = /^NS\d+:/

/* istanbul ignore next */
function guardIESVGBug (attrs) {
  const res = []
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]
    if (!ieNSBug.test(attr.name)) {
      attr.name = attr.name.replace(ieNSPrefix, '')
      res.push(attr)
    }
  }
  return res
}

function checkForAliasModel (el, value) {
  let _el = el
  while (_el) {
    if (_el.for && _el.alias === value) {
      warn(
        `<${el.tag} v-model="${value}">: ` +
        `You are binding v-model directly to a v-for iteration alias. ` +
        `This will not be able to modify the v-for source array because ` +
        `writing to the alias is like modifying a function local variable. ` +
        `Consider using an array of objects and use v-model on an object property instead.`,
        el.rawAttrsMap['v-model']
      )
    }
    _el = _el.parent
  }
}
