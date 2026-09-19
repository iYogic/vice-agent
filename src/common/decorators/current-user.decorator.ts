import { createParamDecorator, ExecutionContext } from '@nestjs/common'

/**
 * 自定义参数装饰器 提取 [当前用户信息 或者 当前用户指定信息字段]
 */
export const CurrentUser = createParamDecorator((data: string, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest()
  const user = request.user
  return data ? user?.[data] : user
})
