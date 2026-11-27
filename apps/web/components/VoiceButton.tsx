'use client';

import { useEffect, useRef, useState } from 'react';

// The Web Speech API is not in TypeScript's DOM types yet.
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Trình duyệt chưa cho phép dùng micro. Bấm biểu tượng ổ khóa cạnh địa chỉ trang để cho phép.',
  'no-speech': 'Không nghe thấy tiếng nói. Thử lại và nói gần micro hơn.',
  network: 'Không kết nối được dịch vụ nhận dạng giọng nói của trình duyệt.',
  'audio-capture': 'Không tìm thấy micro.',
};

/**
 * Speech to text with the browser's own recognition (Edge, Chrome), in Vietnamese. Each finished
 * sentence is passed to onText. The audio goes to the browser maker's recognition service, not to
 * MARIS; the button says so.
 */
export function VoiceButton({ onText, onError, disabled }: { onText: (t: string) => void; onError: (m: string) => void; disabled?: boolean }) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);

  useEffect(() => {
    setSupported(!!recognitionCtor());
    return () => rec.current?.stop();
  }, []);

  if (!supported) return null;

  function toggle() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Ctor = recognitionCtor()!;
    const r = new Ctor();
    r.lang = 'vi-VN';
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) onText(res[0].transcript.trim());
      }
    };
    r.onerror = (e) => onError(ERRORS[e.error] ?? `Lỗi nhận dạng giọng nói: ${e.error}`);
    r.onend = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-pressed={listening}
      aria-label={listening ? 'Dừng nghe' : 'Nói thay vì gõ'}
      title={
        listening
          ? 'Đang nghe… bấm để dừng'
          : 'Nói thay vì gõ (tiếng Việt). Trình duyệt gửi âm thanh tới dịch vụ nhận dạng giọng nói của hãng trình duyệt.'
      }
      className={`rounded-md border px-3 text-sm disabled:opacity-60 ${listening ? 'animate-pulse border-danger text-danger' : 'border-line'}`}
    >
      {listening ? '● Đang nghe' : '🎤'}
    </button>
  );
}
