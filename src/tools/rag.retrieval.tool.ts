import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { Logger } from '@nestjs/common'
import { RagService } from './../rag/rag.service'

const logger = new Logger('RagRetrieval')

/**
 * RAG 知识库检索工具（工厂函数）
 * 接收 RagService 和 tenantId，在对话时按租户检索所有知识库
 *
 * @use tool for llm agent
 */
export function createRagRetrievalTool(ragService: RagService, tenantId: string) {
  return tool(
    async (input: { query: string; topK?: number }) => {
      try {
        const knowledgeBases = await ragService.listKnowledgeBases(tenantId)
        if (knowledgeBases && Array.isArray(knowledgeBases) && knowledgeBases.length === 0) {
          return JSON.stringify({
            results: [],
            success: true,
            message: 'No knowledge bases found.',
          })
        }

        const allResults: any[] = []
        for (const kb of knowledgeBases) {
          try {
            const results = await ragService.search(kb.id, tenantId, input.query, input.topK)
            allResults.push(
              ...(results.map((item) => ({
                ...(item || {}),
                knowledgeBaseName: kb.name,
              })) || []),
            )
          } catch {
            logger.warn(`KB "${kb.name}" search failed, skipping`)
          }
        }
        allResults.sort((a, b) => (b.score || 0) - (a.score || 0))
        const topResults = allResults.slice(0, input.topK || 5)

        return JSON.stringify({ results: topResults, success: true })
      } catch (error: any) {
        logger.error(`RAG retrieval error: ${error.message}`)
        return JSON.stringify({ error: error.message, success: false })
      }
    },
    {
      name: 'rag_retrieval',
      description:
        'Search ALL knowledge bases for relevant information. Use this when the user asks about domain-specific knowledge, internal documents, or mentions "知识库".',
      schema: z.object({
        query: z.string().describe('The search query'),
        topK: z.number().default(5).describe('Number of results to return'),
      }),
    },
  )
}
