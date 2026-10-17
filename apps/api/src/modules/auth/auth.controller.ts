import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import {
  AcceptInvitationRequest,
  InvitationPreviewRequest,
  LoginRequest,
  type MeResponse,
} from '@uc/contracts';
import type { Response } from 'express';
import { Meta } from '../../common/decorators';
import { Errors } from '../../common/errors';
import type { AppRequest, RequestMeta } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zod(LoginRequest)) body: LoginRequest,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const { token, me } = await this.auth.login(body, meta);
    this.sessions.setCookie(res, body.audience, token);
    return me;
  }

  @Get('me')
  async me(@Req() req: AppRequest, @Query('audience') audienceRaw: unknown): Promise<MeResponse> {
    const audience = this.auth.audienceOf(audienceRaw);
    const auth = await this.sessions.resolve(this.sessions.tokenFrom(req, audience), audience);
    if (!auth) throw Errors.unauthenticated();
    return this.auth.me(auth);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: AppRequest,
    @Query('audience') audienceRaw: unknown,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.endSessions(req, audienceRaw, meta, res, false);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @Req() req: AppRequest,
    @Query('audience') audienceRaw: unknown,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.endSessions(req, audienceRaw, meta, res, true);
  }

  private async endSessions(
    req: AppRequest,
    audienceRaw: unknown,
    meta: RequestMeta,
    res: Response,
    all: boolean,
  ) {
    const audience = this.auth.audienceOf(audienceRaw);
    const auth = await this.sessions.resolve(this.sessions.tokenFrom(req, audience), audience);
    this.sessions.clearCookie(res, audience);
    if (!auth) throw Errors.unauthenticated();
    await this.auth.logout(auth, meta, all);
  }

  @Post('invitations/preview')
  @HttpCode(200)
  preview(@Body(zod(InvitationPreviewRequest)) body: { token: string }) {
    return this.auth.previewInvitation(body.token);
  }

  @Post('invitations/accept')
  @HttpCode(200)
  accept(@Body(zod(AcceptInvitationRequest)) body: AcceptInvitationRequest, @Meta() meta: RequestMeta) {
    return this.auth.acceptInvitation(body, meta);
  }
}
