/* @flow */

import { makeMap, isBuiltInTag, cached, no } from 'shared/util'

let isStaticKey
let isPlatformReservedTag

const genStaticKeysCached = cached(genStaticKeys)

/**
 * Goal of the optimizer: walk the generated template AST tree
 * and detect sub-trees that are purely static, i.e. parts of
 * the DOM that never needs to change.
 *
 * Once we detect these sub-trees, we can:
 *
 * 1. Hoist them into constants, so that we no longer need to
 *    create fresh nodes for them on each re-render;
 * 2. Completely skip them in the patching process.
 */

export function optimize (root: ?ASTElement, options: CompilerOptions) {
  if (!root) return
  /**
   * options.staticKeys = 'staticClass, staticStyle'
   * isStaticKey = function(val) { return map[val]}
   */
  isStaticKey = genStaticKeysCached(options.staticKeys || '')
  // 平台保留标签  web html中的标签
  isPlatformReservedTag = options.isReservedTag || no
  // first pass: mark all non-static nodes.
  // 遍历所有节点, 给每个节点设置 static 属性, 标记其是否为静态节点
  markStatic(root)
  // second pass: mark static roots.
  // 进一步标记静态根, 一个节点要成为静态根节点, 需要具体一下条件:
  // 节点本身是静态节点 && 有子节点 && 子节点不只是一个文本节点, 则标记为静态根
  // 静态根节点不能只有静态文本的子节点, 因为这样收益太低, 这种情况下始终更新它就好
  markStaticRoots(root, false)
}

function genStaticKeys (keys: string): Function {
  return makeMap(
    'type,tag,attrsList,attrsMap,plain,parent,children,attrs,start,end,rawAttrsMap' +
    (keys ? ',' + keys : '')
  )
}

/**
 * 在所有子节点上设置 static 属性, 用来表示是否为静态节点
 * 注意: 如果有子节点为动态节点, 则父节点也被认为是动态节点
 * @param {*} node 
 * @returns 
 */
function markStatic (node: ASTNode) {
  // 通过 node.static 来表示节点是否为静态节点
  node.static = isStatic(node)
  if (node.type === 1) {
    // do not make component slot content static. this avoids
    // 1. components not able to mutate slot nodes
    // 2. static slot content fails for hot-reloading
    
    // 不要将组件插槽内容设置为静态。这避免了
    // 1.无法改变插槽节点的组件
    // 2.热重新加载时静态插槽内容失败
    if (
      !isPlatformReservedTag(node.tag) &&
      node.tag !== 'slot' &&
      node.attrsMap['inline-template'] == null
    ) {
      // 递归终止条件, 如果节点不是平台保留标签 && 也不是 slot 标签 && 也不是内联模板, 则直接结束
      return
    }
    // 遍历子几点, 递归调用 markStatic 来标记这些子节点的 static 属性
    for (let i = 0, l = node.children.length; i < l; i++) {
      const child = node.children[i]
      markStatic(child)
      // 如果子节点是非静态节点, 则将父节点更新为非静态节点
      if (!child.static) {
        node.static = false
      }
    }
    // 如果节点存在 v-if v-else-if v-else 这些指令, 则依次标记 block 中节点的 static
    if (node.ifConditions) {
      for (let i = 1, l = node.ifConditions.length; i < l; i++) {
        const block = node.ifConditions[i].block
        markStatic(block)
        if (!block.static) {
          node.static = false
        }
      }
    }
  }
}

/**
 * 进一步标记静态根, 一个节点要成为静态根节点, 需要具备以下条件:
 * 节点本身是静态节点 && 有子节点 && 子节点不只是一个文本节点, 则标记为静态根
 * 静态根节点不能只有静态文本的子节点, 因为这样收益太低, 这种情况下始终更新它就好了
 * @param {*} node 
 * @param {*} isInFor 
 * @returns 
 */
function markStaticRoots (node: ASTNode, isInFor: boolean) {
  if (node.type === 1) {
    if (node.static || node.once) {
      // 节点是静态的 || 节点上有 v-once 指令, 标记 node.statciInFor = true or false
      node.staticInFor = isInFor
    }
    // For a node to qualify as a static root, it should have children that
    // are not just static text. Otherwise the cost of hoisting out will
    // outweigh the benefits and it's better off to just always render it fresh.
    if (node.static && node.children.length && !(
      node.children.length === 1 &&
      node.children[0].type === 3
    )) {
      // 节点本身是静态节点 && 有子节点 && 子节点不只是一个文本节点, 则标记为静态根 
      node.staticRoot = true
      return
    } else {
      node.staticRoot = false
    }
    // 当前节点不是静态根节点的时候, 递归遍历其子节点, 标记静态根
    if (node.children) {
      for (let i = 0, l = node.children.length; i < l; i++) {
        markStaticRoots(node.children[i], isInFor || !!node.for)
      }
    }
    // 如果节点存在 v-if v-else-if v-else 指令, 则为 block 节点标记静态根
    if (node.ifConditions) {
      for (let i = 1, l = node.ifConditions.length; i < l; i++) {
        markStaticRoots(node.ifConditions[i].block, isInFor)
      }
    }
  }
}

/**
 * 判断节点是否为静态节点:
 *  1. 通过自定义的 node.type 来判断
 *  2. 表达式 => 动态
 *  3. 文本 => 静态
 *  4. 组件 => 动态
 *  5. 父节点含有 v-for 指令额 template 标签 => 动态
 * @param {*} node 
 * @returns boolean
 */
function isStatic (node: ASTNode): boolean {
  if (node.type === 2) { // expression
    // 比如: {{ msg }} v-bind:[msg] ...
    return false
  }
  if (node.type === 3) { // text
    // 纯文本节点
    return true
  }
  return !!(node.pre || (   // 带有 v-pre 的标签
    !node.hasBindings && // no dynamic bindings 
    !node.if && !node.for && // not v-if or v-for or v-else
    !isBuiltInTag(node.tag) && // not a built-in 内置组件: component | slot ..
    isPlatformReservedTag(node.tag) && // not a component 不是组件
    !isDirectChildOfTemplateFor(node) && // 不是在 v-for 所在节点内的 template 标签
    Object.keys(node).every(isStaticKey)
  ))
}

function isDirectChildOfTemplateFor (node: ASTElement): boolean {
  while (node.parent) {
    node = node.parent
    if (node.tag !== 'template') {
      return false
    }
    if (node.for) {
      return true
    }
  }
  return false
}
