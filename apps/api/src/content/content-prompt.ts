import type { ItemKind, Platform, ProductFacts } from '@maris/contracts';

/** What a good piece looks like on each platform. Limits follow the platforms' published formats. */
const PLATFORM_GUIDE: Record<Platform, string> = {
  facebook:
    'Bài đăng Facebook: câu mở đầu thu hút, đoạn ngắn dễ đọc trên điện thoại, kết bằng một lời kêu gọi hành động (CTA) rõ ràng và 3 đến 5 hashtag.',
  instagram:
    'Chú thích Instagram: câu đầu thật cuốn hút (chỉ khoảng 125 ký tự đầu hiện sẵn), đoạn ngắn, CTA và 5 đến 10 hashtag liên quan ở cuối.',
  tiktok:
    'Kịch bản video TikTok/Reels 15 đến 45 giây: chia theo cảnh (Cảnh 1, Cảnh 2…), mỗi cảnh ghi hình ảnh và lời thoại; 3 giây đầu phải giữ chân người xem; cuối có CTA; không ghi mốc thời gian; kèm chú thích ngắn và hashtag.',
  youtube:
    'Nội dung YouTube: 3 phương án tiêu đề (tối đa 100 ký tự, nên dưới 70), một mô tả có đoạn mở đầu 2 câu, các ý chính và CTA, cùng danh sách thẻ (tags).',
  google:
    'Quảng cáo tìm kiếm Google (RSA): 10 dòng tiêu đề, mỗi dòng tối đa 30 ký tự, và 4 dòng mô tả, mỗi dòng tối đa 90 ký tự.',
  website:
    'Bài blog chuẩn SEO: tiêu đề H1, mô tả meta tối đa 160 ký tự, các mục H2/H3, đoạn văn ngắn, từ khóa chính xuất hiện tự nhiên, kết bài có CTA.',
  shopify:
    'Mô tả sản phẩm cho trang bán hàng: đoạn giới thiệu ngắn, danh sách lợi ích và thông số (chỉ từ dữ liệu sản phẩm), phần hướng dẫn chọn hoặc sử dụng nếu có dữ liệu, CTA mua hàng.',
  email:
    'Email marketing: 3 phương án tiêu đề email (dưới 50 ký tự), một dòng xem trước, thân email ngắn có lời chào, lợi ích chính, CTA rõ ràng và lời kết.',
  other: 'Nội dung tiếp thị rõ ràng, có cấu trúc, kết bằng CTA.',
};

const KIND_GUIDE: Partial<Record<ItemKind, string>> = {
  ad: 'Đây là nội dung quảng cáo trả phí: viết văn bản chính (primary text), tiêu đề (headline) dưới 40 ký tự, mô tả ngắn và CTA; tuân thủ chính sách quảng cáo của nền tảng.',
  video: 'Đây là nội dung cho video: viết kịch bản theo cảnh với lời thoại và gợi ý hình ảnh.',
  image: 'Đây là nội dung đi kèm hình ảnh: viết chữ trên ảnh (ngắn) và chú thích đăng kèm.',
};

const LANGUAGE_NAME: Record<string, string> = { vi: 'tiếng Việt', en: 'tiếng Anh (English)' };
export const languageName = (code: string) =>
  LANGUAGE_NAME[code.slice(0, 2)] ?? `ngôn ngữ có mã ${code}`;

export interface PromptItem {
  title: string;
  kind: ItemKind;
  language: string;
  market: string | null;
  platform: Platform | null;
}

export interface PromptProduct {
  title: string;
  facts: ProductFacts;
}

