import { Module } from '@nestjs/common'
// ----- 数据库相关
import { TypeOrmModule } from '@nestjs/typeorm'

// ----- 能力相关
import { memoryStorage } from 'multer'
import { MulterModule } from '@nestjs/platform-express'
import { KnowledgeItem } from '../entities/knowledge-item.entity'
import { RagController } from './rag.controller'
import { RagService } from './rag.service'
import { DocumentLoaderService } from './document-loader.service'
import { VectorService } from './vector.service'

@Module({
  imports: [
    // 注册实体，使 EntityManager 能够识别
    TypeOrmModule.forFeature([KnowledgeItem]),
    // 配置文件上传
    MulterModule.register({
      storage: memoryStorage(), // 使用内存存储，便于处理
      limits: { fileSize: 20 * 1024 * 1024 }, // 限制 20MB
    }),
  ],
  controllers: [RagController],
  providers: [RagService, VectorService, DocumentLoaderService],
  exports: [RagService, VectorService],
})
export class RagModule {}
