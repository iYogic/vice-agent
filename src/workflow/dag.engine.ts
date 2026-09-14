import { Injectable, Logger } from '@nestjs/common'
import { StateGraph, MessagesAnnotation, START, END, Command } from '@langchain/langgraph'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { StructuredToolInterface } from '@langchain/core/tools'
import { createAgent } from 'langchain'
import { HumanMessage } from '@langchain/core/messages'
import { WorkflowNode, WorkflowEdge } from './../entities/workflow.entity'
import { AGUIEvent, EventType } from './../common/interfaces/ag-ui-events'
import { isEffectArray } from '@/utils/array-utils'

/**
 * DAG模式下 多agent调度中心
 *
 * 设计思路：
 *    1. 本文模块是整个系统最最核心的模块
 *    2. 多agent场景下的调度中心
 *    3. 采用灵活度最高的: DAG模式，可以用户自定义配置工作流
 *    4. 有向无环图
 *
 * Remark 流转极致：
 * 用户定义的 Workflow (JSON)
 *      │
 *      ▼
 * DagEngine.compile()
 *      │
 *      ├── 解析 nodes → 创建 StateGraph 节点
 *      ├── 解析 edges → 创建 StateGraph 边
 *      └── 返回可执行的编译图
 *      │
 *      ▼
 * LangGraph 执行
 *
 */

/**
 * DAG 执行上下文
 * 在编译时传入，每个节点执行时都能访问
 */
export interface DagExecutionContext {
  llm: BaseChatModel // 共享的 LLM 实例
  tools: Map<string, StructuredToolInterface> // 工具注册表（所有节点共享）
  onEvent?: (event: AGUIEvent) => void // 事件回调（流式输出）
  threadId: string // 会话 ID
}

