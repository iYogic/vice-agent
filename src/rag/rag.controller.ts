import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
} from '@nestjs/common'
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express'
import { z } from 'zod'
import { RagService } from './rag.service'
import { DocumentLoaderService } from './document-loader.service'
import { JwtAuthGuard, TenantGuard } from './../auth/guards'
import { TenantId } from './../common/decorators/tenant.decorator'

/**
 * FileInterceptor、FilesInterceptor
 *
 *    1、FileInterceptor('file') 拦截请求，解析 multipart/form-data
 *    2、找到 name="file" 的字段，提取文件数据
 *    3、将其包装成 Express.Multer.File 对象
 *    4、注入到 @UploadedFile() file 参数中
 *
 *    ||
 *    ||
 *   \||/
 *
 *   最终的 file 对象结构:
 *   ```ts
 *   interface Express.Multer.File {
 *          fieldname: string;      // 'file'
 *          originalname: string;   // 'report.pdf'
 *          encoding: string;       // '7bit'
 *          mimetype: string;       // 'application/pdf'
 *          size: number;           // 字节数
 *          buffer: Buffer;         // 文件二进制数据（内存中）
 *          destination: string;    // 存储路径（如果配置了磁盘存储）
 *          filename: string;       // 存储的文件名
 *          path: string;           // 完整存储路径
 *   }
 *   ```
 */

const CreateKBSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  chunkSize: z.number().optional().default(1000),
  chunkOverlap: z.number().optional().default(200),
})

const AddDocsSchema = z.object({
  documents: z.array(
    z.object({
      content: z.string().min(1),
      metadata: z.record(z.string(), z.any()).optional(),
    }),
  ),
})

const SearchSchema = z.object({
  query: z.string().min(1),
  topK: z.number().optional().default(5),
})

const LoadUrlSchema = z.object({
  url: z.url(),
})

@Controller('knowledge-bases')
@UseGuards(JwtAuthGuard, TenantGuard)
export class RagController {
  constructor(
    private readonly ragService: RagService,
    private readonly documentLoaderService: DocumentLoaderService,
  ) {}

  /**
   * 增加
   * 创建知识库
   * POST /knowledge-bases/create-knowledge-base
   */
  @Post('create-knowledge-base')
  async createKnowledgeBase(@Body() body: any, @TenantId() tenantId: string) {
    const dto = CreateKBSchema.parse(body)
    return await this.ragService.createKnowledgeBase(dto.name, dto.description, tenantId, {
      chunkSize: dto.chunkSize,
      chunkOverlap: dto.chunkOverlap,
    })
  }

  /**
   * 获取知识库列表
   * GET /knowledge-bases/listKnowledge
   */
  @Get('list-knowledge')
  async listKnowledgeBases(@TenantId() tenantId: string) {
    return await this.ragService.listKnowledgeBases(tenantId)
  }

  /**
   * 获取知识库详情
   * GET /knowledge-bases/detail-knowledge-base/:id
   */
  @Get('detail-knowledge-base/:id')
  async detailKnowledgeBase(@Param('id') id: string, @TenantId() tenantId: string) {
    return await this.ragService.detailKnowledgeBase(id, tenantId)
  }

  /**
   * 更新知识库
   * POST /knowledge-bases/update-knowledge-base/:id
   */
  @Post('update-knowledge-base/:id')
  async updateKnowledgeBase(@Param('id') id: string, @Body() body: any, @TenantId() tenantId: string) {
    const dto = CreateKBSchema.parse(body)
    // name 等四个参数都传一下，这四个用户可能都会改
    return await this.ragService.updateKnowledgeBase(id, tenantId, {
      name: dto.name,
      description: dto.description,
      chunkSize: dto.chunkSize,
      chunkOverlap: dto.chunkOverlap,
    })
  }

  /**
   * 删除知识库
   * GET /knowledge-bases/delete-knowledge-base/:id
   */
  @Get('delete-knowledge-base/:id')
  async deleteKnowledgeBase(@Param('id') id: string, @TenantId() tenantId: string) {
    return await this.ragService.deleteKnowledgeBase(id, tenantId)
  }

  // -------
  /**
   * 向某个知识中追加知识（纯文本）
   * get /knowledge-bases/add-documents/:id
   */
  @Post('add-documents/:id')
  async addDocuments(@Param('id') id: string, @Body() body: any, @TenantId() tenantId: string) {
    const dto = AddDocsSchema.parse(body)
    return await this.ragService.addDocuments(id, tenantId, dto.documents)
  }

