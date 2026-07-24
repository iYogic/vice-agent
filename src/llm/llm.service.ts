import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ChatOpenAI } from '@langchain/openai'
import { ChatAnthropic } from '@langchain/anthropic'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'

export type LLMProvider = 'openai' | 'anthropic' | 'dashscope'

export interface LLMOptions {
  provider?: LLMProvider
  temperature?: number
  maxTokens?: number
  streaming?: boolean // 是否流
  // 支持自定义 兼容 OpenAI 数据格式的模型
  model?: string
  apiKey?: string
  baseUrl?: string // openai 阵营的需要这个参数
}

@Injectable()
export class LLMService {
  constructor(private configService: ConfigService) {}

  createModel(options: LLMOptions = {}): BaseChatModel {
    const provider = options.provider || this.configService.get('LLM_DEFAULT_PROVIDER', 'openai')
    const model = options?.model
    const apiKey = options?.apiKey
    const baseUrl = options.baseUrl
    const maxTokens = options?.maxTokens || 4096
    const temperature = options.temperature ?? 0.7
    const streaming = options.streaming ?? true

    // 多数模型都是支持openai或者兼容openai数据格式的，只有Anthropic不一样，不要问问就是人家很牛逼
    if (provider === 'anthropic') {
      return new ChatAnthropic({
        modelName: model || this.configService.get('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
        temperature,
        streaming,
        maxTokens,
        anthropicApiKey: apiKey || this.configService.get('ANTHROPIC_API_KEY'),
      })
    }

    const configModel =
      provider === 'dashscope' ? this.configService.get('DASHSCOPE_MODEL')! : this.configService.get('OPENAI_MODEL')!

    //  OpenAI / DashScope 等等兼容openai 数据格式的
    const configApiKey: string =
      provider === 'dashscope'
        ? this.configService.get('DASHSCOPE_API_KEY')!
        : this.configService.get('OPENAI_API_KEY')!

    const configBaseUrl: string =
      provider === 'dashscope'
        ? this.configService.get('DASHSCOPE_BASE_URL')!
        : this.configService.get('OPENAI_BASE_URL')!

    const params = {
      model: model || configModel,
      temperature,
      streaming,
      apiKey: apiKey || configApiKey,
      ...(maxTokens ? { maxTokens } : {}),
      ...(baseUrl || configBaseUrl ? { configuration: { baseURL: baseUrl || configBaseUrl } } : {}),
    }

    return new ChatOpenAI(params)
  }
}