// 有向无环图
@Injectable()
export class DagEngine {
  private readonly logger = new Logger(DagEngine.name)
  /**
   * 核心方法：将 Workflow 定义编译成可执行的 LangGraph
   *
   * @param nodes - Workflow 节点列表
   * @param edges - Workflow 边列表
   * @param ctx - 执行上下文
   * @returns 编译后的 LangGraph
   */
  compile(nodes: WorkflowNode[], edges: WorkflowEdge[], ctx: DagExecutionContext) {
    // 1️⃣ 创建 StateGraph
    // MessagesAnnotation 提供标准消息状态管理
    const graph = new StateGraph(MessagesAnnotation)

    // 2️⃣ 构建邻接表（优化边的查找）
    // 用途：快速查找某个节点的所有出边
    const adjacency = new Map<string, WorkflowEdge[]>()
    for (const edge of edges) {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, [])
      }
      adjacency.get(edge.source)!.push(edge)
    }

    // 3️⃣ 遍历所有节点，添加到图中
    for (const node of nodes) {
      // start 和 end 是特殊节点，不添加为可执行节点
      // start → 图的入口，end → 图的出口
      if (['start', 'end'].includes(node.type)) continue

      // 计算该节点的所有出边指向的节点（去重）
      const outEdges = adjacency.get(node.id) || []
      const endNodes = outEdges.map((e) => {
        const target = nodes.find((n) => n.id === e.target)
        return target?.type === 'end' ? END : e.target
      })

      // 添加节点，并声明该节点的结束端点
      // ends 告诉 LangGraph：执行完这个节点后，可以跳到哪些节点
      graph.addNode(node.id, this.createNodeFn(node, ctx, adjacency, nodes), {
        ends: endNodes.length > 0 ? endNodes : [END],
      })
    }

    // 4️⃣ 找到起始边
    // 从 start 节点出发的边 → 作为图的入口
    const startEdge = edges.find((e) => nodes.find((n) => n.id === e.source)?.type === 'start')
    if (startEdge) {
      graph.addEdge(START, startEdge.target as any)
    }

    // 5️⃣ 编译成可执行的图
    return graph.compile()
  }

  /**
   * 创建节点执行函数
   *
   * 这是最核心的部分：每个节点被包装成一个异步函数
   * 当 LangGraph 执行到该节点时，会调用这个函数
   *
   * @param node - 当前节点定义
   * @param ctx - 执行上下文
   * @param adjacency - 邻接表（用于条件节点查找分支）
   * @param allNodes - 所有节点（用于查找目标节点类型）
   * @returns 节点执行函数
   */
  private createNodeFn(
    node: WorkflowNode,
    ctx: DagExecutionContext,
    adjacency: Map<string, WorkflowEdge[]>,
    allNodes: WorkflowNode[],
  ) {
    // 事件发射器
    const emit = (event: AGUIEvent) => ctx.onEvent?.(event)

    return async (state: typeof MessagesAnnotation.State) => {
      // 节点开始执行
      emit({ type: EventType.STEP_STARTED, stepName: node.name })

      let result: any

      try {
        // ============================================
        // 根据节点类型执行不同的逻辑
        // ============================================

        /**
         * 类型 1: Agent 节点
         *
         * 创建一个 React Agent，使用 LLM + 工具处理消息
         * 适用场景：需要 AI 推理、工具调用的步骤
         */
        if (node.type === 'agent') {
          // 从工具注册表获取该节点需要的工具
          const tools = (node.config.tools || [])
            .map((item: string) => ctx.tools.get(item))
            .filter(Boolean) as StructuredToolInterface[]

          // 创建React Agent
          const agent = createAgent({
            model: ctx.llm,
            tools: tools,
            name: node.name,
            systemPrompt: node.config.prompt || `You are ${node.name}`,
          })

          // 执行
          result = await agent.invoke({ messages: state.messages })
        }

        /**
         * 类型 2: Tool 节点
         *
         * 直接执行一个工具，不经过 LLM
         * 适用场景：确定性操作（API 调用、数据查询等）
         */
        else if (node.type === 'tool') {
          const tool = ctx.tools.get(node.config.toolName)
          if (!tool) {
            this.logger.warn(`Tool "${node.config.toolName}" not found for node "${node.name}", skipping`)
          } else {
            // 执行工具
            const outPut = await tool.invoke(JSON.stringify(node.config.input || {}))

            // 将工具输出包装成消息，追加到对话历史
            result = {
              message: [...state.messages, new HumanMessage(`[Tool ${node.name}]: ${outPut}`)],
            }
          }
        }

        /**
         * 类型 3: Condition 节点（条件分支）
         *
         * 根据 LLM 输出内容，动态选择下一步
         * 适用场景：分支逻辑（质量检查、审批决策等）
         *
         * 工作原理：
         * 1. 获取当前节点所有出边
         * 2. 检查最后一条消息内容是否包含某个 condition 关键词
         * 3. 匹配到第一条满足条件的边，跳转到目标节点
         * 4. 如果没有匹配，跳转到第一条边
         */
        else if (node.type === 'condition') {
          const outEdges = adjacency.get(node.id) || []

          // Remark: 为什么是最新的一条消息，llm处理每个节点产生的消息集合，一般情况下最新的一条靠近 condition 最近，那么更加最新的一条才能知道condition往哪里走
          const lastContent =
            typeof state.messages.at(-1)?.content === 'string' ? (state.messages.at(-1)!.content as string) : ''

          // 查找匹配的边
          // Remark: 不完全范式， 这个地方后续可以考虑使用 langGraph 的 addConditionalEdges 的 路由判断函数 RouterFn 来处理，更范式一点
          // Remark: 现在用 字符串的 宽松匹配已经落伍，有bug，不是很范式
          const matched = outEdges.find(
            (item) => item.condition && lastContent.toLowerCase().includes(item.condition.toLocaleLowerCase()),
          )

          // 目标节点
          const target = matched?.target || outEdges[0]?.target || END

          emit({ type: EventType.STEP_FINISHED, stepName: node.name })

          // 返回 Command, 告诉langGraph 跳转到目标节点
          return new Command({ goto: target, update: { messages: state.messages } })
        }
      } catch (err: any) {
        // 异常处理：记录错误，不影响后续节点执行
        this.logger.error(`Node "${node.name}" execution failed: ${err.message}`, err.stack)
        result = {
          messages: [...state.messages, new HumanMessage(`[Error in ${node.name}]: ${err.message}`)],
        }
      }

      // 节点结束
      emit({ type: EventType.STEP_FINISHED, stepName: node.name })

      // ============================================
      // 节点结束后的路由逻辑
      // ============================================
      const outEdges = adjacency.get(node.id) || []

      // 情况 1：只有一条出边 → 直接跳转
      if (isEffectArray(outEdges) && outEdges.length === 1) {
        const targetId = outEdges[0]?.target
        const targetNode = allNodes.find((item) => item.id === targetId)

        return new Command({
          goto: targetNode?.type === 'end' ? END : targetId,
          update: result || { message: state.messages },
        })
      }

      // 情况 2：多条出边 → 由 LangGraph 的 ends 决定（已在 addNode 时声明）
      // 或者由子图内部的逻辑决定
      return result || { messages: state.messages }
    }
  }
}