  /**
   * 上传单文件到知识库
   * 支持格式：PDF、TXT、MD、CSV、HTML、JSON
   *
   * POST /knowledge-bases/upload/:id
   */
  @Post('upload/:id')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @TenantId() tenantId: string,
  ) {
    if (!file) {
      throw new Error('未选择文件')
    }
    const docs = await this.documentLoaderService.loadFile(file.buffer, file.originalname, file.mimetype)
    const result = await this.ragService.addDocuments(
      id,
      tenantId,
      docs.map((item) => ({ content: item.content, metadata: item.metadata })),
    )

    return {
      ...(result || {}),
      fileName: file.originalname,
      documentsLoaded: docs.length,
    }
  }

  /**
   * 批量上传文件到知识库（最多 10 个）
   *
   * 支持格式：PDF、TXT、MD、CSV、HTML、JSON
   * 单个文件失败不影响其他文件
   *
   * POST /knowledge-bases/upload-batch/:id
   */
  @Post('upload-batch/:id')
  @UseInterceptors(FilesInterceptor('files', 10))
  async batchUploadFiles(
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: any,
    @TenantId() tenantId: string,
  ) {
    if (!files || files?.length === 0) {
      throw new Error('未选择文件')
    }

    const results: Array<{
      fileName: string
      chunksCreated: number
      documentsLoaded: number
      error?: string
    }> = []

    // 循环逐个处理
    for (const file of files) {
      try {
        // Remark: 这个地方可以考虑复用单文件那个 fun
        // 1. 加载文档
        const docs = await this.documentLoaderService.loadFile(file.buffer, file.originalname, file.mimetype)
        // 2. 存储到知识库（配置自动从知识库读取）
        const result = await this.ragService.addDocuments(
          id,
          tenantId,
          docs.map((item) => ({ content: item.content, metadata: item.metadata })),
        )

        results.push({
          fileName: file.originalname,
          chunksCreated: result.chunksCreated,
          documentsLoaded: docs.length,
        })
      } catch (err: any) {
        results.push({
          fileName: file.originalname,
          chunksCreated: 0,
          documentsLoaded: 0,
          error: err?.message || `${file.originalname} 上传失败`,
        })
      }
    }

    return {
      results,
    }
  }

  /**
   * 从 URL 加载网页内容到知识库
   *
   * POST /knowledge-bases/load-url/:id
   *
   * ✅ 用户只需传 URL，配置从知识库自动读取
   * ✅ Controller 负责组合：加载文档 + 存储
   */
  @Post('load-url/:id')
  async loadUrl(@Param('id') id: string, @Body() body: any, @TenantId() tenantId: string) {
    const dto = LoadUrlSchema.parse(body)
    // 1. 加载文档
    const docs = await this.documentLoaderService.loadUrl(dto.url)
    // 2. 存储到知识库（配置自动从知识库读取）
    const result = await this.ragService.addDocuments(
      id,
      tenantId,
      docs.map((item) => ({ content: item.content, metadata: item.metadata })),
    )

    return {
      ...(result || {}),
      url: dto.url,
      documentsLoaded: docs.length,
    }
  }

  /**
   * 语义检索
   *
   * POST /knowledge-bases/search/:id
   *
   * 注意：这里使用 POST 因为需要传递复杂的查询参数
   * 且查询内容可能包含敏感信息，不适合放在 URL 中
   *
   * Remark: 这个里面会有向量查询，关注
   */
  @Post('search/:id')
  async search(@Param('id') id: string, @Body() body: any, @TenantId() tenantId: string) {
    const dto = SearchSchema.parse(body)
    return await this.ragService.search(id, tenantId, dto.query, dto.topK)
  }

  /**
   * 获取知识库统计信息
   *
   * GET /knowledge-bases/stats/:id
   *
   * @returns
   *    {
   *      totalChunks: 156,        // 总切片数（这个知识库有多少个文本块）
   *      totalSources: 5,         // 来源数量（来自多少个不同的文件/URL）
   *      earliestChunk: "2024-01-15T10:30:00Z",  // 最早切片时间
   *      latestChunk: "2024-01-20T14:20:00Z",    // 最新切片时间
   *    }
   */
  @Get('stats/:id')
  async getStats(@Param('id') id: string, @TenantId() tenantId: string) {
    return await this.ragService.getKnowledgeBaseStats(id, tenantId)
  }
}
