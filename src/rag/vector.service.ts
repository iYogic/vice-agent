import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common'
import { InjectEntityManager } from '@nestjs/typeorm'
import { EntityManager } from 'typeorm'
import { KnowledgeItem } from './../entities/knowledge-item.entity'

/**
 * 向量数据库服务
 *
 * 职责：
 * 1. 管理 pgvector 扩展和索引
 * 2. 知识库（collection）的 CRUD 操作
 * 3. 向量数据的插入和检索
 * 4. 知识库统计信息查询
 *
 * 设计原则：
 * 1. 使用 @InjectEntityManager() 统一数据库操作，而非 @InjectRepository
 * 2. 所有操作前检查 pgvector 是否就绪
 * 3. 租户隔离：所有查询都带 tenantId 条件
 * 4. 使用原生 SQL 进行向量检索，利用 pgvector 的 <=> 操作符
 */
@Injectable()
export class VectorService implements OnModuleInit {
  private readonly logger = new Logger(VectorService.name)
  private isReady = false

  constructor(
    /**
     * 注入 EntityManager 统一管理数据库操作
     * 优势：
     * 1. 统一数据访问方式，便于维护
     * 2. 支持事务管理
     * 3. 可以使用 QueryBuilder 和原生 SQL
     * 4. 避免 Repository 和 EntityManager 混用
     */
    @InjectEntityManager()
    private entityManager: EntityManager,
  ) {}

  /**
   * 模块初始化时执行
   * 1. 启用 pgvector 扩展
   * 2. 创建向量索引（HNSW 算法）
   * 3. 创建普通索引
   */
  async onModuleInit() {
    try {
      // 启用 pgvector 扩展（如果未启用）
      // 注意这里面是会用原生的 sql 语句传递给pg 使其启用 pgvector
      await this.entityManager.query(`CREATE EXTENSION IF NOT EXISTS vector`)

      /**
       * 创建 HNSW 向量索引
       *
       * HNSW（Hierarchical Navigable Small World）算法特点：
       * 1. 基于图的近似最近邻搜索
       * 2. 查询速度快（O(log N)）
       * 3. 召回率高
       * 4. 适合大规模向量检索
       *
       * vector_cosine_ops：使用余弦相似度作为距离度量
       * 对应操作符：<=>（余弦距离）
       * 相似度范围：-1 到 1，值越大越相似
       */
      await this.entityManager.query(
        `
        CREATE INDEX IF NOT EXISTS idx_embedding_hnsw
        ON knowledge_items
        USING hnsw (embedding vector_cosine_ops)
        `,
      )

      /**
       * 创建知识库 ID 普通索引
       *
       * 加速 WHERE knowledge_base_id = ? 查询
       * 用于：检索特定知识库、删除知识库、统计等
       */
      await this.entityManager.query(
        `
        CREATE INDEX IF NOT EXISTS idx_knowledge_base_id
        ON knowledge_items (knowledge_base_id)
        `,
      )

      /**
       * 创建租户 ID 普通索引
       *
       * 加速 WHERE tenant_id = ? 查询
       * 用于：租户隔离查询
       */
      await this.entityManager.query(
        `
        CREATE INDEX IF NOT EXISTS idx_tenant_id
        ON knowledge_items (tenant_id)
        `,
      )

      this.isReady = true
      this.logger.log(`✅ pgvector ready`)
    } catch (error: any) {
      this.logger.log(`pgvector not available:${error?.message}`)
      this.isReady = false
    }
  }

  /**
   * 检查 pgvector 是否可用
   */
  isAvailable(): boolean {
    return this.isReady
  }

  /**
   * 内部方法：检查服务是否就绪
   * 如未就绪则抛出异常
   */
  private requireReady(): void {
    if (!this.isReady) {
      throw new Error(`Vector service is not available.`)
    }
  }

  /**
   * 创建知识库（检查并准备 collection）
   *
   * @param collectionName - 知识库唯一标识
   *
   * 注意：由于使用单表设计，"创建"知识库实际上只是检查是否有数据
   * 真正的"创建"发生在插入第一条数据时
   */
  async createCollection(collectionName: string) {
    this.requireReady()

    // 检查知识库是否存在
    const existing = await this.entityManager.count(KnowledgeItem, {
      where: { knowledgeBaseId: collectionName },
    })

    if (existing > 0) {
      this.logger.log(`Collection ${collectionName} is already exists`)
      return
    }

    this.logger.log(`Collection ${collectionName} is not exists`)
  }

