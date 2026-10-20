import { Inject, Injectable } from '@nestjs/common';
import {
  decryptSecret,
  encryptSecret,
  generateToken,
  mfaChallenges,
  mfaFactors,
  sha256,
  users,
  verifyPassword,
  writeAudit,
} from '@uc/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import type { AuthState, RequestMeta } from '../../common/request';
import { newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from '../../common/totp';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DbService } from '../../db/db.service';

const CHALLENGE_MS = 5 * 60_000;
const CHALLENGE_ATTEMPTS = 5;

/**
 * TOTP multi-factor authentication for staff and platform operators (Phase 11, ADR-026). The seed is sealed with
 * AES-256-GCM; codes are single-use (last accepted step is stored); recovery codes are stored hashed and burn on use.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private audit(userId: string, action: string, meta: RequestMeta, values: Record<string, unknown> = {}) {
    return this.db.system((tx) =>
      writeAudit(tx, {
        tenantId: null,
        actorType: 'user',
        actorUserId: userId,
        action,
        entityType: 'user',
        entityId: userId,
        newValues: values,
        correlationId: meta.correlationId,
        ip: meta.ip,
      }),
    );
  }

  async factor(userId: string) {
    const [f] = await this.db.system((tx) =>
      tx.select().from(mfaFactors).where(eq(mfaFactors.userId, userId)),
    );
    return f ?? null;
  }

  async status(userId: string) {
    const f = await this.factor(userId);
    return {
      enrolled: !!f?.confirmedAt,
      recoveryCodesLeft: f?.confirmedAt ? f.recoveryHashes.length : 0,
      required: false,
    };
  }

  async enroll(auth: AuthState) {
    const f = await this.factor(auth.userId);
    if (f?.confirmedAt)
      throw Errors.conflict(
        'INVALID_STATE_TRANSITION',
        'Two-step sign-in is already on; turn it off first to re-enrol',
      );
    const secret = newTotpSecret();
    const sealed = encryptSecret(secret, this.config.SECRETS_ENCRYPTION_KEY);
    await this.db.system((tx) =>
      tx
        .insert(mfaFactors)
        .values({ userId: auth.userId, secretSealed: sealed })
        .onConflictDoUpdate({
          target: mfaFactors.userId,
          set: { secretSealed: sealed, confirmedAt: null, lastStep: null, recoveryHashes: [] },
        }),
    );
    return { secret, otpauthUri: otpauthUri(secret, auth.email) };
  }

  async confirm(auth: AuthState, code: string, meta: RequestMeta) {
    const f = await this.factor(auth.userId);
    if (!f || f.confirmedAt) throw Errors.conflict('INVALID_STATE_TRANSITION', 'Start enrolment first');
    const step = verifyTotp(decryptSecret(f.secretSealed, this.config.SECRETS_ENCRYPTION_KEY), code, null);
    if (step === null)
      throw new AppError(
        422,
        'MFA_INVALID',
        'That code is not right. Check the time on your phone and try again.',
      );
    const codes = newRecoveryCodes();
    await this.db.system((tx) =>
      tx
        .update(mfaFactors)
        .set({ confirmedAt: new Date(), lastStep: step, recoveryHashes: codes.map(sha256) })
        .where(eq(mfaFactors.userId, auth.userId)),
    );
    await this.audit(auth.userId, 'auth.mfa_enabled', meta);
    return { recoveryCodes: codes };
  }

  /** Checks a TOTP code (single-use per step) or burns a recovery code. */
  async checkCode(userId: string, code: string): Promise<boolean> {
    return this.db.system(async (tx) => {
      const [f] = await tx.select().from(mfaFactors).where(eq(mfaFactors.userId, userId)).for('update');
      if (!f?.confirmedAt) return false;
      if (/^\d{6}$/.test(code)) {
        const step = verifyTotp(
          decryptSecret(f.secretSealed, this.config.SECRETS_ENCRYPTION_KEY),
          code,
          f.lastStep,
        );
        if (step === null) return false;
        await tx.update(mfaFactors).set({ lastStep: step }).where(eq(mfaFactors.userId, userId));
        return true;
      }
      const h = sha256(code.toLowerCase());
      if (!f.recoveryHashes.includes(h)) return false;
      await tx
        .update(mfaFactors)
        .set({ recoveryHashes: f.recoveryHashes.filter((x) => x !== h) })
        .where(eq(mfaFactors.userId, userId));
      return true;
    });
  }

  async disable(auth: AuthState, password: string, code: string, meta: RequestMeta) {
    const [u] = await this.db.system((tx) => tx.select().from(users).where(eq(users.id, auth.userId)));
    if (!u || !(await verifyPassword(u.passwordHash, password)) || !(await this.checkCode(auth.userId, code)))
      throw new AppError(422, 'MFA_INVALID', 'Password or code is not right');
    await this.db.system((tx) => tx.delete(mfaFactors).where(eq(mfaFactors.userId, auth.userId)));
    await this.audit(auth.userId, 'auth.mfa_disabled', meta);
  }

  /** After a correct password for an MFA user: a short-lived challenge instead of a session. */
  async challenge(userId: string, audience: string): Promise<{ challengeToken: string; expiresAt: string }> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + CHALLENGE_MS);
    await this.db.system((tx) =>
      tx.insert(mfaChallenges).values({ tokenHash: sha256(token), userId, audience, expiresAt }),
    );
    return { challengeToken: token, expiresAt: expiresAt.toISOString() };
  }

  /** Consumes a challenge with a valid code; returns the user and audience to start a session for. */
  async completeChallenge(
    token: string,
    code: string,
    meta: RequestMeta,
  ): Promise<{ userId: string; audience: string }> {
    const invalid = () =>
      new AppError(
        401,
        'MFA_INVALID',
        'The code is not right, or the sign-in attempt expired. Sign in again.',
      );
    const [c] = await this.db.system((tx) =>
      tx
        .update(mfaChallenges)
        .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
        .where(
          and(
            eq(mfaChallenges.tokenHash, sha256(token)),
            isNull(mfaChallenges.usedAt),
            gt(mfaChallenges.expiresAt, new Date()),
          ),
        )
        .returning(),
    );
    if (!c || c.attempts > CHALLENGE_ATTEMPTS) throw invalid();
    if (!(await this.checkCode(c.userId, code))) {
      await this.audit(c.userId, 'auth.mfa_failed', meta, { audience: c.audience });
      throw invalid();
    }
    const [used] = await this.db.system((tx) =>
      tx
        .update(mfaChallenges)
        .set({ usedAt: new Date() })
        .where(and(eq(mfaChallenges.id, c.id), isNull(mfaChallenges.usedAt)))
        .returning(),
    );
    if (!used) throw invalid();
    return { userId: c.userId, audience: c.audience };
  }
}
