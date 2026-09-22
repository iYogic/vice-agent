import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WorkflowEntity } from '../entities/workflow.entity'
import { DagEngine } from './dag.engine'
import { SupervisorFactory } from './supervisor.factory'
import { WorkflowController } from './workflow.controller'
import { WorkflowService } from './workflow.service'

@Module({
  imports: [TypeOrmModule.forFeature([WorkflowEntity])],
  controllers: [WorkflowController],
  providers: [WorkflowService, DagEngine, SupervisorFactory],
  exports: [WorkflowService],
})
export class WorkflowModule {}
