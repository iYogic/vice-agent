import { Injectable } from '@nestjs/common'
import { InjectEntityManager } from '@nestjs/typeorm'
import { EntityManager } from 'typeorm'
import { WorkflowEntity } from '../entities/workflow.entity'

@Injectable()
export class WorkflowService {
  constructor(
    /**
     * 注入 EntityManager 统一管理数据库操作
     * 优势：
     * 1. 统一数据访问方式，便于维护
     * 2. 支持事务管理
     * 3. 可以使用 QueryBuilder 和原生 SQL
     * 4. 避免 Repository 和 EntityManager 混用
     */
    @InjectEntityManager()
    private entityManager: EntityManager,
  ) {}

  async create(data: Partial<WorkflowEntity>) {
    const entity = this.entityManager.create(WorkflowEntity, data)
    return await this.entityManager.save(entity)
  }

  async findById(id: string, tenantId: string) {
    return await this.entityManager.findOne(WorkflowEntity, { where: { id, tenantId } })
  }

  async findAll(tenantId: string) {
    return await this.entityManager.find(WorkflowEntity, { where: { tenantId } })
  }

  async update(id: string, tenantId: string, data: Partial<WorkflowEntity>) {
    await this.entityManager.update(WorkflowEntity, { id, tenantId }, data)
    return this.findById(id, tenantId)
  }

  async delete(id: string, tenantId: string) {
    return await this.entityManager.delete(WorkflowEntity, { id, tenantId })
  }
}
