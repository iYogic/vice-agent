import { Injectable, Logger } from '@nestjs/common'
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages'
/* llm */
import { LLMService, LLMOptions } from './../llm/llm.service'
/* 工作流 */
import { SupervisorFactory, AgentDefinition } from '../workflow/supervisor.factory'
import { DagEngine, DagExecutionContext } from '../workflow/dag.engine'
import { WorkflowService } from './../workflow/workflow.service'
import { AGUIEvent, EventType, genId } from './../common/interfaces/ag-ui-events'
/* 知识库 */
import { RagService } from './../rag/rag.service'
// rag 接口封装成工具
import { createRagRetrievalTool } from './../tools/rag.retrieval.tool'
// 工具注册
import { ToolRegistry } from './../tools/tool-registry'
import { isEffectArray } from '@/utils/array-utils'
import getType from '@/utils/getType'

export interface OrchestrationRequest {
  threadId: string // 会话线程 ID
  runId: string // 本次运行 ID
  messages: Array<{ role: string; content: string }> // 历史消息
  workflowId?: string // 可选：指定工作流则走DAG模式
  llmOptions?: LLMOptions // 可选：LLM 参数覆盖
  tenantId: string // 租户Id (用于 RAG 隔离、工作流查询)
  onEvent: (event: AGUIEvent) => void // 事件回调，向外推送流式事件【onEvent 是一个回调，说明这个服务是推送式的：执行过程中不断调用它把事件发出去】
}

/**
 * 顶层调度
 * 职责：编排【选 supervisor 还是 DAG、建图、消费流、调 translator】
 */
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
  private async executeSupervisor(request: OrchestrationRequest) {
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
    await this.streamHybrid(graph, request.messages, onEvent, 25)
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

    await this.streamHybrid(graph, request.messages, onEvent, 50)
  }

  /**
   * 使用 stream 实现 token 级别的流式输出
   * LLM 逐 token 生成内容
   * 把 LangGraph 的底层事件翻译成 AG-UI 事件，通过 onEvent 回调推送出去
   *
   * @param graph LangGraph 图对象（Supervisor 图或 DAG 图）
   * @param messages 初始消息列表，会被转成 LangChain 消息作为图输入
   * @param onEvent 事件回调，用于向外推送 AG-UI 事件
   * @param recursionLimit LangGraph图的最大执行步数上限，超过会抛 GraphRecursionError【用来防止图无限循环或跑飞】
   * @returns Promise<void>  
   *
   * 备注：
   *    1、混合模式消费：messages + updates
   *    2、每个 chunk 是 [mode, payload] 元组
   *      - messages: payload = [token, metadata]
   *      - updates:  payload = { nodeName: stateDelta }（可能带 namespace）
   */
  private async streamHybrid(
    graph: any,
    messages: Array<{ role: string; content: string }>,
    onEvent: (e: AGUIEvent) => void,
    recursionLimit: number,
  ) {
    const translator = new HybridStreamTranslator(onEvent, this.logger)

    const stream = await graph.stream(
      { messages: this.toLangChainMessages(messages) },
      {
        streamMode: ['messages', 'updates'],
        recursionLimit,
        subgraphs: true,
        version: 'v2',
      },
    )

    // 跟踪当前正在流式输出的文本消息
    let currentNode: string | null = null

    for await (const chunk of stream) {
      // v2 格式下，混合模式的 chunk 是 [mode, payload]
      // 但 subgraphs: true 时可能多一层 namespace
      let mode: string
      let payload: any
      let namespace: string[] | undefined

      if (Array.isArray(chunk) && chunk.length >= 2) {
        // 可能是 [mode, payload] 或 [namespace, mode, payload]
        if (typeof chunk[0] === 'string' && (chunk[0] === 'messages' || chunk[0] === 'updates')) {
          mode = chunk[0]
          payload = chunk[1]
        } else {
          // [namespace, mode, payload]
          namespace = chunk[0] as string[]
          mode = chunk[1] as string
          payload = chunk[2]
        }
      } else {
        continue
      }

      // ── messages 流 ──
      if (mode === 'messages') {
        // 1、TOKEN LIKE THIS:
        //    { content: "Hello", tool_call_chunks: [] }        // 文本 token
        //    { content: "", tool_call_chunks: [{id, name, args}] }     // 工具调用参数 token
        // 2、META LIKE THIS:
        //   {
        //        langgraph_node: "researcher",              // 当前最内层节点名
        //        langgraph_checkpoint_ns: "researcher:abc", // 嵌套命名空间
        //        langgraph_step: 2,
        //        // ...
        //   }
        const [token, meta] = payload as [any, Record<string, any>]
        const node = (meta?.langgraph_node as string) || ''
        const checkpointNs = (meta?.langgraph_checkpoint_ns as string) || ''

        const parentNode = checkpointNs ? checkpointNs.split(':')[0] : ''
        const effectiveNode = parentNode || node

        // 节点切换：收尾上一个step
        // 正在effect的节点不等于current节点，说明节点位移切换了，记录下，且收尾上一个节点currentNode
        if (effectiveNode && effectiveNode !== currentNode) {
          if (currentNode) {
            translator.markNodeToolsDone(currentNode)
            translator.finishStep(currentNode)
          }
          currentNode = effectiveNode
        }

        translator.handleToken(token, meta)
      }

      // ── updates 流 ──
      if (mode === 'updates') {
        translator.handleUpdate(payload as Record<string, any>, namespace)
      }
    }

    // 流结束：收尾最后一个 step
    if (currentNode) {
      translator.markNodeToolsDone(currentNode)
      translator.finishStep(currentNode)
    }
    translator.finalize()
  }
}

