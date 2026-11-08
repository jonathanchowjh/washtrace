import { briefOf, redact, urlSecrets, type Store } from '@washtrace/detect';

/**
 * The store's migration at start-up, tried until it takes, and what /health
 * answers meanwhile. A class because the two share one fact: whether the last
 * attempt failed, and why.
 */
export class Migrating {
  /** The last failed attempt's message, scrubbed; null while none has failed since the start or the last success. */
  private failed: string | null = null;

  constructor(
    private readonly store: Pick<Store, 'migrate'>,
    /** For its secrets: a connection error may carry the URL or its host. */
    private readonly storeUrl: string,
  ) {}

  /**
   * Migrates, trying again on failure: the store may still be starting (an
   * ordinary compose or k8s ordering), and the worker keeps trying rather
   * than crash-looping. Logged on the first failure and every tenth.
   */
  async run(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.store.migrate();
        this.failed = null;
        return;
      } catch (err) {
        // Scrubbed as the worker scrubs every error it shows: the message is served on /health.
        this.failed = redact(briefOf(err), urlSecrets(this.storeUrl));
        if (attempt === 1 || attempt % 10 === 0) console.error('[worker] store not ready (attempt %d): %s', attempt, this.failed);
        await this.pause(Math.min(30_000, 1_000 * attempt));
      }
    }
  }

  /**
   * Ruling PP: 200 `migrating` while nothing has failed, so a slow first
   * migration (#28 builds an index over every flow, ten minutes and more on a
   * live install) is not taken for a dead worker and stopped part way; 503
   * with the error once an attempt has failed, until one takes, so a migrate
   * that fails for ever looks unhealthy.
   */
  health(): { status: 200 | 503; body: { ok: boolean; migrating: true; error?: string } } {
    return this.failed === null
      ? { status: 200, body: { ok: true, migrating: true } }
      : { status: 503, body: { ok: false, migrating: true, error: this.failed } };
  }

  /** The wait before the next attempt. Tests override it on the instance. */
  pause(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