  /**
   * 插入向量数据
   *
   * @param collectionName - 知识库 ID
   * @param data - 向量数据数组
   *
   * 数据流程：
   * 1. 将数据映射为 KnowledgeItem 实体
   * 2. 使用 EntityManager.save() 批量插入
   * 3. 返回插入数量
   *
   * 性能优化：
   * - 使用批量插入，减少数据库往返
   * - 建议每批 100-500 条数据
   */

  async insert(
    collectionName: string,
    data: Array<{
      id: string // 唯一标识, uuid
      content: string // 文本内容
      vector: number[] // 向量数据
      metadata: any // 元数据
      knowledge_base_id: string // 知识库 ID
      knowledge_base_name?: string // 知识库名称
      knowledge_base_description?: string // 知识库描述
      tenant_id?: string // 租户 ID
      chunk_index?: number // 切片索引
      source_type?: string // 来源类型
      source_name?: string // 来源名称
    }>,
  ) {
    this.requireReady()

    // 将数据映射为实体实例
    const entities = data.map((item) => {
      return this.entityManager.create(KnowledgeItem, {
        id: item.id,
        content: item.content,
        embedding: item.vector,
        metadata: item.metadata || {},
        knowledgeBaseId: item.knowledge_base_id,
        knowledgeBaseName: item.knowledge_base_name,
        knowledgeDescription: item.knowledge_base_description,
        tenantId: item?.tenant_id,
        chunkIndex: item?.chunk_index || 0,
        sourceType: item?.source_type,
        sourceName: item?.source_name,
      })
    })

    // 批量保存
    const saved = await this.entityManager.save(entities)
    this.logger.log(`Inserted ${saved.length} items`)
    return { insertCount: saved.length }
  }

  /**
   * 向量检索
   *
   * @param collectionName - 知识库 ID
   * @param vector - 查询向量
   * @param topK - 返回结果数量
   * @param similarityThreshold - 相似度阈值（0-1）
   *
   * 检索原理：
   * 1. 使用 pgvector 的 <=> 操作符计算余弦距离
   * 2. 将距离转换为相似度：1 - 距离
   * 3. 过滤低于阈值的低质量结果
   * 4. 按相似度降序排列
   * 5. 返回 topK 条结果
   *
   * 余弦距离范围：0 到 2
   * - 0：完全相同方向（最相似）
   * - 1：正交（无关）
   * - 2：完全相反方向（最不相似）
   *
   * 相似度 = 1 - 距离，范围：-1 到 1
   * - 1：完全相同
   * - 0：正交
   * - -1：完全相反
   *
   * 阈值 0.5 表示至少中等相似度
   */
  async search(collectionName: string, vector: number[], topK = 5, similarityThreshold = 0.5) {
    this.requireReady()

    /**
     * 原生 SQL 查询
     *
     * embedding <=> $1: 计算余弦距离
     * 1 - (embedding <=> $1): 转换为相似度
     * WHERE 条件：知识库 ID 匹配且相似度 >= 阈值
     * ORDER BY: 按距离升序（越近越相似）
     * LIMIT: 返回 topK 条
     */
    const sql = `
      SELECT
        id,
        content,
        metadata,
        knowledge_base_id,
        knowledge_base_name,
        knowledge_base_description,
        tenant_id,
        chunk_index,
        source_type,
        source_name,
        created_at,
        updated_at,
        1 - (embedding <=> $1) as score
      FROM knowledge_items
      WHERE knowledge_items = $2
        AND 1 - (embedding <=> $1) >= $3
      ORDER BY embedding <=> $1
      LIMIT $4
    `

    const results = await this.entityManager.query(sql, [vector, collectionName, similarityThreshold, topK])

    // 解析结果
    return (results || []).map((item) => ({
      id: item.id,
      content: item.content,
      metadata: item.metadata,
      knowledge_base_id: item.knowledge_base_id,
      knowledge_base_name: item.knowledge_base_name,
      knowledge_base_description: item.knowledge_base_description,
      tenant_id: item.tenant_id,
      chunk_index: item.chunk_index,
      source_type: item.source_type,
      source_name: item.source_name,
      create_at: item.create_at,
      update_at: item.update_at,
      score: parseFloat(item.score),
    }))
  }