/**
 * 把 LangGraph 的混合流（messages + updates）翻译成 AG-UI 事件流。
 *
 * 数据来源分工：
 *  - messages 流：LLM token（文本、tool_call_chunks）→ 驱动 TEXT_* / TOOL_CALL_START/ARGS
 *  - updates 流：节点完成后的状态增量 → 驱动 TOOL_CALL_RESULT / STEP_FINISHED / 工具完成标记
 *
 * @remark
 *  1、核心价值：把"两个不同粒度的输入流"收敛成"一套统一的事件输出"
 *  2、messages 流给的是 token，翻译器负责把它组装成有边界的消息
 *  3、updates 流给的是节点状态增量，翻译器负责从中提取工具结果、标记节点完成
 *  4、两者在翻译器内部共享同一批状态（currentMessageId、emittedToolResults、nodeToolsDone...），保证不会重复发、不会漏发
 *
 * @description
 * 职责：翻译 + 状态管理  
 *  · 维护消息边界（START/CONTENT/END）  
 *  · 维护工具生命周期（START/ARGS/END/RESULT）
 *  · 维护 step 生命周期（STARTED/FINISHED）  
 *  · XML 工具调用清洗  
 *  · 子 agent "思考文本"过滤  
 *  · 去重（emittedToolCalls 等）  
 *
 * @workflow
 * 外部调用顺序（由 streamHybrid 编排）（所有内部状态私有，外部只能通过上述 5 个方法交互）：
 *  · handleToken()                           ← 每个 messages chunk
 *  · handleUpdate()                          ← 每个 updates chunk
 *  · markNodeToolsDone() + finishStep()      ← 检测到节点切换时
 *  · finalize()                              ← 流结束时
 *
 */
class HybridStreamTranslator {
  // ═══════════════════════════════════════════════════════════
  // 0、状态变量：按职责分组
  // ═══════════════════════════════════════════════════════════
  // ── 文本消息边界 ──
  // 跟踪当前正在流式输出的文本消息
  private currentMessageId: string | null = null

  // ── 工具调用追踪 ──
  // 跟踪已处理过的工具调用
  private emittedToolCalls = new Set<string>()
  // 跟踪已看到的 tool 消息
  private emittedToolResults = new Set<string>()
  private toolCallIdToName = new Map<string, string>() // toolCallId -> node

  // ── step 追踪 ──
  // 跟踪已发射过的 step
  private activeSteps = new Set<string>()

  // ── XML 工具调用缓冲 ──
  private textBuffer = ''
  private static readonly TOOL_CALL_XML_RE = /<\/?tool_call>|<tool_call\b/
  private static readonly TOOL_CALL_BLOCK_RE = /<tool_call[\s\S]*?<\/tool_call>/g
  private static readonly TOOL_CALL_TOOL_META_RE = /<\/?tool_call[^>]*>/g

  // ── 子 agent "思考文本" 过滤 ──
  // 标记某个节点是否需要抑制工具调用前的文本（子agent节点）
  // 对于使用 createAgent 的子agent, 工具调用前的文本通常是复述 prompt 指令
  private pendingTextPerNode = new Map<string, string>()
  private nodeHasToolCall = new Set<string>()
  // 跟踪每个节点的工具调用是否已经完成（收到 on_tool_end）
  private nodeToolsDone = new Set<string>()

