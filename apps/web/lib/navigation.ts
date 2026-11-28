/** Nhóm điều hướng (mục 8 của báo cáo). Mục có href đã dùng được; mục khác sẽ mở theo giai đoạn. */
export interface NavItem {
  code: string;
  name: string;
  href?: string;
}

export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  { title: 'Điều hành', items: [{ code: 'M01', name: 'Tổng quan', href: '/' }, { code: 'M02', name: 'AI Tổng điều hành', href: '/command' }, { code: 'M07', name: 'Giao việc', href: '/tasks' }] },
  { title: 'AI', items: [{ code: 'M03', name: 'Chat AI', href: '/chat' }, { code: 'M03-HD', name: 'Hội đồng AI', href: '/council' }, { code: 'M04', name: 'AI Provider', href: '/ai' }, { code: 'M05', name: 'AI Agent', href: '/agents' }, { code: 'M05-SK', name: 'Skill', href: '/skills' }, { code: 'M34', name: 'Trung tâm Plugin', href: '/plugins' }, { code: 'M06', name: 'Bộ nhớ và kiến thức', href: '/memory' }] },
  { title: 'Nội dung', items: [{ code: 'M09', name: 'Kho nội dung gốc', href: '/content' }, { code: 'M10', name: 'Kho thành phẩm', href: '/content/items' }, { code: 'M16', name: 'Lịch xuất bản', href: '/meta/posts' }, { code: 'M11', name: 'Video AI' }] },
  { title: 'Kênh', items: [{ code: 'M17', name: 'Meta', href: '/meta' }, { code: 'M18', name: 'Google' }, { code: 'M19', name: 'TikTok' }, { code: 'M20', name: 'YouTube' }] },
  { title: 'Bán hàng', items: [{ code: 'M24', name: 'Hộp thư khách hàng', href: '/inbox' }, { code: 'M25', name: 'CRM và bán hàng', href: '/crm' }, { code: 'M22', name: 'Shopify' }, { code: 'M26', name: 'POSCake' }] },
  { title: 'Dữ liệu', items: [{ code: 'M08', name: 'Workflow (dây chuyền)', href: '/workflows' }, { code: 'M35', name: 'Connector', href: '/connectors' }] },
  { title: 'Hạ tầng', items: [{ code: 'M31', name: 'VPS, Worker, GPU', href: '/infra' }, { code: 'M32', name: 'Việc của Worker', href: '/infra/jobs' }, { code: 'M37', name: 'Giám sát hệ thống', href: '/system' }] },
  {
    title: 'Hệ thống',
    items: [
      { code: 'SYS-M', name: 'Thành viên', href: '/members' },
      { code: 'SYS-S', name: 'Secret Vault', href: '/secrets' },
    ],
  },
];

export const DASHBOARD_METRICS = [
  'Doanh thu', 'Lợi nhuận', 'Chi phí quảng cáo', 'Nội dung', 'Khách đang chờ', 'AI đang chạy', 'Hạn mức API',
  'Chi phí AI', 'VPS', 'GPU', 'Cảnh báo', 'Việc chờ duyệt', 'Đơn hàng', 'Kênh đã kết nối',
];
