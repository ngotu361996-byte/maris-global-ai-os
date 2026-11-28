import { fromPageFeed, parseWebhook, timeOf } from './inbox-events';
import { parseSuggestion } from './meta-inbox.service';

describe('Meta inbox events', () => {
  it('reads Meta times in seconds, milliseconds and ISO text', () => {
    const at = Date.parse('2026-11-28T03:00:00Z');
    expect(timeOf(at / 1000).getTime()).toBe(at);
    expect(timeOf(at).getTime()).toBe(at);
    expect(timeOf('2026-11-28T03:00:00+0000').getTime()).toBe(at);
  });

  it('puts comment replies under their top-level comment and marks the Page’s own', () => {
    const [top, reply, own] = parseWebhook({
      object: 'page',
      entry: [
        {
          id: '55',
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: '55_1_a',
                post_id: '55_1',
                parent_id: '55_1',
                from: { id: 'u1', name: 'An' },
                message: 'Hỏi',
                created_time: 1,
              },
            },
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: '55_1_b',
                post_id: '55_1',
                parent_id: '55_1_a',
                from: { id: 'u2', name: 'Bình' },
                message: 'Mình nữa',
                created_time: 2,
              },
            },
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: '55_1_c',
                post_id: '55_1',
                parent_id: '55_1_a',
                from: { id: '55', name: 'Shop' },
                message: 'Dạ',
                created_time: 3,
              },
            },
          ],
        },
      ],
    });
    expect(top!.inbound).toMatchObject({
      threadKey: '55_1_a',
      customer: { id: 'u1', name: 'An' },
      fromBusiness: false,
    });
    expect(reply!.inbound).toMatchObject({ threadKey: '55_1_a', customer: { id: 'u2' } });
    expect(own!.inbound).toMatchObject({ threadKey: '55_1_a', customer: null, fromBusiness: true });
    expect(new Set([top!.key, reply!.key, own!.key]).size).toBe(3);
  });

  it('keeps echoes as the business’s and skips what MARIS does not use', () => {
    const out = parseWebhook({
      object: 'page',
      entry: [
        {
          id: '55',
          messaging: [
            {
              sender: { id: '55' },
              recipient: { id: 'p1' },
              timestamp: 1,
              message: { mid: 'm1', text: 'Dạ', is_echo: true },
            },
            { sender: { id: 'p1' }, recipient: { id: '55' }, timestamp: 1, read: { watermark: 1 } },
          ],
          changes: [{ field: 'feed', value: { item: 'like', verb: 'add' } }],
        },
      ],
    });
    expect(out[0]!.inbound).toMatchObject({
      channel: 'messenger',
      threadKey: 'p1',
      fromBusiness: true,
    });
    expect(out[1]!.skipped).toContain('không phải tin nhắn');
    expect(out[2]!.skipped).toContain('không phải bình luận');
    expect(parseWebhook('rác')).toEqual([]);
  });

  it('reads comments from a Page feed', () => {
    const r = fromPageFeed('55', {
      data: [
        {
          id: '55_9',
          comments: {
            data: [
              {
                id: 'c',
                from: { id: 'u', name: 'Chi' },
                message: 'Giá?',
                created_time: '2026-11-28T03:00:00+0000',
              },
            ],
          },
        },
      ],
    });
    expect(r).toEqual([
      expect.objectContaining({
        channel: 'fb_comment',
        threadKey: 'c',
        postId: '55_9',
        body: 'Giá?',
      }),
    ]);
  });

  it('reads the AI’s JSON even inside a code fence', () => {
    expect(parseSuggestion('```json\n{"reply":"Dạ","handoff":false}\n```')).toEqual({
      reply: 'Dạ',
      handoff: false,
      reason: null,
    });
    expect(parseSuggestion('{"reply":"","handoff":true,"reason":"Khiếu nại"}')).toEqual({
      reply: '',
      handoff: true,
      reason: 'Khiếu nại',
    });
    expect(parseSuggestion('Xin chào')).toBeNull();
    expect(parseSuggestion('{"reply":""}')).toBeNull();
  });
});
