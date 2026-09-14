import { tool } from '@langchain/core/tools'
import { z } from 'zod'

/**
 * Web 搜索工具 — 基于博查 Web Search API
 * 专为 AI Agent 设计，返回结构化搜索结果
 * 支持自然语言搜索的 Web Search API
 *
 * 优势：
 * 1、国内访问   原生服务，稳定低延迟
 * 2、中文搜索质量  深度优化，贴合国内场景
 * 3、提供MCP Server
 * 4、友好：面向国内用户的AI Agent、中文内容搜索
 *
 * @Url https://open.bochaai.com/
 */

export const webSearchTool = tool(
  async (input: { query: string; maxReults?: number }) => {
    const apiKey = process.env.WEB_SEARCH_API_KEY
    const fetchUrl = process.env.WEB_SEARCH_FETCH_URL!
    if (!apiKey) {
      return JSON.stringify({
        error: 'WEB_SEARCH_API_KEY not configured',
        message: '请在 .env 中配置 WEB_SEARCH_API_KEY',
      })
    }

    try {
      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bear ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: input.query,
          count: input.maxReults || 5,
          summary: true, // 开启长文本摘要
          freshness: 'noLimit', // 不限时间范围，由算法自动优化
        }),
      })

      const json = await response.json()

      // 博查 API 的响应结构：data.webPages.value
      if (json.code !== 200 || !json.data?.webPages?.value) {
        return JSON.stringify({
          error: 'WEB_SEARCH return no results',
          message: json.msg || '未知错误',
          results: [],
        })
      }

      const results = json.data.webPages.values.map((page: any) => ({
        title: page?.name,
        url: page?.url,
        content: page?.summary || page?.snippet, // 优先用长摘要，降级到短描述
        siteName: page?.siteName,
        datePublished: page?.datePublished,
      }))

      return JSON.stringify({
        results,
      })
    } catch (error: any) {
      return JSON.stringify({
        error: error?.message || 'Search failed',
        results: [],
      })
    }
  },
  {
    name: 'web_search',
    description:
      'Search the web for current information. Use this when you need up-to-date information or facts you are not sure about.',
    schema: z.object({
      query: z.string().describe('The search query'),
      maxResults: z.number().optional().default(5).describe('Maximum number of results'),
    }),
  },
)
