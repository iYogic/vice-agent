import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
// 全局配置
import { ConfigService } from '@nestjs/config'
// 全局异常过滤器
// import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
// 全局logger
import { Logger } from '@nestjs/common'

// CORE
async function bootstrap() {
  const logger = new Logger('Bootstrap')
  const app = await NestFactory.create(AppModule)

  const configService = app.get(ConfigService)
  const port = (configService.get('port') as number) ?? 3000

  // TODO: 全局异常过滤器
  // app.useGlobalFilters(new GlobalExceptionFilter())

  // 全局CORS配置
  app.enableCors({
    origin: configService.get('cors.origin') ?? '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    allowedHeaders: 'Content-Type,Authorization',
  })

  await app.listen(port)

  logger.log(`Application is running on: http://localhost:${port}`)
  logger.log(`API base URL: http://localhost:${port}/api`)
}

// RUNNING
bootstrap().catch((err) => {
  const logger = new Logger('Bootstrap Error')
  logger.error(err)
  process.exit(1)
})
