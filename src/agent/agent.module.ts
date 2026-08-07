import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WorkflowEntity } from '../entities/workflow.entity'
import { AgentService } from './agent.service'
import { SupervisorFactory } from './supervisor.factory'
import { WorkflowController } from './workflow.controller'
import { WorkflowService } from './workflow.service'
import { RagModule } from './../rag/rag.module'

@Module({
  imports: [TypeOrmModule.forFeature([WorkflowEntity]), RagModule],
  controllers: [WorkflowController],
  providers: [AgentService, WorkflowService, SupervisorFactory],
  exports: [AgentService, WorkflowService],
})
export class AgentModule {}
