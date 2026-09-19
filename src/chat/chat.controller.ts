import { Controller, Post, Get, Delete, Body, Param, Res, HttpCode, UseGuards, Logger } from '@nestjs/common'
import type { Response } from 'express'
import { z } from 'zod'

import { ChatService } from './chat.service'
import { AgentService } from './../agent/agent.service'
import { AGUIEvent, EventType, serializeEvent, genId } from './../common/interfaces/ag-ui-events'

import { JwtAuthGuard, TenantGuard } from './../auth/guards'
import type { AuthenticatedUser } from './../auth/jwt.strategy'
import { TenantId } from './../common/decorators/tenant.decorator'
import { CurrentUser } from './../common/decorators/current-user.decorator'

const ChatRequestSchema = z.object({
  message: z.string().min(1), // 会话询问内容
  conversation: z.uuid().optional(), // 会话ID： 不传 → 新建对话；传了 → 续接历史。一个接口兼顾"开新会话"和"继续对
  workflowId: z.uuid().optional(), // 工作流ID：不传 → 走 supervisor 模式；传了 → 走 DAG 模式。一个接口兼顾两种编排模式
  llmOptions: z
    .object({
      provider: z.enum(['openai', 'anthropic', 'dashscope']).optional(),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
})

const CreateConversationSchema = z.object({
  title: z.string().optional(),
  workflowId: z.uuid().optional(),
})

@Controller('chat')
@UseGuards(JwtAuthGuard, TenantGuard)
export class ChatController {
  private logger = new Logger(ChatController.name)

  constructor(
    private readonly chatService: ChatService,
    private readonly agentService: AgentService,
  ) {}

  /**
   * AG-UI 流式对话接口
   * POST /chat/completions
   */
  @Post('completions')
  @HttpCode(200)
  async chatCompletions(
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
    @TenantId() tenantId: string,
    @Res() res: Response,
  ) {
    const dto = ChatRequestSchema.parse(body)

    // SSE headers
    // 声明这是 SSE 流	浏览器/前端库靠它识别，否则当普通 JSON 处理
    res.setHeader('Content-Type', 'text/event-stream')
    // 禁止缓存	流式响应不能被缓存，否则第二次请求拿到旧流
    res.setHeader('Cache-Control', 'no-cache')
    // 保持长连接	SSE 是长连接，不能请求完就断
    res.setHeader('Connection', 'keep-alive')
    // 禁用 Nginx 缓冲	关键。Nginx 默认会缓冲响应，导致 SSE 的 token 被攒着一次性发出，失去流式效果
    res.setHeader('X-Accel-Buffering', 'no')
    // 立即发送响应头	不调的话，头会被 NestJS 攒着，等第一次 res.write() 才发，前端连接建立延迟
    res.flushHeaders()

    // 获取或创建会话（threadId）
    let threadId = dto.conversationId
    let needsTitle = false
    if (!threadId) {
      // 新建会话
      const conver = await this.chatService.createConversation(user.id, tenantId, undefined, dto.workflowId)
      threadId = conver.id
      needsTitle = true
    } else {
      // 已有对话但标题还是默认值，说明是首次发送消息
      const conver = await this.chatService.getConversation(threadId, tenantId)
      // 通过"标题是否默认"来反推"是否是首次发言"
      if (conver && conver.title === 'New Conversation') {
        needsTitle = true
      }
    }

    // runId：本次执行的唯一 ID，用于 AG-UI 的 RUN_STARTED / RUN_FINISHED 事件配对。跟 threadId（会话级）不同，runId 是单次请求级的
    const runId = genId()
    // 先存用户消息，再拉上下文：注意顺序。先 addMessage 存用户消息，再 getContextMessages 拉完整历史（包含刚存的这条）。这样 agent 拿到的上下文是包含当前用户输入的
    await this.chatService.addMessage(threadId, tenantId, 'user', dto.message)
    // getContextMessages 而不是 getMessages：前者可能做了裁剪（比如只取最近 N 条）或格式化（转成 LangChain 消息格式），后者是原始消息列表
    const messages = await this.chatService.getContextMessage(threadId, tenantId)

    // 收集 assistant 回复用于持久化
    const collectedMessages: Map<string, { content: string; role: string }> = new map()
    let lastStepName = 'assistant'

    // 这个设计的本质：onEvent 是一个"双写"回调——写流 + 写内存。 流给前端看，内存给数据库用
    const onEvent = (event: AGUIEvent) => {
      // 推流：res.write(serializeEvent(event)) —— 把事件立刻写给前端
      res.write(serializeEvent(event))

      // 收集 textMessage 内容
      // 把文本内容攒到 collectedMessages，用于对话结束后持久化
      // 为什么需要收集？ 因为 agent 的流式输出是一堆碎片（START / CONTENT* / END），而数据库里要存的是一条完整的 assistant 消息。所以必须边推边攒
      if (event.type === EventType.TEXT_MESSAGE_START) {
        collectedMessages.set(event.messageId, { content: '', role: event.role })
      }
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        const msg = collectedMessages.get(event.messageId)
        if (msg) msg.content += event.delta
      }
      // lastStepName：记录最后一个 STEP_STARTED 的节点名，作为这条 assistant 消息的"来源标记"（比如 "researcher"）。存库时一起存，前端历史消息里可以显示"由 researcher 生成"
      if (event.type === EventType.STEP_STARTED) {
        lastStepName = event.stepName
      }
    }

    try {
      await this.agentService.execute({
        threadId,
        runId,
        messages,
        workflowId: dto.workflowId,
        llmOptions: dto.llmOptions,
        tenantId,
        onEvent,
      })

      // 持久化所有 assistant 消息
      for (const [, msg] of collectedMessages) {
        // 遍历收集到的所有消息，只存非空的 assistant 消息（role === 'assistant' 过滤掉 tool 消息等）
        if (msg.content && msg.role === 'assistant') {
          await this.chatService.addMessage(threadId, tenantId, msg.content, lastStepName)
        }
      }

      // 新对话首条消息后自动生成标题title（异步，不阻塞响应）
      // 异步生成标题，为什么放在持久化之后？ 因为标题生成可能依赖消息已入库。顺序不能反
      if (needsTitle) {
        await this.chatService.generateTitle(threadId, tenantId, dto.message)
      }
    } catch (error: any) {
      this.logger.error(`Chat completion error:${error.message}`, error.stack)
      // 错误也是通过 SSE 流返回的，不是 HTTP 状态码

      // 响应头已经发出去了（flushHeaders() 之后 HTTP 状态码就固定了），无法再改。所以错误必须以 AG-UI 事件的形式推给前端,
      // RUN_ERROR 是 AG-UI 协议的一部分，前端收到后知道"这次 run 失败了"，可以展示错误提示
      const errEvent: AGUIEvent = {
        type: EventType.RUN_ERROR,
        message: error.message,
      }
      res.write(serializeEvent(errEvent))
    } finally {
      // finally 保证无论成功失败都关闭流，否则前端会一直挂着等
      // event: done\ndata: [DONE]：这是 SSE 协议的自定义结束标记

      // 为什么不用 AG-UI 的 RUN_FINISHED 就够了？因为：
      //    1、RUN_FINISHED 是业务层事件
      //    2、[DONE] 是传输层信号，告诉前端"SSE 流到此为止，可以关闭连接了"
      //    3、两层结束信号，各管一层。 这是 SSE 接口的常见做法（OpenAI 的流式 API 也用 [DONE]）
      res.write('event: done\ndata: [DONE]\n\n')
      res.end()
    }
  }

  @Post('add-conversation')
  async createConversation(@Body() body: any, @CurrentUser() user: AuthenticatedUser, @TenantId() tenantId: string) {
    const dto = CreateConversationSchema.parse(body)
    return await this.chatService.createConversation(user.id, tenantId, dto.title, dto.workflowId)
  }

  @Get('list-conversations')
  async listConversations(@CurrentUser() user: AuthenticatedUser, @TenantId() tenantId: string) {
    return await this.chatService.listConversations(user.id, tenantId)
  }

  @Get('detail-conversation/:id')
  async detailConversation(@Param('id') id: string, @TenantId() tenantId: string) {
    return await this.chatService.detailConversation(id, tenantId)
  }

  @Delete('delete-conversation/:id')
  async deleteConversation(@Param('id') id: string, @TenantId() tenantId: string) {
    await this.chatService.deleteConversation(id, tenantId)

    return { success: true }
  }
}
