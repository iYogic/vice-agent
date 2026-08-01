import {
  Entity, // 标记这是一个数据库实体
  PrimaryGeneratedColumn, // 自增主键
  Column, // 普通字段
  CreateDateColumn, // 自动记录创建时间
  ManyToOne, // 多对一关系（多条消息属于一个会话）
  JoinColumn, // 指定外键列
  Index, // 给字段加索引（提升查询速度）
} from 'typeorm'
import { Conversation } from './conversations.entity' // 引入会话实体,因为 Message 要关联到 Conversation。

/**
 * 消息（Message）实体类，映射到数据库中的 messages 表
 *
 *     Conversation (1) ──── (∞) Message
 *     一个会话                   多条消息
 *
 * 设计思路：
 *    1. 消息表存储每条消息的内容、角色、关联的会话等信息
 *    2. 消息表与会话表是多对一关系，多条消息可以属于一个会话
 *    3. 消息表中存储了消息的角色role，用于区分消息是用户发的、AI助手回复的、系统指令还是工具调用的结果
 *    4. 消息表中存储了消息内容content，用于存储用户的问题或AI的回答
 *    5. 消息表中存储了关联的会话ID conversationId，用于标记这条消息属于哪个会话
 */

// 消息类型 和 langchain 对齐
// 'user'：用户发的消息 | 'assistant'：AI 助手回复的消息 | 'system'：系统指令（比如设定 AI 的角色） | 'tool'：工具调用的结果（比如调用外部 API 的返回）
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

@Entity('message') // 指定数据库表名为 message
export class Message {
  @PrimaryGeneratedColumn('uuid') // 主键自增
  id!: string

  // ------ 这里主要针对存，存的时候可把 message 关联的 conversation 一起存，两者的关系，通过外键 conversation_id 联系起来
  @Index()
  @Column({ name: 'conversation_id' }) // 在message表中存储外键，会话ID，给字段加索引
  conversationId!: string

  @Index()
  @Column({ name: 'tenant_id' }) // 租户ID，给字段加索引
  tenantId!: string

  @Column({ type: 'varchar', length: 20 }) // 消息角色，长度限制为20
  role!: MessageRole // 用来区分这条消息是谁发的

  @Column({ type: 'text' }) // 消息内容，类型为text，长文本类型
  content!: string // 存用户的问题或 AI 的回答

  @Column({ name: 'agent_name', nullable: true }) // 智能体名称，可为空
  agentName?: string // 可能用来标识是哪个 AI 智能体发的（比如不同的 AI 角色或版本）

  // ------ 多对一关联（重点！）
  // ------ 这里主要针对查，查的时候可把 message 关联的 conversation 都获取到，这样就可以把 conversation 里想要的值都能随时使用
  @ManyToOne(() => Conversation, (conversation) => conversation.messages) // 多对一关系，多条消息属于一个会话， 第二个参数指定反向关联：Conversation 里的 messages 字段
  @JoinColumn({ name: 'conversation_id' }) // 指定外键列为 conversation_id， 字段实际上就是上面第 4 步的 conversationId 字段
  conversation!: Conversation // 关联的会话实体，方便通过消息找到对应的整个会话详情，可以在代码里通过 message.conversation 直接访问所属的会话对象

  @CreateDateColumn({ name: 'created_at' }) // 自动记录创建时间
  createdAt!: Date
}
