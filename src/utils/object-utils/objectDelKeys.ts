import getType from '../getType'

/**
 * 清除object里特定的某些字段
 *
 * @description delKeys的集合要去掉
 * @param {any} data 传参对象
 * @param {string | array} delKeys 需要删除的键或键的集合
 * @returns Object without given keys
 * @example
 *      var a = {x:'111',y:'', z: null, p: undefined} // objectDelKeys(a,"x") => {y:'', z: null, p: undefined}
 *      var a = {x:'111',y:'', z: null, p: undefined} // objectDelKeys(a,["x"]) => {y:'', z: null, p: undefined}
 *      var a = {x:'111',y:'', z: null, p: 2222} // objectDelKeys(a,["x","y"] => {z: null, p: 2222}
 */
const objectDelKeys = (data: any, delKeys: any) => {
  if ((data ?? '') === '') {
    console.error(`param should need provider!`)
    return data
  }

  if (typeof data !== 'object') {
    console.error(`param must object!`)
    return data
  }

  if ((delKeys ?? '') === '') {
    console.error(`delKeys should need provider!`)
    return data
  }

  if (!['string', 'array'].includes(getType(delKeys))) {
    console.error(`delKeys should string or array!`)
    return data
  }

  // 开始
  if (Object.keys(data).length > 0) {
    let dataSuperArrs = Object.entries(data)
    dataSuperArrs =
      getType(delKeys) === 'array'
        ? dataSuperArrs.filter((item) => !delKeys.includes(item[0]))
        : getType(delKeys) === 'string'
        ? dataSuperArrs.filter((item) => delKeys !== item[0])
        : dataSuperArrs

    const dataObj = Object.fromEntries(dataSuperArrs)
    return dataObj
  }

  return data
}

export default objectDelKeys
