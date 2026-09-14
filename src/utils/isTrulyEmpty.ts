/**
 * 判断是否真正为空,甄别【 ""、undefined、null 】
 *
 * @param {any} param 入参
 * @returns {boolean}
 * @example
 *      isTrulyEmpty() //true
 *      isTrulyEmpty("") //true
 *      isTrulyEmpty(undefined) //true
 */
export default function isTrulyEmpty(param?: any): boolean {
  return (param ?? '') === '' ? true : false
}
