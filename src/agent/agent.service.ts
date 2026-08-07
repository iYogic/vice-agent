import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@mestjs/typeorm'
import { Workflow } from '../entities/workflow.entity'
import { AgentService } from './agent.service'
import { SupervisorFactory } from './supervisor.factory'
import { WorkflowController } from './workflow.controller'
import { WorkflowService } from './workflow.service'
import { RagModule } from './../rag/rag.module'

@Module({
  imports: [TypeOrmModule.forFeature([Workflow]), RagModule],
  controllers: [WorkflowController],
  providers: [AgentService, WorkflowService, SupervisorFactory],
  exports: [AgentService, WorkflowService],
})
export class AgentModule {}
