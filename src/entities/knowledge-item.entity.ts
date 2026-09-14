import {
  Entity, // 标记这是一个数据库实体
  PrimaryGeneratedColumn, // 自增主键
  Column, // 普通字段
  CreateDateColumn, // 自动记录创建时间
  UpdateDateColumn, // 自动记录更新时间
  Index, // 给字段加索引（提升查询速度）
} from 'typeorm'

/**
 * 知识库向量数据实体（单表设计）
 *
 * 设计思路：
 * 1. 单表存储所有知识库的向量数据，通过 knowledge_base_id 区分不同知识库
 * 2. 每条记录存储一个文本块（chunk）及其对应的向量
 * 3. 通过 knowledge_base_name/description 冗余存储知识库元信息，避免联表查询
 * 4. tenant_id 实现多租户隔离
 *
 * 索引设计：
 * - knowledge_base_id: 普通索引，用于快速筛选知识库
 * - tenant_id: 普通索引，用于租户隔离查询
 * - embedding: HNSW 向量索引（在 VectorService 中创建），用于高效向量检索
 *
 *
 * Remark: 后续数据足够多时可以采用
 * 1. pg + vector 双表  破除冗余 -> 向量查询
 * 2. pg + mongodb + es + es dense_vector（向量） -> 混合查询
 * 3. mysql + milvus  关系+向量库  -> 丰碑全能
 */

@Entity('knowledge_item')
export class KnowledgeItem {
  /**
   * 主键 - 使用 UUID 自动生成
   * 优势：全局唯一、避免自增 ID 泄露业务信息、分布式友好
   */
  @PrimaryGeneratedColumn('uuid')
  id: string

  /**
   * 文本内容 - 存储切片后的文本块
   * type: text 支持长文本，无长度限制
   * 这是向量检索时返回的原始文本内容
   */
  @Column({ type: 'text' })
  content: string

  /**
   * 向量数据 - pgvector 核心字段
   * type: vector 是 pgvector 扩展提供的向量类型
   * precision: 1024 表示向量维度（BGE-M3 模型输出 1024 维向量）
   * 注意：维度必须与 Embedding 模型输出维度一致
   */
  @Column({ type: 'vector', precision: 1024 })
  embedding: number[]

  /**
   * 元数据 - 存储灵活的附加信息
   * type: jsonb 支持 JSON 格式存储和查询
   * 可存储：页码、作者、标题、URL 等任意结构化数据
   * 用途：搜索结果中可附带展示额外信息
   */
  @Column({ type: 'jsonb', default: {} })
  metadata: any

  /**
   * 切片索引 - 记录该文本块在原始文档中的位置
   * 用于还原文档顺序、上下文拼接
   * 从 0 开始递增
   */
  @Column({ name: 'chunk_index', default: 0 })
  chunkIndex: number

  /**
   * 来源类型 - 标识数据来源
   * 可选值：pdf, txt, md, csv, html, json, url 等
   * 用于统计和过滤
   */
  @Column({ name: 'source_type', nullable: true })
  sourceType: string

  /**
   * 来源名称 - 原始文件名或 URL
   * 示例：test.pdf, https://example.com
   * 便于追溯数据来源
   */
  @Column({ name: 'source_name', nullable: true })
  sourceName: string

  /**
   * 知识库 ID - 用于区分不同知识库
   * @Index() 创建普通索引加速查询
   * 格式：kb_{tenantId}_{timestamp}
   * 示例：kb_tenant_001_1234567890
   */
  @Index()
  @Column({ name: 'knowledge_base_id', length: 64 })
  knowledgeBaseId: string

  /**
   * 知识库名称 - 冗余存储
   * 避免每次都需要关联查询知识库元数据
   * 更新知识库名称时，需要同步更新所有相关记录
   */
  @Column({ name: 'knowledge_base_name', nullable: true })
  knowledgeBaseName: string

  /**
   * 知识库描述 - 冗余存储
   * 便于在搜索结果中展示知识库的用途说明
   */
  @Column({ name: 'knowledge_base_description', nullable: true })
  knowledgeDescription: string

  /**
   * 租户 ID - 多租户隔离
   * @Index() 创建普通索引
   * 所有查询都必须带 tenant_id 条件，确保数据隔离
   */
  @Index()
  @Column({ name: 'tenant_id' })
  tenantId: string

  /**
   * 创建时间 - 自动记录
   * TypeORM 自动管理，无需手动设置
   */
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date

  /**
   * 更新时间 - 自动记录
   * TypeORM 自动管理，数据更新时自动更新
   */
  @UpdateDateColumn({ name: 'update_at' })
  updateAt: Date
}
