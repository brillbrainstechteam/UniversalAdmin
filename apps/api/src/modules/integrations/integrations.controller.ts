import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import {
  CommitJobRequest,
  ConnectorKeyParam,
  CreateConnectionRequest,
  CreateMappingRequest,
  ExternalRecordQuery,
  FilePreviewRequest,
  IdParam,
  MappingPreviewRequest,
  OutboundListQuery,
  PutDiscoveryRequest,
  ResolveDiscrepancyRequest,
  SimulatorFailuresRequest,
  SyncJobListQuery,
  SyncJobRowQuery,
  TestOrderRequest,
  UpdateConnectionRequest,
  z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { ConnectionsService } from './connections.service';
import { SyncService } from './sync.service';

type Id = z.infer<typeof IdParam>;
type KeyP = z.infer<typeof ConnectorKeyParam>;
const StatusQuery = z.object({ status: z.enum(['open', 'resolved']).default('open') });
type StatusQuery = z.infer<typeof StatusQuery>;
type PreviewBody = z.infer<typeof MappingPreviewRequest>;

@Controller('v1/admin/integrations')
@AdminRoute()
export class IntegrationsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly sync: SyncService,
  ) {}

  @Get('connectors')
  @RequirePermission('integrations.read')
  catalog(@Tenant() ctx: TenantState) {
    return this.connections.catalog(ctx);
  }

  @Put('connectors/:key/discovery')
  @RequirePermission('integrations.manage')
  discovery(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(ConnectorKeyParam)) p: KeyP,
    @Body(zod(PutDiscoveryRequest)) body: PutDiscoveryRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.connections.putDiscovery(a, ctx, p.key, body, m);
  }

  @Get('connections')
  @RequirePermission('integrations.read')
  list(@Tenant() ctx: TenantState) {
    return this.connections.list(ctx);
  }

  @Post('connections')
  @RequirePermission('integrations.manage')
  create(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateConnectionRequest)) body: CreateConnectionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.connections.create(a, ctx, body, m);
  }

  @Get('connections/:id')
  @RequirePermission('integrations.read')
  get(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.connections.get(ctx, p.id);
  }

  @Patch('connections/:id')
  @RequirePermission('integrations.manage')
  update(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateConnectionRequest)) body: UpdateConnectionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.connections.update(a, ctx, p.id, body, m);
  }

  @Post('connections/:id/test')
  @HttpCode(200)
  @RequirePermission('integrations.manage')
  test(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.connections.testConnection(ctx, p.id);
  }

  @Get('connections/:id/mappings')
  @RequirePermission('integrations.read')
  mappings(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.connections.mappings(ctx, p.id);
  }

  @Post('connections/:id/mappings')
  @RequirePermission('integrations.manage')
  createMapping(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CreateMappingRequest)) body: CreateMappingRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.connections.createMapping(a, ctx, p.id, body, m);
  }

  @Post('mappings/preview')
  @HttpCode(200)
  @RequirePermission('integrations.read')
  previewMapping(@Tenant() ctx: TenantState, @Body(zod(MappingPreviewRequest)) body: PreviewBody) {
    return this.connections.previewMapping(ctx, body.rules, body.rows);
  }

  @Post('connections/:id/jobs/file')
  @RequirePermission('integrations.manage')
  previewFile(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(FilePreviewRequest)) body: FilePreviewRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.sync.previewFile(a, ctx, p.id, body, m);
  }

  @Post('connections/:id/jobs/pull')
  @RequirePermission('integrations.manage')
  pull(@Auth() a: AuthState, @Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id, @Meta() m: RequestMeta) {
    return this.sync.pull(a, ctx, p.id, m);
  }

  @Get('jobs')
  @RequirePermission('integrations.read')
  jobs(@Tenant() ctx: TenantState, @Query(zod(SyncJobListQuery)) q: SyncJobListQuery) {
    return this.sync.jobs(ctx, q);
  }

  @Get('jobs/:id')
  @RequirePermission('integrations.read')
  job(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.sync.job(ctx, p.id);
  }

  @Get('jobs/:id/rows')
  @RequirePermission('integrations.read')
  rows(
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Query(zod(SyncJobRowQuery)) q: SyncJobRowQuery,
  ) {
    return this.sync.rows(ctx, p.id, q);
  }

  @Get('jobs/:id/errors.csv')
  @RequirePermission('integrations.read')
  async errorsCsv(
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { fileName, csv } = await this.sync.errorsCsv(ctx, p.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  @Post('jobs/:id/commit')
  @HttpCode(200)
  @RequirePermission('integrations.manage')
  commit(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CommitJobRequest)) body: CommitJobRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.sync.commit(a, ctx, p.id, body, m);
  }

  @Post('jobs/:id/discard')
  @HttpCode(200)
  @RequirePermission('integrations.manage')
  discard(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.sync.discard(a, ctx, p.id, m);
  }

  @Get('connections/:id/records')
  @RequirePermission('integrations.read')
  records(
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Query(zod(ExternalRecordQuery)) q: ExternalRecordQuery,
  ) {
    return this.connections.records(ctx, p.id, q);
  }

  @Get('connections/:id/simulator')
  @RequirePermission('integrations.read')
  simulator(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.connections.simulator(ctx, p.id);
  }

  @Post('connections/:id/simulator/advance')
  @HttpCode(200)
  @RequirePermission('integrations.manage')
  advance(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.connections.advanceSimulator(a, ctx, p.id, m);
  }

  @Post('connections/:id/simulator/failures')
  @HttpCode(200)
  @RequirePermission('integrations.manage')
  failures(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SimulatorFailuresRequest)) body: SimulatorFailuresRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.connections.simulatorFailures(a, ctx, p.id, body, m);
  }

  @Post('connections/:id/outbound/test-order')
  @RequirePermission('integrations.manage')
  async testOrder(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(TestOrderRequest)) body: TestOrderRequest,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { command, created } = await this.connections.createTestOrder(a, ctx, p.id, body, m);
    res.status(created ? 201 : 200);
    if (!created) res.setHeader('Idempotent-Replayed', 'true');
    return command;
  }

  @Get('outbound')
  @RequirePermission('integrations.read')
  outbound(@Tenant() ctx: TenantState, @Query(zod(OutboundListQuery)) q: OutboundListQuery) {
    return this.connections.outbound(ctx, q);
  }

  @Post('outbound/:id/retry')
  @HttpCode(200)
  @RequirePermission('integrations.manage')
  retry(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.connections.retryOutbound(a, ctx, p.id, m);
  }

  @Post('connections/:id/reconcile')
  @HttpCode(200)
  @RequirePermission('integrations.manage')
  reconcile(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.sync.reconcile(a, ctx, p.id, m);
  }

  @Get('connections/:id/discrepancies')
  @RequirePermission('integrations.read')
  discrepancies(
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Query(zod(StatusQuery)) q: StatusQuery,
  ) {
    return this.sync.discrepancies(ctx, p.id, q.status);
  }

  @Post('discrepancies/:id/resolve')
  @HttpCode(200)
  @RequirePermission('reconciliation.resolve')
  resolve(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(ResolveDiscrepancyRequest)) body: ResolveDiscrepancyRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.sync.resolveDiscrepancy(a, ctx, p.id, body, m);
  }
}
