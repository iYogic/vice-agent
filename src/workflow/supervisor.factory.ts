import { Injectable } from '@nestjs/common'
import { StateGraph, MessagesAnnotation, Annotation, START, END, CompiledStateGraph } from '@langchain/langgraph'
import { createAgent } from 'langchain'
import { createDeepAgent } from 'deepagents'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { StructuredToolInterface, tool } from '@langchain/core/tools'
import { RunnableConfig } from '@langchain/core/runnables'
import { z } from 'zod'

/**
 * 主管(SupervisorFactory - worker)模式下 多agent调度中心
 *
 * 设计思路：
 *    1. 本文模块是整个系统最最核心的模块
 *    2. 多agent场景下的调度中心
 *    3. 采用最前沿的: 主管(SupervisorFactory - worker)模式
 */
export interface AgentDefinition {
  name: string
  prompt: string
  tools: StructuredToolInterface[]
  llm?: BaseChatModel
  /** 是否启用 deepagents 的高级功能（文件系统、任务规划等），默认为 true */
  useDeepAgents?: boolean
}

// ========== 自定义状态：扩展 MessagesAnnotation，增加迭代计数器 ==========
const SupervisorStateAnnotation = Annotation.Root({
  // 继承 MessagesAnnotation 的 messages 字段
  ...MessagesAnnotation.spec,
  // 自定义字段：迭代计数器
  iteration: Annotation<number>({
    reducer: (pre, next) => next ?? (pre || 0) + 1,
    default: () => 0,
  }),
})

// 从 Annotation 推导出状态类型
type SupervisorState = typeof SupervisorStateAnnotation.State

@Injectable()
export class SupervisorFactory {
  /**
   * 创建一个 Supervisor-Worker 多智能体系统
   * @param llm 主 Supervisor 使用的 LLM
   * @param agents 子 Agent 定义列表
   * @param maxIterations 最大迭代次数，防止无限循环
   */
  createSupervisorGraph(
    llm: BaseChatModel,
    agents: AgentDefinition[],
    maxIterations: number = 10,
  ): CompiledStateGraph<SupervisorState, any, any> {
    const agentNames = agents.map((a) => a.name)
    // ========== 第一步：创建子 Agent 并封装为工具 ==========
    const agentsTools: Record<string, StructuredToolInterface> = {}
    for (const agentDef of agents) {
      // 1.1 根据配置创建子 Agent
      const childAgent =
        agentDef.useDeepAgents !== false
          ? createDeepAgent({
              model: agentDef.llm || llm,
              tools: agentDef.tools,
              systemPrompt: agentDef.prompt,
              name: agentDef.name,
            })
          : createAgent({
              model: agentDef.llm || llm,
              tools: agentDef.tools,
              systemPrompt: agentDef.prompt,
              name: agentDef.name,
            })

      // 1.2 将子 Agent 封装为工具
      agentsTools[agentDef.name] = tool(
        async (input: { query: string }) => {
          // 子 Agent 独立处理任务，不依赖历史消息
          // 每个子 Agent 专注于完成单一任务
          const result = await childAgent.invoke({
            messages: [{ role: 'user', content: input.query }],
          })

          const lastMessage = result.messages[result.messages.length - 1]! || {}
          return typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content)
        },
        {
          name: agentDef.name,
          description: `将任务委托给 ${agentDef.name} 专家，${agentDef.prompt}`,
          schema: z.object({
            query: z.string().describe(`需要 ${agentDef.name} 处理的任务描述`),
          }),
        },
      )
    }

    // ========== 第二步：创建 Supervisor（主 Agent） ==========
    // 子agent tools 实列
    const supervisorTools = Object.values(agentsTools)

    const supervisorAgent = createDeepAgent({
      name: 'supervisor',
      model: llm,
      tools: supervisorTools,
      systemPrompt: `
                你是一个团队主管（Supervisor），管理以下专家：${agentNames.join(', ')}。

                ## 职责
                1. 根据用户问题，选择合适的专家工具来委派任务
                2. 如果问题简单，你可以直接回答
                3. 如果任务复杂，可以拆解后多次调用不同专家
                4. 收到专家回复后，整合成完整的答案

                ## 专家工具列表
                ${agentNames.map((name) => `- ${name}: ${agents.find((a) => a.name === name)?.prompt}`).join('\n')}

                ## 规则
                - 根据用户问题的内容，选择最合适的专家
                - 专家返回的结果可能很长，不要重复，直接呈现给用户
                - 如果连续调用同一个专家超过 2 次，考虑是否任务已解决
                - 如果用户只是打招呼或简单问候，直接回答，不要调用任何工具
            `,
    })

    // ========== 第三步：构建带有迭代保护的图 ==========
    const graph = new StateGraph(SupervisorStateAnnotation)
      // RunnableConfig 需要做的复杂的时候需要关注这个
      .addNode('supervisor', async (state: SupervisorState, config?: RunnableConfig) => {
        // 3.1 防止无限循环
        if (state.iteration >= maxIterations) {
          return {
            messages: [
              {
                role: 'assistant',
                content: `任务执行超过最大迭代次数（${maxIterations}）, 请尝试简化你的请求。`,
              },
            ],
            iteration: state.iteration,
          }
        }
        // 3.2 执行 Supervisor
        try {
          const result = await supervisorAgent.invoke(
            {
              messages: state.messages,
            },
            config,
          )
          return {
            messages: result.messages,
            iteration: state.iteration,
          }
        } catch (error) {
          throw error
        }
      })
      .addEdge(START, 'supervisor')
      .addEdge('supervisor', END)
      .compile()

    return graph
  }
}