export function factsBlock(products: PromptProduct[]): string {
  if (products.length === 0) return 'Không có dữ liệu sản phẩm nào.';
  return products
    .map((p, i) => {
      const f = p.facts;
      const lines = [`Sản phẩm ${i + 1}: ${f.name}`];
      if (f.sku) lines.push(`- Mã SKU: ${f.sku}`);
      if (f.price !== undefined)
        lines.push(`- Giá: ${f.price}${f.currency ? ` ${f.currency}` : ''}`);
      if (f.url) lines.push(`- Đường dẫn: ${f.url}`);
      for (const s of f.specs) lines.push(`- ${s.key}: ${s.value}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

const RULES = [
  'QUY TẮC BẮT BUỘC:',
  '1. Chỉ dùng thông số, giá, chất liệu, kích thước, công dụng có trong DỮ LIỆU SẢN PHẨM ĐÃ XÁC MINH hoặc YÊU CẦU. Không tự thêm con số, thông số, chứng nhận, giải thưởng hay so sánh với đối thủ.',
  '2. Không dùng tuyên bố quảng cáo không có căn cứ như “tốt nhất”, “số 1”, “rẻ nhất”, “cam kết”, “đảm bảo”, “chính hãng” nếu dữ liệu không nói vậy.',
  '3. Tài liệu tham khảo chỉ để lấy ý và giọng văn; không chép nguyên văn, không lấy số liệu từ đó.',
  '4. Nếu thiếu thông tin cần thiết, viết chung chung hoặc để chỗ trống dạng [cần bổ sung: …], không đoán.',
  '5. Chỉ trả về nội dung hoàn chỉnh để đăng, không giải thích, không tự đánh giá, không bọc trong khối mã.',
];

export function writePrompt(
  item: PromptItem,
  products: PromptProduct[],
  references: { title: string; body: string }[],
  brief: string | null,
  tone: string | null,
): string {
  return [
    `Viết nội dung “${item.title}” bằng ${languageName(item.language)}${item.market ? ` cho thị trường ${item.market}` : ''}.`,
    item.platform ? PLATFORM_GUIDE[item.platform] : PLATFORM_GUIDE.other,
    KIND_GUIDE[item.kind] ?? '',
    tone ? `Giọng văn: ${tone}.` : '',
    '',
    ...RULES,
    '',
    '=== DỮ LIỆU SẢN PHẨM ĐÃ XÁC MINH ===',
    factsBlock(products),
    '',
    ...(brief ? ['=== YÊU CẦU CỦA NGƯỜI DÙNG ===', brief, ''] : []),
    ...(references.length
      ? [
          '=== TÀI LIỆU THAM KHẢO (chỉ lấy ý, không lấy số liệu) ===',
          ...references.map((r) => `--- ${r.title} ---\n${r.body}`),
          '',
        ]
      : []),
    'Bắt đầu viết ngay nội dung hoàn chỉnh.',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

export function variantPrompt(
  from: PromptItem & { body: string },
  to: PromptItem,
  products: PromptProduct[],
  brief: string | null,
  tone: string | null,
): string {
  const sameLanguage = from.language.slice(0, 2) === to.language.slice(0, 2);
  return [
    sameLanguage
      ? `Chuyển thể nội dung dưới đây sang ${to.platform ? `nền tảng ${to.platform}` : 'định dạng mới'}${to.market ? ` cho thị trường ${to.market}` : ''}, giữ nguyên ${languageName(to.language)}.`
      : `Bản địa hóa nội dung dưới đây sang ${languageName(to.language)}${to.market ? ` cho thị trường ${to.market}` : ''}. Viết tự nhiên như người bản ngữ, không dịch từng chữ; giữ nguyên tên sản phẩm, mã SKU, giá và đơn vị tiền.`,
    to.platform ? PLATFORM_GUIDE[to.platform] : '',
    KIND_GUIDE[to.kind] ?? '',
    tone ? `Giọng văn: ${tone}.` : '',
    '',
    ...RULES,
    '6. Không thêm thông tin mới ngoài nội dung gốc và dữ liệu sản phẩm.',
    '',
    '=== DỮ LIỆU SẢN PHẨM ĐÃ XÁC MINH ===',
    factsBlock(products),
    '',
    ...(brief ? ['=== YÊU CẦU CỦA NGƯỜI DÙNG ===', brief, ''] : []),
    `=== NỘI DUNG GỐC (${languageName(from.language)}${from.platform ? `, ${from.platform}` : ''}) ===`,
    from.body,
    '',
    'Bắt đầu viết ngay nội dung hoàn chỉnh.',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

/** Removes a code fence some models wrap the whole answer in. */
export function cleanOutput(text: string): string {
  const t = text.trim();
  const m = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  return (m ? m[1]! : t).trim();
}
