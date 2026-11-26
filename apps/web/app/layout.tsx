import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MARIS Command Center',
  description: 'MARIS Global AI Business OS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" data-theme="dark" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