  // ── 工具调用期间的文本抑制 ──
  // 标记当前是否正出于工具调用阶段（跳过工具调用期间的文本输出）
  private inToolCall = false

  constructor(
    private readonly onEvent: (e: AGUIEvent) => void,
    private readonly logger: Logger,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // 1、messages 流：token 级处理
  // ═══════════════════════════════════════════════════════════
  /**
   * 处理 messages 流的一个 token
   * 跟纯 messages 模式完全一致，不做任何工具结果/节点完成的推断
   *
   * 被谁调：streamHybrid 的 for await 循环，mode === 'messages' 时
   *
   * 处理顺序（从上到下即优先级）：
   *   1. 过滤 supervisor 路由输出
   *   2. 确保 step 已开始
   *   3. 结构化工具调用 chunk（OpenAI 类模型）→ 发 TOOL_CALL_START/ARGS
   *   4. XML 工具调用检测（Qwen 类模型）→ 缓冲清洗
   *   5. 子 agent "思考文本"暂存 → 等工具完成后再决定发/丢
   *   6. 正常文本 → 发 TEXT_MESSAGE_START/CONTENT
   */
  handleToken(token: any, meta: Record<string, any>): void {
    // ── 提取节点信息 ──
    const node = (meta?.langgraph_node as string) || ''
    const checkpointNs = (meta?.langgraph_checkpoint_ns as string) || ''
    // checkpoint_ns 格式如 "researcher:abc"，取第一段得到顶层父节点名
    const parentNode = checkpointNs ? checkpointNs.split(':')[0] : ''
    // 有嵌套时用顶层父节点名，否则用最内层节点名
    const effectiveNode = parentNode || node

    // 过滤 supervisor 路由输出（内部决策，不给用户看）
    if (node === 'supervisor' || effectiveNode === 'supervisor') return

    // 确保 step 已开始（第一次见到该节点时发 STEP_STARTED）
    if (effectiveNode && !this.activeSteps.has(effectiveNode)) {
      this.activeSteps.add(effectiveNode)
      this.onEvent({
        type: EventType.STEP_STARTED,
        stepName: effectiveNode,
      })
    }

    // ── 结构化工具调用 chunk（OpenAI 等标准模型）──
    if (token.tool_call_chunks?.length > 0) {
      // 嵌套子 agent 的工具调用到来 → 丢弃之前暂存的"思考文本"
      if (effectiveNode && parentNode && node !== parentNode) {
        this.pendingTextPerNode.delete(effectiveNode)
      }

      // 先刷出 XML 缓冲区（可能是工具调用前的正常文本）
      this.flushTextBuffer()
      this.inToolCall = true
      if (effectiveNode) this.nodeHasToolCall.add(effectiveNode)

      for (const tc of token.tool_call_chunks) {
        const toolCallId = tc.id || ''
        // 首次见到该 toolCallId → 发 TOOL_CALL_START
        if (toolCallId && !this.emittedToolCalls.has(toolCallId)) {
          this.emittedToolCalls.add(toolCallId)
          if (effectiveNode) this.toolCallIdToName.set(toolCallId, effectiveNode)
          this.onEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: tc.name || '',
            parentMessageId: genId(),
          })
        }

        // 参数片段 → 发 TOOL_CALL_ARGS
        if (toolCallId && tc.args) {
          this.onEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: tc.args,
          })
        }
      }
      return
    }

    // ── 文本 token ──
    const textContent = this.extractText(token.content)
    if (!textContent) return

    // 工具调用阶段，跳过同步输出的文本（通常是冗余的）
    if (this.inToolCall) return

    // XML 工具调用检测（Qwen 等模型把工具调用当文本吐）
    if (
      HybridStreamTranslator.TOOL_CALL_XML_RE.test(textContent) ||
      HybridStreamTranslator.TOOL_CALL_XML_RE.test(this.textBuffer + textContent)
    ) {
      // 攒进缓冲区，等完整块出现再清洗
      this.textBuffer += textContent
      if (effectiveNode) this.nodeHasToolCall.add(effectiveNode)
      return
    }

    // 子 agent "思考文本"暂存
    // 嵌套子图（langgraph_node !== parentNode）且工具未完成时，
    // 模型复述 prompt 的文本先暂存，等工具来了就丢弃
    const isNestedAgent = parentNode && node !== parentNode
    if (isNestedAgent && !this.nodeToolsDone.has(effectiveNode)) {
      const prev = this.pendingTextPerNode.get(effectiveNode)
      this.pendingTextPerNode.set(effectiveNode, prev + textContent)
      return
    }

    // 正常文本发射
    // 若缓冲区有内容，先合并再一起刷出
    if (this.textBuffer) {
      this.textBuffer += textContent
      this.flushTextBuffer()
      return
    }

    this.emitText(textContent)
  }

  // ═══════════════════════════════════════════════════════════
  // 2、updates 流：节点级状态增量处理
  // ═══════════════════════════════════════════════════════════
  /**
   * 处理 updates 流的一个节点更新
   *
   * 被谁调：streamHybrid 的 for await 循环，mode === 'updates' 时
   *
   * payload 格式：{ nodeName: stateDelta }
   * 可能包含：
   *   - messages 数组中的 ToolMessage → 工具结果
   *   - 节点 key 本身 → 节点完成信号
   */
  handleUpdate(payload: Record<string, any>, namespace?: string[]) {
    // updates payload 的 key 是节点名
    const nodeName = Object.keys(payload)[0]
    if (!nodeName) return

    // 过滤 supervisor 路由节点
    if (nodeName === 'supervisor') return

    // 从 namespace 或 nodeName 推导顶层有效节点
    const effectiveNode = this.deriveEffectiveNode(nodeName, namespace)

    // ── 提取 ToolMessage → 发射 TOOL_CALL_RESULT ──
    const delta = payload[nodeName]
    const messages = delta?.messages

    if (Array.isArray(messages)) {
      for (const msg of messages) {
        // ToolMessage：工具执行结果
        if (msg?.type === 'tool' || msg?.role === 'tool') {
          this.emitToolResult(msg)
        }
      }
    }

    // ── 节点完成信号 → 标记工具完成 ──
    // updates 流中每个节点出现一次，意味着该节点本轮执行完毕。
    // 注意：STEP_FINISHED 不在这里直接发，因为 updates 的粒度是
    // "节点内一步完成"，不是"整节点完成"。对于多步节点（如 ReAct），
    // 需要配合 messages 流的节点切换来收尾。
    if (effectiveNode) {
      this.markNodeToolsDone(effectiveNode)
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 3、工具结果发射
  // ═══════════════════════════════════════════════════════════
  /**
   * 从 ToolMessage 提取工具结果并发射 TOOL_CALL_RESULT
   *
   * 被谁调：handleUpdate，遍历 updates 流的 messages 数组时
   *
   * 去重逻辑：同一 toolCallId 只发一次结果 【update 模式下多数情况下只会发一次，去重也是象征性的保护：尤其保护重试重发的情况】
   * 收尾逻辑：若之前发过 TOOL_CALL_START，这里补发 TOOL_CALL_END，关闭工具卡片的"参数流式"阶段
   */
  private emitToolResult(msg: any): void {
    // 兼容两种字段命名（LangChain 用 tool_call_id，部分 SDK 用 toolCallId）
    const toolCallId = msg?.tool_call_id || msg?.toolCallId || ''
    if (!toolCallId || this.emittedToolResults.has(toolCallId)) return

    this.emittedToolCalls.add(toolCallId)

    // content 可能是字符串或结构化对象，统一成字符串
    const content = getType(msg?.content) === 'string' ? msg.content : JSON.stringify(msg.content)
    // update 模式下多数情况下只会发一次，去重也是象征性的保护：尤其保护重试重发的情况
    this.onEvent({
      type: EventType.TOOL_CALL_RESULT,
      messageId: genId(),
      toolCallId,
      role: 'tool',
      content,
    })

    // 同时结束工具调用的 ARGS 阶段（如果之前发过 START）
    if (this.emittedToolCalls.has(toolCallId)) {
      this.onEvent({
        type: EventType.TOOL_CALL_END,
        toolCallId,
      })
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 4、step 与工具完成标记
  // ═══════════════════════════════════════════════════════════
  /**
   * 收尾一个 step：刷缓冲区、关文本消息、发 STEP_FINISHED
   *
   * 被谁调：streamHybrid，检测到节点切换时；流结束时
   *
   * 为什么由外部调：messages 流拿不到 on_chain_end 信号，
   * 只能靠"下一个节点的 token 到来"反推"上一个节点结束"
   */
  finishStep(stepName: string): void {
    if (!this.activeSteps.has(stepName)) return
    this.flushTextBuffer()
    this.endTextMessage()
    this.onEvent({ type: EventType.STEP_FINISHED, stepName })
    this.activeSteps.delete(stepName)
  }

  /**
   * 标记某节点的工具已全部完成
   * 调用后，该节点的文本不再暂存，可直接发射
   *
   * 被谁调：handleUpdate（updates 流节点完成时）；
   *         streamHybrid（节点切换 / 流结束时）
   *
   * 核心决策：
   *   - 若该节点没调过工具 → 暂存文本其实是正经回答，补发
   *   - 若该节点调过工具 → 暂存文本是"思考噪音"，丢弃
   */
  markNodeToolsDone(node: string): void {
    if (this.nodeToolsDone.has(node)) return
    this.nodeToolsDone.add(node)

    if (!this.nodeHasToolCall.has(node)) {
      // 没调工具 → 暂存文本其实是正经回答，补发
      const pending = this.pendingTextPerNode.get(node)
      if (pending) {
        this.pendingTextPerNode.delete(node)
        this.emitText(pending)
      }
    } else {
      // 调了工具 → 暂存文本是"思考噪音"，丢弃
      this.pendingTextPerNode.delete(node)
    }
  }

  /**
   * 流结束时调用，确保所有缓冲区已刷出、所有消息已关闭
   *
   * 被谁调：streamHybrid，for await 循环结束后
   */
  finalize(): void {
    this.flushTextBuffer()
    this.endTextMessage()
  }

  // ═══════════════════════════════════════════════════════════
  // 5、内部工具方法
  // ═══════════════════════════════════════════════════════════
  /**
   * 从 updates 流的 nodeName + namespace 推导顶层有效节点名
   *
   * 被谁调：handleUpdate
   *
   * 为什么需要：subgraphs: true 时，updates 的节点名可能是
   * 子图内部的节点（如 "tools"），需要归到最外层父节点（如 "researcher"）
   *
   * namespace 格式如 ["researcher:xxx", "tools:yyy"]
   * 取第一段的 name 部分作为 effectiveNode
   */
  private deriveEffectiveNode(nodeName: string, namespace?: string[]): string {
    if (isEffectArray(namespace)) {
      // 去 namespace 第一段的节点名
      const firstSeg = (namespace as string[])[0]!.split(':')[0]
      return firstSeg || nodeName
    }
    return nodeName
  }

  /**
   * 从 chunk.content 中提取纯文本
   *
   * 被谁调：handleToken
   *
   * content 可能是：
   *   - string（普通文本 token）
   *   - Array<{type: 'text', text: string}>（多模态 / 结构化 content）
   *   - 其他（返回空字符串）
   */
  private extractText(content: any): string {
    if (getType(content) === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === 'text')
        .map((item) => item.text || '')
        .join('')
    }
    return ''
  }

  /**
   * 发射一段文本（必要时先开一个消息气泡）
   *
   * 被谁调：handleToken（正常文本）、markNodeToolsDone（补发暂存文本）、flushTextBuffer（清洗后文本）
   *
   * 边界逻辑：若 currentMessageId 为空，先发 TEXT_MESSAGE_START，后续所有文本复用同一 messageId，直到 endTextMessage 关闭
   */
  private emitText(text: string): void {
    if (!this.currentMessageId) {
      this.currentMessageId = genId()
      this.onEvent({
        type: EventType.TEXT_MESSAGE_START,
        messageId: this.currentMessageId,
        role: 'assistant',
      })
    }

    this.onEvent({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: this.currentMessageId,
      delta: text,
    })
  }

  /**
   * 关闭当前文本消息（发 TEXT_MESSAGE_END）
   *
   * 被谁调：finishStep、finalize
   *
   * 幂等：currentMessageId 为空时不做任何事
   */
  private endTextMessage(): void {
    if (this.currentMessageId) {
      this.onEvent({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.currentMessageId,
      })
      this.currentMessageId = null
    }
  }

  /**
   * 清洗并刷出 XML 工具调用缓冲区
   *
   * 被谁调：handleToken（工具调用 chunk 到来前、缓冲区有内容时）、finishStep、finalize
   *
   * 清洗规则：
   *   1. 移除完整的 <tool_call>...</tool_call> 块
   *   2. 移除残留的开/闭标签
   *   3. trim 后若非空，发射为正常文本
   */
  private flushTextBuffer(): void {
    if (!this.textBuffer) return
    let cleaned = this.textBuffer.replace(HybridStreamTranslator.TOOL_CALL_BLOCK_RE, '')
    cleaned = cleaned.replace(HybridStreamTranslator.TOOL_CALL_TOOL_META_RE, '').trim()
    if (cleaned) this.emitText(cleaned)
    this.textBuffer = ''
  }
}
