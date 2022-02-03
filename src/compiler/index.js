/* @flow */

import { parse } from './parser/index'
import { optimize } from './optimizer'
import { generate } from './codegen/index'
import { createCompilerCreator } from './create-compiler'

// `createCompilerCreator` allows creating compilers that use alternative
// parser/optimizer/codegen, e.g the SSR optimizing compiler.
// Here we just export a default compiler using the default parts.
export const createCompiler = createCompilerCreator(function baseCompile (
  template: string,
  options: CompilerOptions
): CompiledResult {
  // 执行 baseCompile 之前的所有事情, 只有一个目的, 就是构造最终的编译配置
  // 解析, 将 html 模板字符串解析为 ast 对象
  const ast = parse(template.trim(), options)
  console.log(ast, 'ast')
  // 优化, 遍历 AST, 为每个节点做静态标记
  // 标记每个是否静态节点, 然后进一步标记出静态根节点
  // 这样在后续更新的过程中就可以跳过这些静态节点了
  // 标记静态根, 用于生成渲染函数阶段, 生成静态根节点的渲染函数
  if (options.optimize !== false) {
    optimize(ast, options)
  }
  // 代码生成, 将 ast 转换成可执行的 render 函数的字符串形式 
  
  debugger
  const code = generate(ast, options)
  console.log(code)
  return {
    ast,
    render: code.render,
    staticRenderFns: code.staticRenderFns
  }
})
