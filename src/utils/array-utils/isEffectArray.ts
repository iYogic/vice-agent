/**
 * 判断数组是不是有效数据,当元素是数组，且长度大于0，即为有效数组
 *
 * @param {any[]} array 入参数组
 * @returns {boolean}
 * @example
 *      var a = null // isEffectArray(a) => false
 *      var a = [] // isEffectArray(a) => false
 *      var a = [1,2] // isEffectArray(a) => true
 */
export default function isEffectArray(array?: any[]): boolean {
  if (array && Array.isArray(array) && array.length > 0) {
    return true
  }
  return false
}
