import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeMode = 'ok' | '500' | '401' | '400' | 'slow' | 'midfail';

export interface FakeRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

/**
 * A local stand-in for OpenAI, Anthropic and Gemini streaming APIs, so tests never call
 * a real provider or spend money. Each path prefix (/a, /b, …) has its own mode.
 */
export class FakeAi {
  readonly requests: FakeRequest[] = [];
  readonly modes: Record<string, FakeMode> = {};
  /** When set and it returns text, OpenAI-compatible requests stream that text instead of "Xin chào". */
  reply?: (body: any) => string | null;
  private server!: Server;
  private sockets = new Set<import('node:net').Socket>();
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  count(prefix: string): number {
    return this.requests.filter((r) => r.path.startsWith(prefix) && !r.path.includes('models')).length;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = req.url ?? '';
    this.requests.push({ path, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const prefix = path.split('/')[1] ?? '';
    const mode = this.modes[prefix] ?? 'ok';

    if (req.method === 'GET' && path.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fake-large' }, { id: 'fake-mini' }] }));
      return;
    }
    if (mode === 'slow') return; // never answers; the router's timeout must fire
    if (mode === '500' || mode === '401' || mode === '400') {
      res.statusCode = Number(mode);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: `fake ${mode}` } }));
      return;
    }

    if (path.endsWith('/audio/speech')) {
      // OpenAI text-to-speech: a few bytes that start like an MP3 file.
      res.setHeader('content-type', 'audio/mpeg');
      res.end(Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from(String(this.requests.at(-1)!.body?.voice ?? ''))]));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const send = (data: unknown, event?: string) =>
      res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);

    if (path.includes('/v1/messages')) {
      // Anthropic
      send({ type: 'message_start', message: { usage: { input_tokens: 21, output_tokens: 1 } } }, 'message_start');
      send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude ' } }, 'content_block_delta');
      send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'trả lời' } }, 'content_block_delta');
      send({ type: 'message_delta', usage: { output_tokens: 4 } }, 'message_delta');
      send({ type: 'message_stop' }, 'message_stop');
      res.end();
      return;
    }
    if (path.includes(':streamGenerateContent')) {
      // Gemini
      send({ candidates: [{ content: { parts: [{ text: 'Gemini ' }] } }] });
      send({ candidates: [{ content: { parts: [{ text: 'xin chào' }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 } });
      res.end();
      return;
    }
    // OpenAI-compatible
    const custom = this.reply?.(this.requests.at(-1)!.body);
    if (custom != null && mode === 'ok') {
      send({ choices: [{ delta: { content: custom } }] });
      send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
      send('[DONE]');
      res.end();
      return;
    }
    send({ choices: [{ delta: { content: 'Xin' } }] });
    if (mode === 'midfail') {
      // Let the first chunk reach the client, then drop the connection.
      setTimeout(() => res.destroy(), 100);
      return;
    }
    send({ choices: [{ delta: { content: ' chào' } }] });
    send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
    send('[DONE]');
    res.end();
  }
}

/** Reads a server-sent-events response body into parsed events. */
export function parseSse(text: string): any[] {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'))
    .filter(Boolean)
    .map((d) => JSON.parse(d));
}
