import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import {
  AcceptInvitationRequest,
  InvitationPreviewRequest,
  LoginRequest,
  MfaConfirmRequest,
  MfaDisableRequest,
  MfaVerifyRequest,
  type MeResponse,
  type z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Meta } from '../../common/decorators';
import { Errors } from '../../common/errors';
import type { AppRequest, RequestMeta } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
  ) {}

  /** The signed-in staff member (either staff audience) for account-security endpoints. */
  private async staff(req: AppRequest) {
    for (const audience of ['merchant', 'platform'] as const) {
      const auth = await this.sessions.resolve(this.sessions.tokenFrom(req, audience), audience);
      if (auth) return auth;
    }
    throw Errors.unauthenticated();
  }

  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(
    @Body(zod(MfaVerifyRequest)) body: MfaVerifyRequest,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const { token, me, audience } = await this.auth.verifyMfa(body.challengeToken, body.code, meta);
    this.sessions.setCookie(res, audience, token);
    return me;
  }

  @Get('mfa')
  async mfaStatus(@Req() req: AppRequest) {
    return this.mfa.status((await this.staff(req)).userId);
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  async enroll(@Req() req: AppRequest) {
    return this.mfa.enroll(await this.staff(req));
  }

  @Post('mfa/confirm')
  @HttpCode(200)
  async confirm(
    @Req() req: AppRequest,
    @Body(zod(MfaConfirmRequest)) body: z.infer<typeof MfaConfirmRequest>,
    @Meta() meta: RequestMeta,
  ) {
    return this.mfa.confirm(await this.staff(req), body.code, meta);
  }

  @Post('mfa/disable')
  @HttpCode(204)
  async disable(
    @Req() req: AppRequest,
    @Body(zod(MfaDisableRequest)) body: z.infer<typeof MfaDisableRequest>,
    @Meta() meta: RequestMeta,
  ) {
    await this.mfa.disable(await this.staff(req), body.password, body.code, meta);
  }

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