  /**
   * 获取所有知识库列表（去重聚合）
   *
   * 使用 GROUP BY 按知识库 ID 聚合
   * 统计每个知识库的文档数量
   *
   * @param tenantId - 租户 ID
   * @returns 知识库列表
   */
  async listCollections(tenantId: string) {
    this.requireReady()

    const results = await this.entityManager
      .createQueryBuilder(KnowledgeItem, 'item')
      .select([
        'item.knowledgeBaseId as id',
        'item.knowledgeBaseName as name',
        'item.knowledgeBaseDescription as description',
        'item.tenantId as tenantId',
        'COUNT(item.id) as documentCount',
        'MIN(item.createdAt) as createdAt',
        'MAX(item.updatedAt) as updatedAt',
      ])
      .where('item.tenantId = :tenantId', { tenantId })
      .groupBy('item.knowledgeBaseId, item.knowledgeBaseName, item.knowledgeDescription, item.tenantId')
      .orderBy('MAX(item.updateAt)', 'DESC')
      .getRawMany()

    return results.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      tenantId: item.tenantId,
      documentCount: parseInt(item.documentCount),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }))
  }

  /**
   * 获取单个知识库详情
   *
   * @param collectionName - 知识库 ID
   * @param tenantId - 租户 ID
   * @returns 知识库详情
   */
  async getCollection(collectionName: string, tenantId: string) {
    this.requireReady()

    const result = await this.entityManager
      .createQueryBuilder(KnowledgeItem, 'item')
      .select([
        'item.knowledgeBaseId as id',
        'item.knowledgeBaseName as name',
        'item.knowledgeBaseDescription as description',
        'item.tenantId as tenantId',
        'COUNT(item.id) as documentCount',
        'MIN(item.createdAt) as createdAt',
        'MAX(item.updatedAt) as updatedAt',
      ])
      .where('item.knowledgeBaseId = :collectionName', { collectionName })
      .andWhere('item.tenantId = :tenantId', { tenantId })
      .groupBy('item.knowledgeBaseId, item.knowledgeBaseName, item.knowledgeBaseDescription, item.tenantId')
      .getRawOne()

    if (!result) {
      throw new BadRequestException('Knowledge base not found')
    }

    return {
      id: result.id,
      name: result.name,
      description: result.description,
      tenantId: result.tenantId,
      chunkSize: parseInt(result.chunkSize) || 1000,
      chunkOverlap: parseInt(result.chunkOverlap) || 200,
      documentCount: parseInt(result.documentCount),
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    }
  }

  /**
   * 更新知识库名称或描述
   *
   * 由于采用单表设计，知识库名称存储在每条记录中
   * 更新时需要更新所有相关记录
   *
   * @param collectionName - 知识库 ID
   * @param tenantId - 租户 ID
   * @param updates - 更新内容
   * @returns 更新后的知识库详情
   */
  async updateCollection(
    collectionName: string,
    tenantId: string,
    updates: {
      name?: string
      description?: string
    },
  ) {
    this.requireReady()

    // 先检查是否存在
    const exists = await this.entityManager.findOne(KnowledgeItem, {
      where: {
        knowledgeBaseId: collectionName,
        tenantId: tenantId,
      },
    })

    if (!exists) {
      throw new BadRequestException('Knowledge base not found')
    }

    const updateData = {
      ...((updates?.name ?? '') === '' ? {} : { knowledgeBaseName: updates.name }),
      ...((updates?.description ?? '') === '' ? {} : { knowledgeBaseDescription: updates.description }),
    }

    // 批量更新所有相关记录
    if (Object.keys(updateData).length > 0) {
      await this.entityManager.update(
        KnowledgeItem,
        {
          knowledgeBaseId: collectionName,
          tenantId: tenantId,
        },
        updateData,
      )
    }

    // 返回更新后的详情
    return this.getCollection(collectionName, tenantId)
  }

  /**
   * 删除知识库 (租户验证)
   *
   * @param collectionName - 知识库 ID
   * @param tenantId - 租户 ID
   * @returns 删除的记录数
   */
  async deleteCollection(collectionName: string, tenantId: string) {
    this.requireReady()

    const result = await this.entityManager.delete(KnowledgeItem, {
      knowledgeBaseId: collectionName,
      tenantId,
    })

    this.logger.log(`Delete ${result.affected} items`)
    return { deletedCount: result.affected }
  }

  /**
   * 获取知识库统计信息
   *
   * @param collectionName - 知识库 ID
   * @param tenantId - 租户 ID
   * @returns 统计信息
   */
  async getCollectionStats(collectionName: string, tenantId: string) {
    this.requireReady()

    const stats = await this.entityManager
      .createQueryBuilder(KnowledgeItem, 'item')
      .select([
        'COUNT(item.id) as totalChunks', // 总的切片数
        'COUNT(DISTINCT item.sourceName) as totalSources', // 来源数量
        'MIN(item.createdAt) as earliestChunk', // 最早切片时间
        'MAX(item.updatedAt) as latestChunk', // 最新切片时间
      ])
      .where('item.knowledgeBaseId = :collectionName', { collectionName })
      .andWhere('item.tenantId = :tenantId', { tenantId })
      .getRawOne()

    return stats
  }
}
