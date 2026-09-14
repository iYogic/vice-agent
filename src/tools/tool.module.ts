import { Module, Global } from '@nestjs/common'
import { ToolRegistry } from './tool-registry'

/**
 * Tools 集中管理 所以全局
 */
@Global()
@Module({
  providers: [ToolRegistry],
  exports: [ToolRegistry],
})
export class ToolsModule {}
