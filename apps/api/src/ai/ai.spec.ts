import { assertAllowedProviderUrl, isPrivate } from './url-guard';
import { buildTurns, orderCandidates, SYSTEM_PROMPT } from './chat.service';
import { cost, type ProviderRow } from './ai-router.service';
import { errorFromStatus } from './provider-error';

describe('AI provider URL guard (SSRF)', () => {
  const strict = { kind: 'openai', allowPrivate: false };

  it.each([
    'http://127.0.0.1:8080/v1',
    'https://10.0.0.5/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.10',
    'https://[::1]/v1',
    'https://[fd00::1]/v1',
    'https://user:pass@api.example.com',
    'ftp://api.example.com',
  ])('blocks %s', async (url) => {
    await expect(assertAllowedProviderUrl(url, strict)).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  });

  it('requires https for public hosts', async () => {
    await expect(assertAllowedProviderUrl('http://8.8.8.8/v1', strict)).rejects.toMatchObject({ code: 'BLOCKED_URL' });
    await expect(assertAllowedProviderUrl('https://8.8.8.8/v1', strict)).resolves.toBeInstanceOf(URL);
  });

  it('lets Ollama use the loopback interface only', async () => {
    await expect(assertAllowedProviderUrl('http://127.0.0.1:11434/v1', { kind: 'ollama', allowPrivate: false })).resolves.toBeInstanceOf(URL);
    await expect(assertAllowedProviderUrl('http://10.1.2.3:11434/v1', { kind: 'ollama', allowPrivate: false })).rejects.toMatchObject({
      code: 'BLOCKED_URL',
    });
  });

  it('allows private networks only when configured', async () => {
    await expect(assertAllowedProviderUrl('http://10.0.0.5/v1', { kind: 'openai', allowPrivate: true })).resolves.toBeInstanceOf(URL);
  });

  it('classifies addresses', () => {
    expect(['100.64.0.1', '172.16.0.1', '0.0.0.0', '::ffff:10.0.0.1', 'fe80::1'].every(isPrivate)).toBe(true);
    expect(['1.1.1.1', '172.32.0.1', '2606:4700::1111'].some(isPrivate)).toBe(false);
  });
});

describe('router helpers', () => {
  const p = (id: string, defaultModel = `${id}-m`) => ({ id, defaultModel }) as ProviderRow;

  it('puts the chosen provider and model first, then the failover order', () => {
    const list = [p('a'), p('b'), p('c')];
    expect(orderCandidates(list, 'b', 'big').map((c) => [c.provider.id, c.model])).toEqual([
      ['b', 'big'],
      ['a', 'a-m'],
      ['c', 'c-m'],
    ]);
    expect(orderCandidates(list, null, null).map((c) => c.provider.id)).toEqual(['a', 'b', 'c']);
    // A chosen provider that is disabled (not in the list) is ignored.
    expect(orderCandidates(list, 'zzz', 'x')[0]!.model).toBe('a-m');
  });

  it('builds turns with the system prompt and skips failed replies', () => {
    const turns = buildTurns(
      [
        { role: 'user', content: 'hỏi 1', status: 'complete' },
        { role: 'assistant', content: '', status: 'error' },
        { role: 'user', content: 'hỏi 2', status: 'complete' },
        { role: 'assistant', content: 'đáp 2', status: 'complete' },
      ],
      'hỏi 3',
    );
    expect(turns[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(turns.slice(1).map((t) => t.content)).toEqual(['hỏi 1', 'hỏi 2', 'đáp 2', 'hỏi 3']);
  });

  it('computes cost per million tokens', () => {
    expect(cost({ inputCostPerMtok: '2.5', outputCostPerMtok: '10' }, { inputTokens: 2000, outputTokens: 1000 })).toBe(0.015);
    expect(cost({ inputCostPerMtok: null, outputCostPerMtok: null }, { inputTokens: 5, outputTokens: 5 })).toBeNull();
  });

  it('maps HTTP status to failover behaviour', () => {
    expect(errorFromStatus(401, '')).toMatchObject({ code: 'AUTH', failover: true, retryable: false });
    expect(errorFromStatus(429, '')).toMatchObject({ code: 'RATE_LIMIT', failover: true, retryable: true });
    expect(errorFromStatus(503, '')).toMatchObject({ code: 'UPSTREAM', retryable: true });
    expect(errorFromStatus(400, '')).toMatchObject({ code: 'BAD_REQUEST', failover: false });
  });
});
