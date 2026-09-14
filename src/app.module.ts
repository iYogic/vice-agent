import { Module } from '@nestjs/common'
import { join } from 'path'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'
import configuration from './common/config/configuration'
import { ServeStaticModule } from '@nestjs/serve-static'
import { RedisModule } from './redis/redis.module'
import { LLMModule } from './llm/llm.module'

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
    // @URL: https://docs.nestjs.com/techniques/configuration
    ConfigModule.forRoot({
      isGlobal: true,
      // Type one: load for sum config-files
      // envFilePath: '.env',
      // Type two: load configuration
      load: [configuration],
    }),
    // --- 数据库模块 【postgresql】
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule], // 告知TypeOrmModule需要依赖ConfigModule模块能力，前面有了isGlobal这行也可以不写
      inject: [ConfigService], // 告知useFactory需要用到ConfigModule模块暴露出来的ConfigService能力
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('database.host'),
        port: configService.get('database.port'),
        username: configService.get('database.username'),
        password: configService.get('database.password'),
        database: configService.get('database.database'),
        // 实体扫描路径（重要！）
        // TypeOrm 启动的时候要知道有哪些表
        entities: [__dirname + '/entities/*.entity{.ts,.js}'],
        // 开发环境自动同步表结构（生产环境记得关）
        synchronize: configService.get('node_env') !== 'production',
        // 开发环境打印 SQL 日志
        logging: configService.get('node_env') === 'development',
        // 连接池配置
        // Remark: 规避每次都重新链接，降低耗时~
        extra: {
          max: 20, // 最大连接数
          idleTimeoutMillis: 30000, // 空闲连接超时
        },
      }),
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
