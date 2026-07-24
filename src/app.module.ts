import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ServeStaticModule } from '@nestjs/serve-static'
import { RedisModule } from './redis/redis.module'
import { LLMModule } from './llm/llm.module'
import { join } from 'path'

/**
 * app.module.ts 是 NestJS 应用的根模块，负责引导整个应用
 *
 * 这个文件我们设计其的功能如下：
 *    1、导入功能模块（imports）
 *    2、配置全局基础设施（Config、Database、Logger 等）
 *
 * 可以把它理解为聚合，我们尽量不要在顶层架构里设计业务：顶层 app.providers、app.controllers
 */
@Module({
  imports: [
    // --- 托管静态文件 【托管前端应用：在同一个端口上提供 API + 前端页面】
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'views/public'),
      serveRoot: '/',
      exclude: ['/vice-api/(.*)'],
    }),
    // --- 全局配置模块
    ConfigModule.forRoot({
      isGlobal: true,
      // TODO: load for sum config-files
      envFilePath: '.env',
    }),
    // --- 数据库模块 【postgresql】
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // --- 数据库模块 【redis】
    RedisModule,
    // --- 大模型模块 【LLM】
    LLMModule,
    // --- agent模块 【Agent】
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // --- Tool模块
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // --- Rag模块
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // --- Chat模块【流式~~~】
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
  ],
})
export class AppModule {}
