import type { Metadata, Viewport } from 'next';

import { AuthProvider } from '@/components/auth/AuthProvider';

import './globals.css';
import './control-plane.css';

export const metadata: Metadata = {
  title: 'Wireup — prompt to validated hardware project',
  description:
    'Wireup turns a hardware idea into a real BOM, pin map, wiring graph, firmware, and hosted dashboard — with accounts, plans, and ownership built in.',
  applicationName: 'Wireup',
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
