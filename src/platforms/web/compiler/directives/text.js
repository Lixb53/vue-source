/* @flow */

import { addProp } from 'compiler/helpers'

export default function text (el: ASTElement, dir: ASTDirective) {
  if (dir.value) {
    // el.textContent = _s(value)
    addProp(el, 'textContent', `_s(${dir.value})`, dir)
  }
}
