import isEffectArray from '../array-utils/isEffectArray'

/**
 * 清除object里为空的字段
 *
 * @description 【'' 字符串默认被删除】【delKeys的集合要去掉】
 * @param {any} data 传参对象
 * @returns Object without empty
 * @example
 *      var a = {x:'111',y:'', z: null, p: undefined} // utilFilterEmpty(a) => {x:'111'}
 *      var a = {x:'111',y:'', z: null, p: undefined} // utilFilterEmpty(a,false) => {x:'111',y:''}
 *      var a = {x:'111',y:'', z: null, p: 2222} // utilFilterEmpty(a,true,['p']) => {x:'111'}
 */
const objectFilterEmpty = (data: any, delEmptyStr = true, delKeys: any = null) => {
  if ((data ?? '') === '') {
    console.error(`param should need provider!`)
    return {}
  }

  if (typeof data !== 'object') {
    console.error(`param must object!`)
    return {}
  }

  if (Object.keys(data).length > 0) {
    let dataSuperArrs = delEmptyStr
      ? Object.entries(data).filter((item) => (item[1] ?? '') !== '')
      : Object.entries(data).filter((item) => (item[1] ?? null) !== null)

    dataSuperArrs =
      isEffectArray(delKeys) && isEffectArray(dataSuperArrs)
        ? dataSuperArrs.filter((item) => !delKeys.includes(item[0]))
        : dataSuperArrs

    const dataObjArrs = dataSuperArrs.map(([key, value]) => {
      return { [`${key}`]: value }
    })

    if (isEffectArray(dataObjArrs)) {
      return dataObjArrs.reduce((a, b) => {
        return { ...a, ...b }
      }, {})
    }
  }

  return {}
}

export default objectFilterEmpty
