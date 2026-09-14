import { Injectable, Logger } from '@nestjs/common'
import { StructuredToolInterface } from '@langchain/core/tools'
// 网络检索
import { webSearchTool } from './web-search.tool'

/**
 * Tools 集中管理
 *
 * 它解决了什么问题？
 *    在一个 LLM Agent 系统里，通常会有多个「工具」：
 *        1.联网搜索
 *        2.计算器
 *        3.数据库查询
 *        4.发送邮件 / 调用 API
 *        5.RAG 检索
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name)
  private tools = new Map<string, StructuredToolInterface>()

  constructor() {
    this.registerDefaults()
  }

  private registerDefaults() {
    this.register(webSearchTool)
    this.logger.log(`Registered ${this.tools.size} default tools`)
  }

  register(tool: StructuredToolInterface) {
    this.tools.set(tool.name, tool)
  }

  get(name: string): StructuredToolInterface | undefined {
    return this.tools.get(name)
  }

  getAll(): StructuredToolInterface[] {
    return Array.from(this.tools.values())
  }

  getToolsByNames(names: string[]): StructuredToolInterface[] {
    return names.map((n) => this.tools.get(n)).filter(Boolean) as StructuredToolInterface[]
  }

  getListToolNames() {
    return Array.from(this.tools.keys())
  }
}
