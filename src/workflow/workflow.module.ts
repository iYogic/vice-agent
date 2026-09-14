import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WorkflowEntity } from '../entities/workflow.entity'
import { SupervisorFactory } from './supervisor.factory'
import { WorkflowController } from './workflow.controller'
import { WorkflowService } from './workflow.service'

@Module({
  imports: [TypeOrmModule.forFeature([WorkflowEntity])],
  controllers: [WorkflowController],
  providers: [WorkflowService, SupervisorFactory],
  exports: [WorkflowService],
})
export class WorkflowModule {}
