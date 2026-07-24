import { Module, Global } from '@nestjs/common'
import { LLMService } from './llm.service'

/**
 * llm.module.ts 是 NestJS 应用的llm模型模块，cover整个应用
 *
 * 只关注 生成输出 llm 实例
 *
 * 1、支持配置
 * 2、可选流式【默认流式】
 * 3、初始设计就支持 DeepAgent 【将LLMService产生的实例在agent模块调用 createDeepAgent】
 */
@Global()
@Module({
  providers: [LLMService],
  exports: [LLMService],
})
export class LLMModule {}
