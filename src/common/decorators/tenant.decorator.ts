import { createParamDecorator, ExecutionContext } from '@nestjs/common'

/**
 * 自定义参数装饰器 提取 租户ID
 */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest()
  return request.user?.tenantId
})
