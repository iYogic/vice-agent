import { Module, Global } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { REDIS_CLIENT } from './redis.constants'
import { RedisService } from './redis.service'

/**
 * redis.module.ts 是 NestJS 应用的全局redis服务模块，应用整个应用
 *
 * 这里是三路召回中的短缓存模块，利用内存存储，做内存缓存，增加读写速度
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        return new Redis({
          host: configService.get('REDIS_HOST') ?? 'localhost',
          port: configService.get('REDIS_PORT') ?? 6379,
          password: configService.get('REDIS_PASSWORD') ?? undefined,
          maxRetriesPerRequest: configService.get('REDIS_MAXRETRIESPERREQUEST') ?? 3,
        })
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
