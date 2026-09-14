/**
 * 判断是否为有效对象,甄别是对象，且长度大于零的
 *
 * @param {any} obj 传参对象
 * @returns boolean
 */
export default function isEffectObject(obj?: OBJ): boolean {
  if (Object.prototype.toString.call(obj) === '[object Object]') {
    if (Object.keys(obj!).length) {
      return true
    }
  }
  return false
}
