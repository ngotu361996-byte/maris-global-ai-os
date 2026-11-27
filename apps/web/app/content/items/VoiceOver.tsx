'use client';

import { useState, type FormEvent } from 'react';
import {
  VOICE_AUTO,
  VOICE_DEFAULT_STYLE,
  VOICE_INFO,
  VOICEOVER_LIMITS,
  VOICES,
  type ItemDetailResponse,
  type VoiceoverResponse,
} from '@maris/contracts';
import { btnCls, inputCls } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * AI voice-over for a text item (spec Part 12): reads the current version aloud with an OpenAI
 * voice and saves it as a new audio item (draft). On auto, voices take turns female and male.
 */
export function VoiceOver({
  detail,
  onMade,
  onError,
}: {
  detail: ItemDetailResponse;
  onMade: (itemId: string, msg: string) => void;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const text = detail.versions.find((v) => v.version === detail.currentVersion)?.body ?? '';
  const lang = detail.language === 'en' ? 'en' : 'vi';
  const tooLong = text.length > VOICEOVER_LIMITS.maxChars;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const r = await api<VoiceoverResponse>(`/content/items/${detail.id}/voiceover`, {
        method: 'POST',
        body: JSON.stringify({
          voice: f.get('voice'),
          speed: Number(f.get('speed')),
          style: String(f.get('style') ?? '').trim() || null,
        }),
      });
      onMade(
        r.itemId,
        `Đã tạo giọng đọc ${VOICE_INFO[r.voice].label} (${r.chars} ký tự, khoảng ${r.costUsd.toFixed(4)} USD). Nghe thử rồi gửi duyệt; sau đó chọn nó khi xử lý video ở Kho nội dung gốc.`,
      );
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Giọng đọc AI</h3>
        <button
          type="button"
          className="text-sm text-accent underline"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Thu gọn' : 'Tạo giọng đọc từ nội dung này'}
        </button>
      </div>
      {open &&
        (!text.trim() ? (
          <p className="mt-2 text-sm text-muted">Mục này chưa có nội dung để đọc.</p>
        ) : tooLong ? (
          <p className="mt-2 text-sm text-danger">
            Nội dung dài {text.length} ký tự; giọng đọc nhận tối đa {VOICEOVER_LIMITS.maxChars}.
            Tách thành nhiều mục ngắn hơn.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-2 grid gap-3 text-sm">
            <p className="text-xs text-muted">
              Đọc phiên bản hiện tại ({text.length} ký tự) bằng giọng OpenAI (
              {VOICEOVER_LIMITS.model}
              ), dùng AI Provider OpenAI đang bật và tính vào ngân sách AI. Kết quả là một mục âm
              thanh mới (bản nháp).
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                Giọng
                <select name="voice" className={inputCls} defaultValue={VOICE_AUTO}>
                  <option value={VOICE_AUTO}>Tự động: luân phiên nữ và nam</option>
                  {VOICES.map((v) => (
                    <option key={v} value={v}>
                      {VOICE_INFO[v].label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tốc độ
                <select name="speed" className={inputCls} defaultValue="1">
                  <option value="0.85">Chậm (0,85×)</option>
                  <option value="1">Bình thường</option>
                  <option value="1.15">Hơi nhanh (1,15×)</option>
                  <option value="1.3">Nhanh (1,3×)</option>
                </select>
              </label>
            </div>
            <label>
              Phong cách đọc (để trống dùng mặc định)
              <textarea
                name="style"
                rows={2}
                maxLength={300}
                placeholder={VOICE_DEFAULT_STYLE[lang]}
                className={inputCls}
              />
            </label>
            <div>
              <button className={btnCls} disabled={busy}>
                {busy ? 'Đang tạo giọng đọc…' : 'Tạo giọng đọc'}
              </button>
            </div>
          </form>
        ))}
    </section>
  );
}
