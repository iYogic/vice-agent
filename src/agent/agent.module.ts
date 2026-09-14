import { Module } from '@nestjs/common'
import { AgentService } from './agent.service'
import { WorkflowModule } from './../workflow/workflow.module'
import { RagModule } from './../rag/rag.module'

@Module({
  imports: [RagModule, WorkflowModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
