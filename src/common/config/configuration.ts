/**
 * 全部配置
 *
 * URL: https://docs.nestjs.com/techniques/configuration
 */
export default () => {
  const IS_PROD = process.env.NODE_ENV === 'production'

  const jwtSecret = process.env.JWT_SECRET
  if (IS_PROD && !jwtSecret) {
    throw new Error(`JWT_SECRET environment variable is required in production`)
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
    },
    node_env: process.env.NODE_ENV,
    database: {
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432', 10),
      username: process.env.PG_USERNAME || 'nest_agent_postgre',
      password: process.env.PG_PASSWORD || 'nest_agent_postgre',
      database: process.env.PG_DATABASE || 'nest_agent_vector_db',
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || 'nest_agent_redis',
    },
    memory: {
      // 对话区，工作记忆，记忆长度
      windowSize: parseInt(process.env.MEMORY_WINDOW_SIZE || '10', 10),
      // 摘要阈值，到达阈值长度，触发摘要压缩
      summaryThreshold: parseInt(process.env.MEMORY_SUMMARY_THRESHOLD || '20', 10),
    },
    llm: {
      defaultEmbeddingModel: process.env.DEFAULT_EMBEDDING_MODEL || 'BAAI/bge-m3',

      defaultLLMProvider: process.env.DEFAULT_LLM_PROVIDER || 'dashscope',
      defaultLLMModel: process.env.DEFAULT_LLM_PROVIDER || 'qwen3.7-plus',

      openai: {
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OpenAI_BASE_URL,
      },
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
      dashscope: {
        apiKey: process.env.DASHSCOPE_API_KEY,
        baseUrl: process.env.DASHSCOPE_BASE_URL,
      },
    },
    web_search: {
      // 博查网络搜索
      web_search_api_key: process.env.WEB_SEARCH_API_KEY,
      web_search_fetch_url: process.env.WEB_SEARCH_FETCH_URL,
    },
  }
}
