import type { DeliveryFailure, OutboxMessage, OutboxRelay } from '@factory/db';
import { classifyFailure, type ForgeAdapter } from '@factory/domain';
import { ForgeError } from '@factory/github';
import { z } from 'zod';

const issueComment = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  issueNumber: z.number().int().positive(),
  body: z.string().min(1),
});

class MalformedMessage extends Error {}

/** Sends one outbox message through the forge, by kind. */
export function createOutboxSender(forge: ForgeAdapter): (message: OutboxMessage) => Promise<unknown> {
  return async (message) => {
    switch (message.kind) {
      case 'issue.comment': {
        const parsed = issueComment.safeParse(message.payload);
        if (!parsed.success) {
          throw new MalformedMessage(`malformed issue.comment payload: ${parsed.error.message}`);
        }
        return forge.comment({
          ...parsed.data,
          dedupeKey: `outbox-${message.id}`,
          mayAlreadyExist: message.attempts > 0,
        });
      }
      default:
        throw new MalformedMessage(`no sender for outbox kind ${message.kind}`);
    }
  };
}

/** Decides whether a failed delivery is worth retrying. */
export function classifyDelivery(error: unknown): DeliveryFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ForgeError) {
    return {
      failureClass: error.retryable ? 'transient' : 'permanent',
      message,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  if (error instanceof MalformedMessage) {
    return { failureClass: 'permanent', message };
  }
  return { failureClass: classifyFailure({ error }), message };
}

export async function deliverNextOutbox(
  relay: Pick<OutboxRelay, 'deliverNext'>,
  forge: ForgeAdapter,
  /** The pause switch. While paused, messages wait in the outbox. */
  allowsSending: () => Promise<{ ok: boolean }> = async () => ({ ok: true }),
): Promise<string | null> {
  if (!(await allowsSending()).ok) {
    return null;
  }
  const delivery = await relay.deliverNext(createOutboxSender(forge), classifyDelivery);
  if (!delivery) {
    return null;
  }
  return delivery.outcome === 'sent'
    ? `outbox ${delivery.id} (${delivery.kind}) sent`
    : `outbox ${delivery.id} (${delivery.kind}) ${delivery.outcome}: ${delivery.error}`;
}
