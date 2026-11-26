/** Nhóm điều hướng (mục 8 của báo cáo). Mỗi trung tâm được thêm vào đây khi giai đoạn của nó bắt đầu. */
export const NAV_GROUPS: { title: string; items: { code: string; name: string }[] }[] = [
  { title: 'Điều hành', items: [{ code: 'M01', name: 'Tổng quan doanh nghiệp' }, { code: 'M02', name: 'AI Tổng điều hành' }, { code: 'M07', name: 'Giao việc' }] },
  { title: 'AI', items: [{ code: 'M03', name: 'Chat AI' }, { code: 'M04', name: 'AI Provider' }, { code: 'M05', name: 'AI Agent' }, { code: 'M06', name: 'Bộ nhớ và kiến thức' }] },
  { title: 'Nội dung', items: [{ code: 'M09', name: 'Kho nội dung gốc' }, { code: 'M10', name: 'Kho thành phẩm' }, { code: 'M11', name: 'Video AI' }] },
  { title: 'Kênh', items: [{ code: 'M17', name: 'Meta' }, { code: 'M18', name: 'Google' }, { code: 'M19', name: 'TikTok' }, { code: 'M20', name: 'YouTube' }] },
  { title: 'Bán hàng', items: [{ code: 'M22', name: 'Shopify' }, { code: 'M26', name: 'POSCake' }] },
  { title: 'Dữ liệu', items: [{ code: 'M08', name: 'Dây chuyền tự động hóa' }] },
  { title: 'Hạ tầng', items: [{ code: 'INF', name: 'VPS, Worker, GPU' }] },
  { title: 'Hệ thống', items: [{ code: 'SYS', name: 'Tenant, vai trò, audit' }] },
];

export const DASHBOARD_METRICS = [
  'Doanh thu', 'Lợi nhuận', 'Chi phí quảng cáo', 'Nội dung', 'Khách đang chờ', 'AI đang chạy', 'Hạn mức API',
  'Chi phí AI', 'VPS', 'GPU', 'Cảnh báo', 'Việc chờ duyệt', 'Đơn hàng', 'Kênh đã kết nối',
];
