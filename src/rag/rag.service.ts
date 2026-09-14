import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common'
// ----- 数据库相关
// import { v4 as uuidv4 } from 'uuid'
// node js 内置性能更好
import { randomUUID as uuidv4 } from 'crypto'

// ----- 能力相关
import { VectorService } from './vector.service'
import { OpenAIEmbeddings } from '@langchain/openai'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { ConfigService } from '@nestjs/config'

/**
 * 知识库配置选项
 */
export interface KnowledgeBaseOptions {
  chunkSize?: number
  chunkOverlap?: number
  embeddingModel?: string
}

/**
 * 文档添加选项（可选覆盖知识库配置）
 */
export interface AddDocumentsOptions {
  kbName?: string
  kbDescription?: string
  chunkSize?: number
  chunkOverlap?: number
}

/**
 * 知识库更新选项（所有字段可选，只传要修改的）
 */
export interface UpdateKnowledgeBaseOptions {
  name?: string
  description?: string
  chunkSize?: number
  chunkOverlap?: number
}

/**
 * RAG 核心业务服务
 *
 * 职责：
 * 1. 知识库 CRUD
 * 2. 文档存储（接收已处理好的文档）
 * 3. 语义检索
 *
 * 不负责：
 * - 文档加载（由 DocumentLoaderService 负责）
 * - 文件解析（由 DocumentLoaderService 负责）
 *
 * 注意：
 * - 数据的具体操作 【所有数据都在 VectorService 中操作】
 * - rag.service 这里只负责调用VectorService的数据操作能力，数据具体操作不负责
 *
 * 设计原则：
 * 1. embeddingModel 从环境变量读取，全局统一
 * 2. chunkSize 和 chunkOverlap 从知识库配置读取，用户无需重复传递
 * 3. 所有操作带 tenantId 实现租户隔离
 * 4. 配置一次，处处使用
 * 5. ✅ 使用 OnModuleInit 初始化 Embeddings（确保 ConfigService 已就绪）
 */

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name)
  private embeddings: OpenAIEmbeddings
  private embeddingModel: string

  constructor(
    private readonly vectorService: VectorService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    const apiKey = await this.configService.get('llm.openai.key')
    const baseUrl = await this.configService.get('llm.openai.baseUrl')
    this.embeddingModel = await this.configService.get('llm.defaultEmbeddingModel')!

    this.embeddings = new OpenAIEmbeddings({
      apiKey: apiKey,
      model: this.embeddingModel,
      configuration: {
        baseURL: baseUrl,
      },
    })

    this.logger.log(`✅ Embeddings initialized with model: ${this.embeddingModel}`)
  }

  /**
   * 创建知识库
   *
   * @param name - 知识库名称
   * @param description - 知识库描述
   * @param tenantId - 租户 ID
   * @param options - 可选配置（chunkSize, chunkOverlap）
   *
   * postgre-sql + vector 无需双写，具体操作数据库都在 VectorService 中操作
   * 向量和数据之间通过 collectionName 联系在一起了
   *
   */
  async createKnowledgeBase(name: string, description: string, tenantId: string, options: KnowledgeBaseOptions = {}) {
    const collectionName = `kb_${tenantId}_${Date.now()}`.replace(/-/g, '_')
    await this.vectorService.createCollection(collectionName)
    return {
      id: collectionName,
      name,
      description,
      tenantId,
      chunkSize: options?.chunkSize || 1000,
      chunkOverlap: options?.chunkOverlap || 200,
      embeddingModel: options?.embeddingModel || 'BAAI/bge-m3',
      collectionName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  /**
   * 添加文档到知识库
   *
   * @param knowledgeBaseId - 知识库 ID
   * @param tenantId - 租户 ID
   * @param documents - 文档列表 [{ content, metadata }]
   * @param options - 可选覆盖配置（一般不需要传）
   *
   * postgre-sql + vector 无需双写，具体操作数据库都在 VectorService 中操作
   */
  async addDocuments(
    knowledgeBaseId: string,
    tenantId: string,
    documents: {
      content: string
      metadata?: Record<string, any> | undefined
    }[],
    options: AddDocumentsOptions = {},
  ) {
    // ✅ 从知识库获取配置
    const kb = await this.vectorService.getCollection(knowledgeBaseId, tenantId)
    if (!kb) {
      throw new NotFoundException('Knowledge base not found')
    }

    // ✅ 配置优先级：options > 知识库配置 > 默认值
    const {
      kbName = kb.name,
      kbDescription = kb.description,
      chunkSize = kb.chunkSize || 1000,
      chunkOverlap = kb.chunkOverlap || 200,
    } = options

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: chunkSize,
      chunkOverlap: chunkOverlap,
    })

    const allChunks: Array<{
      id: string
      content: string
      vector: number[]
      metadata: any
      knowledge_base_id: string
      knowledge_base_name: string
      knowledge_base_description: string
      tenant_id?: string
      chunk_index?: number
      chunk_size?: number
      chunk_overlap?: number
      source_type?: string
      source_name?: string
    }> = []

    for (const doc of documents) {
      const chunks = await splitter.splitText(doc.content)
      const vectors = await this.embeddings.embedDocuments(chunks)
      for (let i = 0; i < chunks.length; i++) {
        allChunks.push({
          id: uuidv4(),
          content: chunks[i] || '',
          vector: vectors[i] || [],
          metadata: { ...(doc.metadata || {}), chunkIndex: i },
          knowledge_base_id: knowledgeBaseId,
          knowledge_base_name: kbName,
          knowledge_base_description: kbDescription,
          tenant_id: tenantId,
          chunk_index: i,
          chunk_size: chunkSize,
          chunk_overlap: chunkOverlap,
          source_type: doc.metadata?.type || 'unknown',
          source_name: doc.metadata?.source || 'unknown',
        })
      }
    }

    if (allChunks.length > 0) {
      await this.vectorService.insert(knowledgeBaseId, allChunks)
    }

    this.logger.log(`Added ${documents.length} documents (${allChunks.length} chunks) to KB ${knowledgeBaseId}`)

    return { chunksCreated: allChunks.length }
  }

  /**
   * 语义检索
   *
   * postgre-sql + vector，具体操作数据库都在 VectorService 中操作
   */
  async search(knowledgeBaseId: string, tenantId: string, query: string, topK = 5, similarityThreshold = 0.5) {
    const queryVector = await this.embeddings.embedQuery(query)
    const results = await this.vectorService.search(knowledgeBaseId, queryVector, topK, similarityThreshold)
    return results
  }

  /**
   * 获取当前租户下的所有知识库列表
   */
  async listKnowledgeBases(tenantId: string) {
    return await this.vectorService.listCollections(tenantId)
  }

  /**
   * 获取知识库详情
   */
  async detailKnowledgeBase(id: string, tenantId: string) {
    return await this.vectorService.getCollection(id, tenantId)
  }

  /**
   * 更新知识库
   *
   * ✅ 只更新用户传了的字段，未传的保持原值
   */
  async updateKnowledgeBase(id: string, tenantId: string, updates: UpdateKnowledgeBaseOptions = {}) {
    return await this.vectorService.updateCollection(id, tenantId, updates)
  }

  /**
   * 删除知识库
   */
  async deleteKnowledgeBase(id: string, tenantId: string) {
    return await this.vectorService.deleteCollection(id, tenantId)
  }

  /**
   * 获取知识库统计信息
   */
  async getKnowledgeBaseStats(id: string, tenantId: string) {
    return await this.vectorService.getCollectionStats(id, tenantId)
  }
}
