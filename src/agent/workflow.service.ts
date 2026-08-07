import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { WorkflowEntity } from './../entities/workflow.entity'

@Injectable()
export class WorkflowService {
  constructor(
    @InjectRepository(WorkflowEntity)
    private readonly workflowRepo: Repository<WorkflowEntity>,
  ) {}

  async create(data: Partial<WorkflowEntity>) {
    return await this.workflowRepo.save(this.workflowRepo.create(data))
  }

  async findById(id: string, tenantId: string) {
    return await this.workflowRepo.findOne({ where: { id, tenantId } })
  }

  async findAll(tenantId: string) {
    return await this.workflowRepo.find({ where: { tenantId } })
  }

  async update(id: string, tenantId: string, data: Partial<WorkflowEntity>) {
    await this.workflowRepo.update({ id, tenantId }, data)
    return this.findById(id, tenantId)
  }

  async delete(id: string, tenantId: string) {
    return await this.workflowRepo.delete({ id, tenantId })
  }
}
