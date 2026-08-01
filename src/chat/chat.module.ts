import { Module } from '@nestjs/common'
// ----- 数据库相关
import { TypeOrmModule } from '@nestjs/typeorm'
import { Conversation } from './../entities/conversation.entity'
import { Message } from './../entities/message.entity'
// ----- 能力聚合
import { AgentModule } from './../agent/agent.module'
import { LLMModule } from './../llm/llm.module'
import { ChatController } from './chat.controller'
import { ChatService } from './chat.service'

@Module({
  imports: [TypeOrmModule.forFeature([Conversation, Message]), AgentModule, LLMModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
