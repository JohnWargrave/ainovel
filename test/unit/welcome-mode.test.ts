import { describe, expect, it } from 'vitest';
import { isWelcomeDeferred } from '../../src/modules/auth/auth.service.js';

// The mode is a global setting, so flipping it inside an integration test would race every other
// suite that signs up a guest in parallel. The decision itself is covered here instead.
describe('welcome bonus mode', () => {
  it('pays everyone at signup in instant mode', () => {
    for (const provider of ['guest', 'google', 'facebook', 'password']) {
      expect(isWelcomeDeferred('instant', provider)).toBe(false);
    }
  });

  it('holds only the guest bonus in link_required mode', () => {
    expect(isWelcomeDeferred('link_required', 'guest')).toBe(true);
    for (const provider of ['google', 'facebook', 'password']) {
      expect(isWelcomeDeferred('link_required', provider)).toBe(false);
    }
  });
});
