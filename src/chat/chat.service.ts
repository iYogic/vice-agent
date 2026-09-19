import { Injectable, Logger } from '@nestjs/common'
/* --- 数据库 --- */
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ConfigService } from '@nestjs/config'
import { RedisService } from './../redis/redis.service'

/* --- 会话 --- */
import { Conversation } from './../entities/conversations.entity'
import { Message, MessageRole } from './../entities/message.entity'

/* --- LLM --- */
import { LLMService } from './../llm/llm.service'
import getType from '@/utils/getType'

/* --- 一些常量 --- */
const CACHE_TTL = 3600
const CONV_KEY = (id: string) => `conv:${id}`
const MSG_KEY = (id: string) => `conv_msgs:${id}`

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name)
  private readonly windowSize: number
  private readonly summaryThreshold: number

  constructor(
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly msgRepo: Repository<Message>,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly llmService: LLMService,
  ) {
    this.windowSize = this.configService.get<number>('memory.windowSize') || 10
    this.summaryThreshold = this.configService.get<number>('memory.summaryThreshold') || 20
  }

  // ─── 会话 CRUD ───
  // 创建会话，双写: pg + redis
  async createConversation(userId: string, tenantId: string, title?: string, workflowId?: string) {
    const conv = await this.convRepo.save(
      this.convRepo.create({
        userId,
        tenantId,
        title: title || 'New Conversation',
        workflowId,
      }),
    )

    await this.redisService.setJson(CONV_KEY(conv.id), conv, CACHE_TTL)
    return conv
  }

  // 查询某条conversation
  async getConversation(id: string, tenantId: string) {
    const cached = await this.redisService.getJson<Conversation>(CONV_KEY(id))
    if (cached?.tenantId === tenantId) return cached

    const conv = await this.convRepo.findOne({ where: { id, tenantId } })
    if (conv) await this.redisService.setJson(CONV_KEY(id), conv, CACHE_TTL)
    return conv
  }

  // 获取用户下的会话列表
  // Remark: 这个地方为什么没有缓冲里面取，晚点得看下？
  async listConversations(userId, tenantId) {
    await this.convRepo.find({ where: { userId, tenantId }, order: { updatedAt: 'DESC' } })
  }

  // 删除某条会话
  // 双删：pg + redis
  async deleteConversation(id: string, tenantId: string) {
    await this.convRepo.delete({ id, tenantId })
    await this.msgRepo.delete({ conversationId: id, tenantId })

    await this.redisService.del(CONV_KEY(id))
    await this.redisService.del(MSG_KEY(id))
  }

  /**
   * 根据用户第一条消息自动生成对话标题
   */
  async generateTitle(conversationId: string, tenantId: string, userMessage: string) {
    try {
      const llm = this.llmService.createModel({ streaming: false, temperature: 0.3 })
      const result = await llm.invoke([
        {
          role: 'system',
          content:
            '根据用户的消息，生成一个简短的对话标题（不要超过15个字），直接输出标题文本，不要加引号和其他标点，使用与用户消息相同的语言。',
        },
        {
          role: 'user',
          content: userMessage,
        },
      ])

      const title = typeof result.content === 'string' ? result.content.trim().slice(0, 15) : ''
      if (title) {
        await this.convRepo.update({ id: conversationId, tenantId }, { title })
        // 下次读时 从 DB 回填最新值，删除即可
        await this.redisService.del(CONV_KEY(conversationId))
        this.logger.log(`Title generated for ${conversationId}: ${title}`)
      }
    } catch (error: any) {
      this.logger.error(`Title generated failed: ${error?.message}`)
    }
  }

  // ─── 消息 ───
  /**
   * 追加消息
   */
  async addMessage(conversationId: string, tenantId: string, role: MessageRole, content: string, agentName?: string) {
    const saved = await this.msgRepo.save(this.msgRepo.create({ conversationId, tenantId, role, content, agentName }))
    // 追加到缓存
    const cached = await this.redisService.getJson<Message[]>(MSG_KEY(conversationId))
    if (cached) {
      cached.push(saved)
      await this.redisService.setJson(MSG_KEY(conversationId), cached, CACHE_TTL)
    } else {
      await this.redisService.setJson(MSG_KEY(conversationId), [saved], CACHE_TTL)
    }
    return saved
  }

  /**
   * 获取对话下的所有消息
   */
  async getMessages(conversationId: string, tenantId: string) {
    const cached = await this.redisService.getJson<Message[]>(MSG_KEY(conversationId))
    if (cached) return cached

    const messages = await this.msgRepo.find({
      where: { conversationId, tenantId },
      order: { createdAt: 'ASC' },
    })
    if (messages.length) await this.redisService.setJson(MSG_KEY(conversationId), messages, CACHE_TTL)
    return messages
  }

  // ─── 记忆策略：滑动窗口 + 摘要压缩 ───
  /**
   * 获取带记忆策略的上下文消息
   * - 消息数 <= windowSize → 全量
   * - 消息数 > summaryThreshold → 自动摘要 + 最近 N 条
   * - 中间 → 纯滑动窗口
   *
   * 详情说明：
   *  1、消息数length <= windowSize
   *     - 策略：全量返回
   *     - 效果：对话还短，无需压缩
   *  2、windowSize < length <= summaryThreshold
   *     - 策略：纯滑动窗口
   *     - 效果：只取最近 windowSize 条，中间的直接丢弃（不摘要）
   *  3、length > summaryThreshold
   *     - 策略：摘要 + 最近 N 条
   *     - 效果：旧内容压成 summary 前置，再拼最近 windowSize 条
   *
   * 思考：
   *  1、为什么有个中间区间 纯滑动窗口 这个？
   *     - 在没到摘要阈值前，旧消息是直接丢弃而非压缩 —— 这是一种"成本换精度"的取舍（摘要要额外调 LLM，有开销）
   *     - 一般消息达不到 summaryThreshold 级别长度，采用就近原则，保留 最近的 windowSize 条，一般够用
   *  2、summaryThreshold 一般会设得比 windowSize 大多少？
   *     - 一般会设得比 windowSize 大不少（比如 3 倍以上，保守也得1.5以上），否则摘要会过于频繁地触发，得不偿失
   *
   * Remark：
   *  1、未来可考虑滑动窗口以外的messages，缓存到 数据库或者向量库，启动数据召回，提高能力
   *  2、消息要逐步接入支持多模态消息
   */
  async getContextMessages(
    conversationId: string,
    tenantId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    const all = await this.getMessages(conversationId, tenantId)

    // 不超过窗口，全量返回
    if (all && all.length <= this.windowSize) {
      return all.map((item) => ({
        role: item.role,
        content: item.content,
      }))
    }

    // 超过阈值，触发摘要
    let conv = await this.getConversation(conversationId, tenantId)
    if (all.length > this.summaryThreshold && conv) {
      await this.generateSummary(conversationId, tenantId, all, conv)
      conv = await this.convRepo.findOne({
        where: { id: conversationId, tenantId },
      })
    }

    // 最近 N 条
    const recent = all.slice(-this.windowSize).map((m) => ({
      role: m.role,
      content: m.content,
    }))

    // 有摘要则前置
    if (conv?.summary) {
      return [{ role: 'system', content: `[对话历史摘要]\n${conv.summary}` }, ...recent]
    }
    return recent
  }

  /**
   * 用 LLM 自动压缩历史消息为摘要
   *
   * Remark：
   *  1、触发阈值用 summaryThreshold，摘要范围用 windowSize，现在的方式是全量压缩，两份token，后续要改造成增量压缩，降低成本~~~
   */
  private async generateSummary(conversationId: string, tenantId: string, all: Message[], conv: Conversation) {
    try {
      // 触发阈值用 summaryThreshold，摘要范围用 windowSize
      const toSummarize = all.slice(0, -this.windowSize)
      const existing = conv.summary || ''

      // 构建提示
      let promot = existing
        ? `已有的历史摘要: \n ${existing}\n\n新增的对话内容: \n`
        : `请将一下对话历史压缩为摘要: \n\n`
      for (const m of toSummarize) {
        promot += `[${m.role === 'user' ? '用户' : '助手'}]:${m.content}\n`
      }
      promot += `\n请输出一段简洁的摘要(保留关键信息、决策结果和用户偏好): `

      const llm = this.llmService.createModel({
        streaming: false,
        temperature: 0.3,
      })

      const result = await llm.invoke([
        { role: 'system', content: '你是一个对话摘要助手，请将对话历史压缩为简洁的摘要，保留关键信息，用中文输出。' },
        { role: 'user', content: promot },
      ])

      const summary = typeof result.content === 'string' ? result.content : ''
      if (summary) {
        const lastId = toSummarize[toSummarize.length - 1]?.id
        await this.convRepo.update(
          { id: conversationId, tenantId },
          {
            summary,
            summaryUntilMessageId: lastId,
          },
        )
        // 有新的数据入库，需把旧数据删除，不然下次查询会直接取缓存，跳过压缩
        await this.redisService.del(CONV_KEY(conversationId))
        this.logger.log(`Summary generated for ${conversationId}, compressed ${toSummarize.length} messages`)
      }
    } catch (error: any) {
      this.logger.error(`Summary generated failed: ${error?.message}`)
    }
  }
}
