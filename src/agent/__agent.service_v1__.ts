import { Injectable, Logger } from '@nestjs/common'
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages'
/* llm */
import { LLMService, LLMOptions } from '../llm/llm.service'
/* 工作流 */
import { SupervisorFactory, AgentDefinition } from '../workflow/supervisor.factory'
import { DagEngine, DagExecutionContext } from '../workflow/dag.engine'
import { WorkflowService } from '../workflow/workflow.service'
import { AGUIEvent, EventType, genId } from '../common/interfaces/ag-ui-events'
/* 知识库 */
import { RagService } from '../rag/rag.service'
// rag 接口封装成工具
import { createRagRetrievalTool } from '../tools/rag.retrieval.tool'
// 工具注册
import { ToolRegistry } from '../tools/tool-registry'

export interface OrchestrationRequest {
  threadId: string // 会话线程 ID
  runId: string // 本次运行 ID
  messages: Array<{ role: string; content: string }> // 历史消息
  workflowId?: string // 可选：指定工作流则走DAG模式
  llmOptions?: LLMOptions // 可选：LLM 参数覆盖
  tenantId: string // 租户Id (用于 RAG 隔离、工作流查询)
  onEvent: (event: AGUIEvent) => void // 事件回调，向外推送流式事件【onEvent 是一个回调，说明这个服务是推送式的：执行过程中不断调用它把事件发出去】
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name)
  private readonly defaultAgents: Omit<AgentDefinition, 'tools'>[] = [
    {
      name: 'researcher',
      prompt: `
      You are a research agent with two tools: rag_retrieval and web_search.
        - ALWAYS try rag_retrieval FIRST to search the internal knowledge base.
        - If the user explicitly mentions "知识库" (knowledge base), you MUST use rag_retrieval.
        - Only use web_search if rag_retrieval returns no useful results or for real-time information.
        - Always cite your sources.
      `,
    },
  ]
  private readonly agentToolMapping: Record<string, string[]> = {
    researcher: ['web_search', 'rag_retrieval'],
  }

  constructor(
    private readonly llmService: LLMService,
    private readonly toolRegistry: ToolRegistry,
    private readonly supervisorFactory: SupervisorFactory,
    private readonly dagEngine: DagEngine,
    private readonly workflowService: WorkflowService,
    private readonly ragService: RagService,
  ) {}

  /**
   * 整个 Agent 执行的总入口
   * 负责编排一次运行的完整生命周期：发出开始事件 → 根据是否有 workflowId 选择执行模式 → 发出结束事件 → 捕获异常并发出错误事件
   *
   * @param threadId：会话线程 ID，用于标识一次对话上下文
   * @param runId：本次运行的唯一 ID
   * @param onEvent：事件回调，所有流式输出（文本、工具调用、步骤等）都通过它推送给前端
   *
   * @returns 不返回业务数据，结果通过 onEvent 回调流式输出【采用「事件驱动」而非返回值：所有结果都通过 onEvent 流式推送】
   */
  async execute(request: OrchestrationRequest): Promise<void> {
    const { threadId, runId, onEvent, workflowId } = request || {}
    // RunStarted
    onEvent({ type: EventType.RUN_STARTED, threadId, runId })

    try {
      // 参数觉得走两种不同的工作流模式
      // 如果请求中带了 workflowId，说明用户选择的是「预定义工作流（DAG）」模式
      if (workflowId) {
        // 执行 DAG 模式：按工作流节点和边编译成图后运行
        await this.executeDag(request)
      } else {
        // 否则走默认的「Supervisor 多智能体」模式
        await this.executeSupervisor(request)
      }

      // RunFinished
      onEvent({ type: EventType.RUN_FINISHED, threadId, runId })
    } catch (error: any) {
      this.logger.error(`Agent execution error: ${error?.message}`, error?.stack)
      // RunError
      onEvent({ type: EventType.RUN_ERROR, message: error?.message })
    }
  }

  /**
   * 把业务层的简单消息结构（{ role, content }）转换成 LangChain 需要的 BaseMessage 子类实例，供 streamEvents 调用
   * 私有方法，把通用的 { role, content } 数组转换成 LangChain 的 BaseMessage 数组
   *
   * @param  messages —— 形如 [{ role: 'user', content: '...' }, ...]
   * @param  BaseMessage[] —— LangChain 消息对象数组（SystemMessage / AIMessage / HumanMessage）
   */
  private toLangChainMessages(messages: Array<{ role: string; content: string }>): BaseMessage[] {
    return messages?.map((m) => {
      // 如果 role 是 'system'，转换为 SystemMessage（用于设定系统提示词）
      if (m.role === 'system') return new SystemMessage(m.content)
      // 如果 role 是 'assistant'，转换为 AIMessage（表示模型此前回复的内容）
      if (m.role === 'assistant') return new AIMessage(m.content)
      // 其余情况（如 'user'、'human' 等）一律当作 HumanMessage（用户输入）
      return new HumanMessage(m.content)
    })
  }

  /**
   * Supervisor 模式
   * Supervisor模式本质由llm调度，该模式下注入的工具为 子agent
   */
  private executeSupervisor(request: OrchestrationRequest) {
    const { onEvent } = request
    const llm = this.llmService.createModel({ ...request.llmOptions, streaming: true })

    // 为每个 agent 组装最终工具列表 = 从注册表取静态工具（排除 rag_retrieval）+ 运行时动态创建的 ragTool（如果需要）
    // 静态工具全局复用、动态工具按请求隔离
    // @Design: 为什么要「过滤再追加」，不直接取全部?  @Answer: 因为 rag_retrieval 压根不在 ToolRegistry 里。ToolRegistry 是应用启动时静态注册的全局工具表，而 rag_retrieval 是每请求动态生成的（带 tenantId）

    // ① 动态创建带 tenantId 的 rag_retrieval 工具
    const ragTool = createRagRetrievalTool(this.ragService, request.tenantId)

    const agentDefs: AgentDefinition[] = this.defaultAgents.map((def) => {
      // ② 从注册表取静态工具（排除: rag_retrieval）
      const registeredTools = this.toolRegistry.getToolsByNames(
        (this.agentToolMapping[def.name] || []).filter((item) => item !== 'rag_retrieval'),
      )

      // ③ 为 researcher 追加动态 rag_retrieval 工具 【按需行为，声明时有说明需要rag_retrieval的能力才会加】
      if (this.agentToolMapping[def.name]?.includes('rag_retrieval')) {
        registeredTools.push(ragTool)
      }

      // ④ 输出tools 处理完毕后的完整定义
      return { ...def, tools: registeredTools }
    })

    this.logger.log(
      `Supervisor agents: ${agentDefs.map((a) => `${a.name}[${a.tools.map((t) => t.name).join(',')}]`).join(', ')}`,
    )

    const graph = this.supervisorFactory.createSupervisorGraph(llm, agentDefs)
    await this.processStreamEvents(graph, request.messages, onEvent, 25)
  }

  /**
   * DAG 模式
   * DAG模式基本就是用户远程配置的工作流，确定性较强，按照用户配置的一步一步走即可
   *
   * 从数据库查出工作流定义 =》 编译成 LangGraph 图 =》再交给统一的流处理函数。
   */
  private async executeDag(request: OrchestrationRequest) {
    const { onEvent } = request
    const workflow = await this.workflowService.findById(request.workflowId!, request.tenantId)
    if (!workflow) {
      throw new Error(`Workflow ${request.workflowId} not found`)
    }
    const llm = this.llmService.createModel({ ...request.llmOptions, streaming: true })
    const toolsMap = new Map(this.toolRegistry.getAll().map((t) => [t.name, t]))

    const ctx: DagExecutionContext = { llm, tools: toolsMap, onEvent, threadId: request.threadId }
    // 从dag服务中取出图
    const graph = this.dagEngine.compile(workflow.nodes, workflow.edges, ctx)

    await this.processStreamEvents(graph, request.messages, onEvent, 50)
  }

  /**
   * 使用 streamEvents 实现 token 级别的流式输出。
   * 通过 on_chat_model_stream 事件获取 LLM 逐 token 生成的内容，
   * 并把 LangGraph 的底层事件翻译成 AG-UI 事件，通过 onEvent 回调推送出去。
   *
   * @param graph LangGraph 图对象（Supervisor 图或 DAG 图）
   * @param messages 初始消息列表，会被转成 LangChain 消息作为图输入
   * @param onEvent 事件回调，用于向外推送 AG-UI 事件
   * @param recursionLimit LangGraph图的最大执行步数上限，超过会抛 GraphRecursionError【用来防止图无限循环或跑飞】
   * @returns Promise<void>  
   */

  private async processStreamEvents(
    graph: any,
    messages: Array<{ role: string; content: string }>,
    onEvent: (e: AGUIEvent) => void,
    recursionLimit: number,
  ) {
    const eventStream = graph.streamEvents(
      { messages: this.toLangChainMessages(messages) },
      { version: 'v2', recursionLimit },
    )

    // 跟踪当前正在流式输出的文本消息
    let currentMessageId: string | null = null
    // 跟踪已发射过的 step
    const activeSteps = new Set<string>()
    // 跟踪已处理过的工具调用
    const emittedToolCalls = new Set<string>()
    // 跟踪已看到的 tool 消息
    const emittedToolResults = new Set<string>()
    // 标记当前是否正出于工具调用阶段（跳过工具调用期间的文本输出）
    let inToolCall = false
    // 累积文本缓冲区，用于监测和过滤 xml 工具调用标签
    let textBuffer: string = ''
    // 跟踪每个节点是否已执行过工具调用（用于过滤子agent 工具调用前的"思考"文本）
    const nodeHasToolCall = new Set<string>()

    // 跟踪每个节点的工具调用是否已经完成（收到 on_tool_end）
    const nodeToolsDone = new Set<string>()

    // 标记某个节点是否需要抑制工具调用前的文本（子agent节点）
    // 对于使用 createAgent 的子agent, 工具调用前的文本通常是复述 prompt 指令
    const pendingTextPerNode = new Map<string, string>()

    // 检查文本中是否含 XML  格式的工具调用标签（某些模型 如 qwen 会这样输出）
    const TOOL_CALL_XML_RE = /<\/?tool_call>|<tool_call\b/
    const TOOL_CALL_BLOCK_RE = /<tool_call[\s\S]*?<\/tool_call>/g
    const TOOL_CALL_MID_BLOCK_RE = /<\/?tool_call[^>]*>/g

    // 提取 chunk.content 中的纯文本
    const extractText = (content: any): string => {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .filter((item) => item.type === 'text')
          .map((item) => item.text || '')
          .join('')
      }
      return ''
    }

    // 将缓冲区中清洗过的文本发射出去
    const flushTextBuffer = () => {
      if (!textBuffer) return
      // 移除完整的 <tool_call>...</tool_call> 块
      let cleaned = textBuffer.replace(TOOL_CALL_BLOCK_RE, '')
      // 移除残留的 开/闭标签及其属性
      cleaned = cleaned.replace(TOOL_CALL_MID_BLOCK_RE, '')
      if (cleaned) {
        if (!currentMessageId) {
          currentMessageId = genId()
          onEvent({
            type: EventType.TEXT_MESSAGE_START,
            messageId: currentMessageId,
            role: 'assistant',
          })
        }
        onEvent({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: currentMessageId,
          delta: cleaned,
        })
      }
      textBuffer = ''
    }

    for await (const event of eventStream) {
      const { event: eventName, data, name: runName, tags, metadata } = event

      // 从metadata 中提取当前节点
      // 对于嵌套子图 (如 createAgent), checkpoint_ns 格式为 "researcher:xxx"
      const langgraphNode = metadata?.langgraph_node || ''
      const checkpointNs: string = metadata?.langgraph_checkpoint_ns || ''

      // 提取顶层父节点 (用于step 追踪)
      const parentNode = checkpointNs ? checkpointNs.split(':')[0] : ''
      const effectiveNode = parentNode || langgraphNode

      // LLM token 级别流式
      if (eventName === 'on_chat_model_stream' && data.chunk) {
        const chunk = data.chunk

        // 跳过supervisor 路由节点的流式输出
        if (langgraphNode === 'supervisor' || effectiveNode === 'supervisor') continue

        // 确保 step 已开始（使用effectiveNode 作为 step 名）
        if (effectiveNode && !activeSteps.has(effectiveNode)) {
          activeSteps.add(effectiveNode)
          onEvent({ type: EventType.STEP_STARTED, stepName: effectiveNode })
        }

        // 结构化工具调用 chunk (OpenAI 等标准模型)
        if (chunk.tool_call_chunks?.length > 0) {
          // 工具调用开始 -> 丢弃 子agent 之前暂存的 "思考"文本
          if (effectiveNode && parentNode && langgraphNode !== parentNode) {
            pendingTextPerNode.delete(effectiveNode)
          }
          flushTextBuffer()
          inToolCall = true
          if (effectiveNode) nodeHasToolCall.add(effectiveNode)

          for (const tc of chunk.tool_call_chunks) {
            const toolCallId = tc.id || ''
            if (toolCallId && !emittedToolCalls.has(toolCallId)) {
              emittedToolCalls.add(toolCallId)
              onEvent({
                type: EventType.TOOL_CALL_START,
                toolCallId,
                toolCallName: tc.name || '',
                parentMessageId: genId(),
              })
            }

            if (toolCallId && tc.args) {
              onEvent({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId,
                delta: tc.args,
              })
            }
          }
          continue
        }

        // 文本内容 token
        const textContent = extractText(chunk.content)
        if (!textContent) continue

        // 如果正在结构化工具调用阶段，跳过同步输出的文本（通常是冗余的）
        if (inToolCall) continue

        // 检查是否包含 XML 工具调用标签
        if (TOOL_CALL_BLOCK_RE.test(textContent) || TOOL_CALL_BLOCK_RE.test(textBuffer + textContent)) {
          textBuffer += textContent
          // 同时标记此节点有工具调用（XML 格式的）
          if (effectiveNode) nodeHasToolCall.add(effectiveNode)
          continue
        }

        // 对于嵌套 子agent (如 createAgent 内部的 LLM)
        // 当 langgraphNode !== parentNode 时说明是子图内部的 LLM 调用
        // 如果工具尚未完成，暂存文本以过滤工具调用前模型复述 prompt 的"思考"文本
        const isNestedAgent = parentNode && langgraphNode !== parentNode
        if (isNestedAgent && !nodeToolsDone.has(effectiveNode)) {
          const prev = pendingTextPerNode.get(effectiveNode) || ''
          pendingTextPerNode.set(effectiveNode, prev + textContent)
          continue
        }

        // 如果缓冲区有内容，先刷出
        if (textBuffer) {
          textBuffer += textContent
          flushTextBuffer()
          continue
        }

        // 正常文本 token, 直接发射
        if (!currentMessageId) {
          currentMessageId = genId()
          onEvent({
            type: EventType.TEXT_MESSAGE_START,
            messageId: currentMessageId,
            role: 'assistant',
          })
        }

        onEvent({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: currentMessageId,
          delta: textContent,
        })
      }

      // --- LLM 调用结束 ---
      if (eventName === 'on_chat_model_end' && data.output) {
        if (langgraphNode === 'supervisor' || effectiveNode === 'supervisor') continue

        // 刷出剩余文本缓冲区
        flushTextBuffer()
        inToolCall = false

        const output = data.output

        // 结束工具调用
        if (output.tool_calls?.length > 0) {
          for (const tc of output.tool_calls) {
            const toolCallId = tc?.id || ''
            if (toolCallId && emittedToolCalls.has(toolCallId)) {
              onEvent({ type: EventType.TOOL_CALL_END, toolCallId })
            }
          }
        }

        // 结束文本消息
        if (currentMessageId) {
          onEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentMessageId,
          })
          currentMessageId = null
        }
      }

      // --- 工具执行结果（结束） ---
      if (eventName === 'on_tool_end' && data.output) {
        const toolCallId = metadata?.langgraph_tool_call_id || genId()
        // 标记该节点的工具已执行完成，后续 LLM 输出可以正常流式发射
        if (effectiveNode) nodeToolsDone.add(effectiveNode)

        if (!emittedToolResults.has(toolCallId)) {
          emittedToolResults.add(toolCallId)
          const content =
            typeof data.output === 'string'
              ? data.output
              : data.output?.content
                ? String(data.output.content)
                : JSON.stringify(data.output)
          onEvent({
            type: EventType.TOOL_CALL_RESULT,
            messageId: genId(),
            toolCallId,
            role: 'tool',
            content,
          })
        }
      }

      // --- 节点执行结束 ---
      if (eventName === 'on_chat_model_end' && data.output) {
        const stepNode = effectiveNode || langgraphNode
        if (stepNode && activeSteps.has(stepNode)) {
          // 顶层节点结束： checkpoint_ns 为空且 langgraph_node 匹配
          const isTopLevel = !checkpointNs && metadata?.langgraph_step !== undefined

          if (isTopLevel) {
            flushTextBuffer()
            if (currentMessageId) {
              onEvent({
                type: EventType.TEXT_MESSAGE_END,
                messageId: currentMessageId,
              })
              currentMessageId = null
            }
            onEvent({
              type: EventType.STEP_FINISHED,
              stepName: stepNode,
            })
            activeSteps.delete(stepNode)
          }
        }
      }

      // 确保最后的缓冲区和文本消息已关闭
      flushTextBuffer()
      if (currentMessageId) {
        onEvent({
          type: EventType.TEXT_MESSAGE_END,
          messageId: currentMessageId,
        })
      }
    }
  }
}
