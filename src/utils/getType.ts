/**
 * 获取数据类型
 *
 * @param {any} param 需要判断类型的数据
 * @returns {string} 数据类型【'null' | 'undefined' | 'string' | 'number' | 'object' | 'array' | 'function'| 'symbol'| 'bigint'】
 * @example
 *      getType(null) // 'null'
 *      getType(undefined) // 'undefined'
 *      getType('是字符串') // 'string'
 *      getType(10000) // 'number'
 *      getType(false) // 'boolean'
 *      getType({}) // 'object'
 *      getType([]) // 'array'
 *      getType(function box(){}) // 'function'
 *      getType(Symbol(6666)) // 'symbol'
 *      getType(BigInt(9999)) // 'bigint'
 */
export type TGetTypeRes =
  'null' | 'undefined' | 'string' | 'number' | 'boolean' | 'object' | 'array' | 'function' | 'symbol' | 'bigint'

export default function getType(param: any): TGetTypeRes {
  const orgType = (Object.prototype.toString.call(param).match(/\s+(\w+)/) || [])[1]
  return orgType?.toLowerCase() as TGetTypeRes
}
