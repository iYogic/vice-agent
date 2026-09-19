import { Injectable, Inject } from '@nestjs/common'
import Redis from 'ioredis'
import { REDIS_CLIENT } from './redis.constants'

@Injectable()
export class RedisService {
  constructor(@Inject(REDIS_CLIENT) private readonly redisClient: Redis) {}

  async set(key: string, value: string, ttl?: number): Promise<string> {
    if (ttl) {
      return await this.redisClient.set(key, value, 'EX', ttl)
    } else {
      return await this.redisClient.set(key, value)
    }
  }

  async get(key: string): Promise<string | null> {
    return await this.redisClient.get(key)
  }

  async del(key: string): Promise<number> {
    return await this.redisClient.del(key)
  }

  async setJson(key: string, value: unknown, ttl?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttl)
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.redisClient.get(key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
}
