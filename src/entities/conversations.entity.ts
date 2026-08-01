import {
  Entity, // 标记这是一个数据库实体
  PrimaryGeneratedColumn, // 自增主键
  Column, // 普通字段
  CreateDateColumn, // 自动记录创建时间
  UpdateDateColumn, // 自动记录更新时间
  Index, // 给字段加索引（提升查询速度）
  OneToMany, // 一对多关系（一个会话有多条消息）
} from 'typeorm'
import { Message } from './message.entity' // 导入消息实体

/**
 * 会话（Conversation）实体类，映射到数据库中的 conversations 表
 *
 *     Conversation (1) ──── (∞) Message
 *     一个会话                   多条消息
 *
 * 设计思路：
 *    1. 会话表存储每个用户的会话信息，包括标题、摘要、关联的工作流等
 *    2. 会话表与消息表是一对多关系，一个会话可以包含多条消息
 *    3. 会话表中存储了会话摘要summary，用于快速展示会话内容的概览【LLM自动压缩的历史摘要 + deepAgent结合处理】
 *    4. 会话表中存储了会话要覆盖到的最后一条消息ID messageId，用于标记摘要对应的消息范围
 */
@Entity('conversations') // 指定数据库表名为 conversations
export class Conversation {
  @PrimaryGeneratedColumn('uuid') // 主键自增
  id!: string

  @Column({ nullable: true }) // 会话标题，可为空
  title?: string

  @Index()
  @Column({ name: 'user_id' }) // 用户ID，给字段加索引
  userId!: string

  @Index()
  @Column({ name: 'tenant_id' }) // 租户ID，给字段加索引
  tenantId!: string

  @Column({ name: 'workflow_id', nullable: true }) // 工作流ID，可为空
  workflowId?: string

  // ------ 对话摘要（LLM 自动压缩历史消息生成）
  @Column({ type: 'text', nullable: true }) // 会话摘要，可为空
  summary?: string

  // ------ 会话要覆盖到的最后一条消息 ID 【包含这条ID】
  @Column({ name: 'summary_until_message_id', nullable: true }) // 会话摘要对应的最后一条消息ID，可为空
  summaryUntilMessageId?: string

  @OneToMany(() => Message, (msg: { conversation: Conversation }) => msg.conversation) // 一对多关系，一个会话有多条消息
  messages!: Message[]

  @CreateDateColumn({ name: 'created_at' }) // 自动记录创建时间
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at' }) // 自动记录更新时间
  updatedAt!: Date
}
