import { SessionStore, type Comment, type CommentKind } from '@agent-monitor/protocol';

/**
 * The person in front of VS Code, scripted.
 *
 * Goes through the same {@link SessionStore} the extension will use, so an E2E test
 * exercises the real write path rather than a test-only shortcut.
 */
export class FakeHuman {
  readonly #store: SessionStore;

  constructor(root: string, sessionId: string) {
    this.#store = SessionStore.open(root, sessionId);
  }

  comment(text: string, kind: CommentKind = 'steer', replyTo?: number): Promise<Comment> {
    return this.#store.appendComment({
      kind,
      text,
      ...(replyTo === undefined ? {} : { reply_to: replyTo }),
      author: 'fake-human',
    });
  }

  /** Answer the agent's blocking question. */
  answer(text: string, replyTo?: number): Promise<Comment> {
    return this.comment(text, 'answer', replyTo);
  }

  /** Tell the agent to stop and wait. */
  stop(text = 'stop and wait'): Promise<Comment> {
    return this.comment(text, 'stop');
  }

  get store(): SessionStore {
    return this.#store;
  }
}
